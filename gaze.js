/* 眼睛注音板 — 相機眼控：MediaPipe Face Landmarker 找出眼睛和頭的位置，再用個人校正把它換算成畫面座標 */
(() => {
'use strict';
const MP_VER = '0.10.35';
const LOCAL = new URL('vendor/mediapipe/', document.baseURI).href;
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}/`;
const REMOTE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const STORE = 'zhuyin-eye:calib:v1';
const FIELDS = ['hx', 'vy', 'open', 'bh', 'bv', 'yaw', 'pitch', 'roll', 'nx', 'ny', 'scale'];
const SMOOTH = [{ min: 1.2, beta: 0.006 }, { min: 0.6, beta: 0.004 }, { min: 0.3, beta: 0.002 }];
const RIDGE = 0.03;   // 正則化強度（相對於樣本數）
const IMPLICIT_W = 4; // 每次用眼睛選取後，自動加進校正的權重
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const orient = () => innerWidth > innerHeight ? 'land' : 'port';

// ---------- 平滑：One Euro filter ----------
class OneEuro {
  constructor(min, beta, dCut = 1) { this.min = min; this.beta = beta; this.dCut = dCut; this.reset(); }
  reset() { this.x = null; this.dx = 0; this.t = 0; }
  static a(cut, dt) { const tau = 1 / (2 * Math.PI * cut); return 1 / (1 + tau / dt); }
  filter(x, t) {
    if (this.x === null) { this.x = x; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    this.dx += OneEuro.a(this.dCut, dt) * ((x - this.x) / dt - this.dx);
    this.x += OneEuro.a(this.min + this.beta * Math.abs(this.dx), dt) * (x - this.x);
    return this.x;
  }
}

// ---------- 特徵 ----------
function features(lm, bs, m, aspect) {
  const P = i => [lm[i].x * aspect, lm[i].y];
  // 兩眼的軸都朝同一個方向（從受試者右往左），水平特徵才能直接平均
  const eye = (a, b, iris, up, lo) => {
    const A = P(a), B = P(b), C = P(iris), U = P(up), D = P(lo);
    let ux = B[0] - A[0], uy = B[1] - A[1];
    const w = Math.hypot(ux, uy) || 1e-6; ux /= w; uy /= w;
    const dx = C[0] - (A[0] + B[0]) / 2, dy = C[1] - (A[1] + B[1]) / 2;
    return { al: (dx * ux + dy * uy) / w, pe: (-dx * uy + dy * ux) / w, op: Math.hypot(U[0] - D[0], U[1] - D[1]) / w };
  };
  const R = eye(33, 133, 468, 159, 145), L = eye(362, 263, 473, 386, 374);
  const s = k => bs[k] || 0;
  let yaw = 0, pitch = 0, roll = 0;
  if (m) { yaw = Math.atan2(m[8], m[10]); pitch = Math.atan2(-m[9], Math.hypot(m[8], m[10])); roll = Math.atan2(m[1], m[0]); }
  const nose = P(1), e1 = P(33), e2 = P(263);
  return {
    hx: (R.al + L.al) / 2, vy: (R.pe + L.pe) / 2, open: (R.op + L.op) / 2,
    bh: (s('eyeLookOutLeft') + s('eyeLookInRight') - s('eyeLookInLeft') - s('eyeLookOutRight')) / 2,
    bv: (s('eyeLookUpLeft') + s('eyeLookUpRight') - s('eyeLookDownLeft') - s('eyeLookDownRight')) / 2,
    yaw, pitch, roll, nx: nose[0], ny: nose[1], scale: Math.hypot(e1[0] - e2[0], e1[1] - e2[1]),
  };
}
function vec(f, mode) {
  if (mode === 'head') return [f.yaw, f.pitch, f.roll, f.nx, f.ny, f.scale, f.yaw * f.yaw, f.pitch * f.pitch, f.yaw * f.pitch];
  return [f.hx, f.vy, f.open, f.bh, f.bv, f.yaw, f.pitch, f.nx, f.ny, f.scale, f.hx * f.hx, f.vy * f.vy, f.hx * f.vy];
}

// ---------- 加權脊迴歸 ----------
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const k = M[r][c] / d;
      if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-9));
}
function fit(samples, mode) {
  const V = samples.map(s => vec(s.f, mode)), d = V[0].length;
  let W = 0, cx = 0, cy = 0;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  samples.forEach((s, i) => { W += s.w; cx += s.w * s.x; cy += s.w * s.y; V[i].forEach((a, j) => { mean[j] += s.w * a; }); });
  cx /= W; cy /= W;
  for (let j = 0; j < d; j++) mean[j] /= W;
  samples.forEach((s, i) => V[i].forEach((a, j) => { std[j] += s.w * (a - mean[j]) ** 2; }));
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / W) || 1;
  const A = Array.from({ length: d }, () => new Array(d).fill(0)), bx = new Array(d).fill(0), by = new Array(d).fill(0);
  samples.forEach((s, i) => {
    const z = V[i].map((a, j) => (a - mean[j]) / std[j]);
    for (let a = 0; a < d; a++) {
      bx[a] += s.w * z[a] * (s.x - cx); by[a] += s.w * z[a] * (s.y - cy);
      for (let b = a; b < d; b++) A[a][b] += s.w * z[a] * z[b];
    }
  });
  for (let a = 0; a < d; a++) { for (let b = 0; b < a; b++) A[a][b] = A[b][a]; A[a][a] += RIDGE * W; }
  return { mode, mean, std, cx, cy, wx: solve(A, bx), wy: solve(A, by) };
}
function predict(m, f) {
  let x = m.cx, y = m.cy;
  vec(f, m.mode).forEach((a, j) => { const z = (a - m.mean[j]) / m.std[j]; x += m.wx[j] * z; y += m.wy[j] * z; });
  return [x, y];
}
const median = a => { const s = [...a].sort((p, q) => p - q); return s.length ? s[s.length >> 1] : 0; };
function robust(list, mode) { // 去掉一個校正點裡偏離太多的影格（分心、眨眼前後）
  const [ka, kb] = mode === 'head' ? ['yaw', 'pitch'] : ['hx', 'vy'];
  const ma = median(list.map(f => f[ka])), mb = median(list.map(f => f[kb]));
  const da = median(list.map(f => Math.abs(f[ka] - ma))) || 1e-4, db = median(list.map(f => Math.abs(f[kb] - mb))) || 1e-4;
  return list.filter(f => Math.abs(f[ka] - ma) <= 3 * da + 1e-4 && Math.abs(f[kb] - mb) <= 3 * db + 1e-4);
}
const avgF = list => Object.fromEntries(FIELDS.map(k => [k, list.reduce((s, f) => s + f[k], 0) / list.length]));
const pack = f => FIELDS.map(k => +f[k].toFixed(5));
const unpack = a => Object.fromEntries(FIELDS.map((k, i) => [k, a[i]]));

// ---------- 狀態 ----------
let landmarker = null, video = null, stream = null, running = false, lastVideoTime = -1;
let onPoint = () => { }, onStatus = () => { };
let mode = 'eyes', model = null, calibSamples = [], implicit = [], pending = null, sinceFit = 0;
let collecting = null, preview = null, faceSeen = 0, faceLost = true, lastLm = null;
let fx = new OneEuro(0.6, 0.004), fy = new OneEuro(0.6, 0.004);
const recent = [];

function loadStore() { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } }
function saveStore() {
  const all = loadStore();
  all[orient() + ':' + mode] = { samples: calibSamples.map(s => [s.x, s.y, ...pack(s.f)]), at: Date.now() };
  try { localStorage.setItem(STORE, JSON.stringify(all)); } catch { }
}
function restore() {
  const rec = loadStore()[orient() + ':' + mode];
  calibSamples = rec ? rec.samples.map(a => ({ x: a[0], y: a[1], f: unpack(a.slice(2)), w: 1 })) : [];
  implicit = []; pending = null;
  refit();
}
function refit() {
  sinceFit = 0;
  if (calibSamples.length < 20) { model = null; return; }
  model = fit([...calibSamples, ...implicit], mode);
  model.orient = orient();
  fx.reset(); fy.reset();
}

// ---------- 相機與模型 ----------
const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function loadLandmarker() {
  if (landmarker) return landmarker;
  // 自架版本身就帶著模型（離線也能用）；找不到才改從網路上的 CDN 載入
  let vision, wasm, modelPath;
  try { vision = await import(LOCAL + 'vision_bundle.mjs'); wasm = LOCAL + 'wasm'; modelPath = LOCAL + 'face_landmarker.task'; }
  catch { vision = await import(CDN + 'vision_bundle.mjs'); wasm = CDN + 'wasm'; modelPath = REMOTE_MODEL; }
  const files = await vision.FilesetResolver.forVisionTasks(wasm);
  const opts = delegate => ({
    baseOptions: { modelAssetPath: modelPath, delegate }, runningMode: 'VIDEO', numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
  });
  // iPad Safari 的 GPU 模式有輸出錯亂的回報，Apple 裝置一律用 CPU（A17 Pro 夠快）
  const order = isApple() ? ['CPU'] : ['GPU', 'CPU'];
  let lastErr;
  for (const d of order) {
    try { landmarker = await vision.FaceLandmarker.createFromOptions(files, opts(d)); return landmarker; } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('model');
}
function camError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return '相機被擋住了：如果是在 Claude 的預覽頁面，這裡不能開相機。請改用「觸控／iPad 內建眼動追蹤」，或把程式放到自己的 https 網址（見說明）。若是自己的網址，請到 iPad「設定 › Safari › 相機」允許。';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return '找不到前鏡頭。';
  if (n === 'NotReadableError') return '相機正在被別的 App 使用，請先關掉它。';
  return '相機開不起來：' + (e && e.message || n || '未知原因');
}
async function start(opts = {}) {
  onPoint = opts.onPoint || onPoint; onStatus = opts.onStatus || onStatus;
  if (opts.mode) mode = opts.mode;
  if (opts.smooth != null) setSmooth(opts.smooth);
  if (running) return;
  if (!window.isSecureContext) throw new Error('相機只能在 https 網址使用。');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('這個瀏覽器不能使用相機。');
  onStatus({ state: 'loading', msg: '正在打開相機…' });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (e) { throw new Error(camError(e)); }
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', ''); video.muted = true; video.autoplay = true;
    video.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
    document.body.appendChild(video);
  }
  video.srcObject = stream;
  try { await video.play(); } catch { }
  onStatus({ state: 'loading', msg: '正在載入眼控模型（第一次比較久）…' });
  try { await loadLandmarker(); } catch (e) { stop(); throw new Error('眼控模型載入失敗，請確認網路後再試一次。'); }
  restore();
  running = true; faceLost = true; lastVideoTime = -1;
  requestAnimationFrame(loop);
}
function stop() {
  running = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  if (video) video.srcObject = null;
  onPoint(null);
}
document.addEventListener('visibilitychange', () => { if (running && document.visibilityState === 'visible' && video?.paused) video.play().catch(() => { }); });

function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  if (!video || video.readyState < 2 || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  let res;
  try { res = landmarker.detectForVideo(video, performance.now()); } catch { return; }
  frame(res);
}
function frame(res) {
  const now = performance.now();
  const lm = res.faceLandmarks && res.faceLandmarks[0];
  lastLm = lm || null;
  drawPreview();
  if (!lm) {
    if (!faceLost && now - faceSeen > 500) { faceLost = true; onStatus({ state: 'noface' }); }
    onPoint(null);
    return;
  }
  faceSeen = now;
  if (faceLost) { faceLost = false; onStatus({ state: 'face' }); }
  const bs = {};
  (res.faceBlendshapes && res.faceBlendshapes[0] ? res.faceBlendshapes[0].categories : []).forEach(c => { bs[c.categoryName] = c.score; });
  const m = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0] ? res.facialTransformationMatrixes[0].data : null;
  const f = features(lm, bs, m, (video.videoWidth || 4) / (video.videoHeight || 3));
  if (mode === 'eyes' && ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2 > 0.5) { onPoint(null); return; } // 眨眼
  recent.push({ t: now, f });
  while (recent.length && now - recent[0].t > 700) recent.shift();
  if (collecting) collecting.push(f);
  if (!model) return;
  const [nx, ny] = predict(model, f);
  const W = innerWidth, H = innerHeight;
  onPoint(clamp(fx.filter(nx * W, now / 1000), 0, W), clamp(fy.filter(ny * H, now / 1000), 0, H));
}
function drawPreview() {
  if (!preview || !video || !video.videoWidth) return;
  const c = preview, g = c.getContext('2d');
  c.width = 320; c.height = 240;
  g.save(); g.translate(c.width, 0); g.scale(-1, 1); // 像照鏡子
  g.drawImage(video, 0, 0, c.width, c.height);
  if (lastLm) {
    g.fillStyle = '#5DE0A0';
    for (const i of [468, 473]) { g.beginPath(); g.arc(lastLm[i].x * c.width, lastLm[i].y * c.height, 4, 0, 7); g.fill(); }
  }
  g.restore();
}

// ---------- 自動微調：用眼睛選到格子時，格子中心就是孩子當時看的地方 ----------
function noteTarget(x, y) {
  const now = performance.now(), list = recent.filter(r => now - r.t < 600).map(r => r.f);
  pending = model && list.length >= 4 ? { f: avgF(list), x, y, w: IMPLICIT_W } : null;
}
function commitPending() {
  if (!pending) return;
  implicit.push(pending); pending = null;
  if (implicit.length > 30) implicit.shift();
  if (++sinceFit >= 3) refit();
}
const discardPending = () => { pending = null; }; // 選完馬上按「退回」＝選錯了，不拿來學

// ---------- 校正畫面 ----------
function chime() {
  try {
    const ctx = chime.ctx = chime.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.32);
  } catch { }
}
function card(root, html) {
  root.querySelector('.calib-card')?.remove();
  const el = document.createElement('div');
  el.className = 'calib-card'; el.innerHTML = html;
  root.appendChild(el);
  return el;
}
function waitButtons(el) {
  return new Promise(res => el.querySelectorAll('button[data-a]').forEach(b => b.addEventListener('click', () => res(b.dataset.a))));
}
async function calibrate({ points = 9, sound = false } = {}) {
  if (!running) throw new Error('相機還沒開啟。');
  const root = document.createElement('div');
  root.className = 'calib';
  document.body.appendChild(root);
  const head = mode === 'head';
  try {
    for (;;) {
      const intro = card(root, `
        <h2>先讓 iPad 認識你的眼睛</h2>
        <canvas width="320" height="240" aria-label="鏡頭畫面"></canvas>
        <p>${head ? '轉動頭，讓鼻子對著黃色小圓點。' : '頭不要動，只用眼睛跟著黃色小圓點看。'}<br>臉放在鏡頭畫面中間，看得到兩個綠點就可以開始。</p>
        <div class="actions"><button class="btn primary" type="button" data-a="go">開始校正</button><button class="btn" type="button" data-a="skip">先不要</button></div>`);
      preview = intro.querySelector('canvas');
      const a = await waitButtons(intro);
      preview = null;
      if (a === 'skip') return { ok: !!model };
      intro.remove();

      const pts = points === 5
        ? [[.5, .5], [.1, .12], [.9, .12], [.9, .88], [.1, .88]]
        : [[.5, .5], [.1, .1], [.5, .1], [.9, .1], [.9, .5], [.9, .9], [.5, .9], [.1, .9], [.1, .5]];
      const dot = document.createElement('div');
      dot.className = 'calib-dot'; dot.innerHTML = '<i></i><b></b>';
      dot.style.left = '50%'; dot.style.top = '50%';
      root.appendChild(dot);
      await sleep(900);
      const samples = [], perPoint = [];
      for (const [tx, ty] of pts) {
        dot.classList.remove('shrink');
        dot.style.left = tx * 100 + '%'; dot.style.top = ty * 100 + '%';
        await sleep(750);
        if (sound) chime();
        dot.style.setProperty('--t', '1.3s');
        dot.classList.add('shrink');
        await sleep(350);           // 眼睛先到位
        collecting = [];
        await sleep(950);
        const got = robust(collecting, mode); collecting = null;
        perPoint.push({ tx, ty, list: got });
        got.forEach(f => samples.push({ f, x: tx, y: ty, w: 1 }));
      }
      dot.remove();
      const missing = perPoint.filter(p => p.list.length < 5).length;
      let quality = 'bad', err = 1;
      if (missing <= 1 && samples.length >= 20) {
        calibSamples = samples; implicit = []; pending = null;
        refit();
        // 每個點的預測中位數和目標的距離（以畫面對角線比例計）
        const W = innerWidth, H = innerHeight, D = Math.hypot(W, H);
        const errs = perPoint.filter(p => p.list.length).map(p => {
          const pr = p.list.map(f => predict(model, f));
          return Math.hypot((median(pr.map(q => q[0])) - p.tx) * W, (median(pr.map(q => q[1])) - p.ty) * H) / D;
        });
        err = errs.reduce((s, e) => s + e, 0) / errs.length;
        quality = err < 0.05 ? 'good' : err < 0.1 ? 'ok' : 'bad';
        saveStore();
      }
      const text = { good: '很準！可以開始打字了', ok: '可以用，如果常選錯可以再校正一次', bad: missing > 1 ? '有些點沒看清楚臉，請調整 iPad 位置或光線再試一次' : '不太準，建議再校正一次' }[quality];
      const res = card(root, `
        <h2>校正完成</h2>
        <span class="quality ${quality}">${text}</span>
        <p>${model ? `平均誤差約畫面的 ${Math.round(err * 100)}%。` : ''}光線從正面來、iPad 不要晃，會更準。</p>
        <div class="actions"><button class="btn primary" type="button" data-a="done"${model ? '' : ' disabled'}>開始打字</button><button class="btn" type="button" data-a="again">再校正一次</button></div>`);
      const b = await waitButtons(res);
      if (b === 'done') return { ok: true, quality, err };
    }
  } finally {
    collecting = null; preview = null;
    root.remove();
  }
}

function setMode(m) { if (m === mode) return; mode = m; if (running) restore(); }
function setSmooth(i) { const p = SMOOTH[clamp(+i || 0, 0, 2)]; fx = new OneEuro(p.min, p.beta); fy = new OneEuro(p.min, p.beta); }

window.GazeCam = {
  start, stop, calibrate, setMode, setSmooth, noteTarget, commitPending, discardPending,
  isRunning: () => running,
  isCalibrated: () => !!model && model.orient === orient() && model.mode === mode,
  _test: { OneEuro, features, vec, fit, predict, robust, solve },
};
})();
