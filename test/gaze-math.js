// Unit tests for the maths in gaze.js (ridge regression, One Euro filter, feature extraction).  Run: node test/gaze-math.js
const vm = require('vm');
const fs = require('fs');
const src = fs.readFileSync('/home/user/zhuyin-eye/gaze.js', 'utf8');

const sandbox = {
  document: { baseURI: 'http://x/', addEventListener() {} },   // gaze.js calls document.addEventListener at load time
  innerWidth: 1133, innerHeight: 744,
  navigator: { userAgent: 'node', platform: '', maxTouchPoints: 0 },
  URL, console, performance, setTimeout, clearTimeout, requestAnimationFrame: () => 0,
  fetch: () => Promise.reject(new Error('no net')),
  // no localStorage on purpose: gaze.js must survive without it
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'gaze.js' });
const G = sandbox.GazeCam;
if (!G || !G._test) { console.error('FAIL: window.GazeCam._test missing'); process.exit(1); }
const { OneEuro, fit, predict, features, solve, robust } = G._test;

// deterministic RNG
let seed = 12345;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const uni = (a, b) => a + (b - a) * rnd();
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const std = a => { const m = mean(a); return Math.sqrt(mean(a.map(v => (v - m) ** 2))); };

let fails = 0;
const report = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail || ''}`); if (!ok) fails++; };

// ---------- 1. ridge regression fit/predict (eyes mode) ----------
const feat = () => ({
  hx: uni(-0.08, 0.08), vy: uni(-0.06, 0.06), open: uni(0.2, 0.4), bh: uni(-0.1, 0.1), bv: uni(-0.1, 0.1),
  yaw: uni(-0.15, 0.15), pitch: uni(-0.1, 0.1), roll: uni(-0.05, 0.05), nx: 0.5 + uni(-0.05, 0.05), ny: 0.5 + uni(-0.05, 0.05), scale: 0.3 + uni(-0.03, 0.03),
});
const target = (f, noise, kind) => kind === 'head'
  ? [0.5 + 3 * f.yaw + 0.2 * f.nx, 0.5 + 4 * f.pitch + 0.2 * f.ny].map(v => v + noise * gauss())
  : [0.5 + 3 * f.hx + 0.5 * f.yaw + noise * gauss(), 0.5 + 4 * f.vy + noise * gauss()];

function trial(kind, noise, nTrain = 300, nTest = 50) {
  const train = Array.from({ length: nTrain }, () => { const f = feat(); const [x, y] = target(f, noise, kind); return { f, x, y, w: 1 }; });
  const m = fit(train, kind);
  let ex = 0, ey = 0;
  const test = Array.from({ length: nTest }, () => { const f = feat(); const [x, y] = target(f, 0, kind); return { f, x, y }; });
  for (const s of test) { const [px, py] = predict(m, s.f); ex += Math.abs(px - s.x); ey += Math.abs(py - s.y); }
  return { ex: ex / nTest, ey: ey / nTest, m };
}
{
  const maes = [];
  for (let k = 0; k < 20; k++) { const r = trial('eyes', 0.005); maes.push((r.ex + r.ey) / 2); }
  const r0 = trial('eyes', 0.005);
  report('fit/predict eyes: MAE on 50 held-out samples (first run)', (r0.ex + r0.ey) / 2 < 0.02, `x=${r0.ex.toFixed(4)} y=${r0.ey.toFixed(4)} mean=${((r0.ex + r0.ey) / 2).toFixed(4)} (limit 0.02)`);
  report('fit/predict eyes: 20 random trials all < 0.02', Math.max(...maes) < 0.02, `mean MAE=${mean(maes).toFixed(4)} worst=${Math.max(...maes).toFixed(4)}`);
  const rz = trial('eyes', 0);
  console.log(`      noise-free reference: x=${rz.ex.toFixed(4)} y=${rz.ey.toFixed(4)}  (non-zero => bias from ridge shrinkage, RIDGE=0.03*W)`);
  const rh = trial('head', 0.005);
  report('fit/predict head mode MAE', (rh.ex + rh.ey) / 2 < 0.02, `x=${rh.ex.toFixed(4)} y=${rh.ey.toFixed(4)}`);
  // calibration-like: only 9 distinct targets, ~25 frames each, noisy features
  const pts = [[.5, .5], [.1, .1], [.5, .1], [.9, .1], [.9, .5], [.9, .9], [.5, .9], [.1, .9], [.1, .5]];
  const cal = [];
  for (const [tx, ty] of pts) for (let i = 0; i < 25; i++) { const f = feat(); f.hx = (tx - 0.5) / 3 + 0.004 * gauss(); f.vy = (ty - 0.5) / 4 + 0.004 * gauss(); f.yaw = 0.01 * gauss(); cal.push({ f, x: tx, y: ty, w: 1 }); }
  const mc = fit(cal, 'eyes');
  let e = 0; const nt = 200;
  for (let i = 0; i < nt; i++) { const f = feat(); f.hx = uni(-0.13, 0.13); f.vy = uni(-0.1, 0.1); f.yaw = 0; const [px, py] = predict(mc, f); e += (Math.abs(px - (0.5 + 3 * f.hx)) + Math.abs(py - (0.5 + 4 * f.vy))) / 2; }
  report('9-point-calibration style fit generalises (interpolation MAE < 0.03)', e / nt < 0.03, `MAE=${(e / nt).toFixed(4)}`);
  // weights: a sample with w=4 should pull the fit more than w=1
  const base = Array.from({ length: 60 }, () => { const f = feat(); const [x, y] = target(f, 0, 'eyes'); return { f, x, y, w: 1 }; });
  const fx = feat(); const odd = { f: fx, x: 0.9, y: 0.9, w: 1 };
  const p1 = predict(fit([...base, odd], 'eyes'), fx), p4 = predict(fit([...base, { ...odd, w: 4 }], 'eyes'), fx);
  report('sample weight pulls fit towards the weighted sample', Math.abs(p4[0] - 0.9) < Math.abs(p1[0] - 0.9), `|err| w=1: ${Math.abs(p1[0] - 0.9).toFixed(3)}  w=4: ${Math.abs(p4[0] - 0.9).toFixed(3)}`);
}

// ---------- 2. linear solver ----------
{
  const A = [[4, 1, 0], [1, 3, 1], [0, 1, 2]], b = [1, 2, 3], x = solve(A, b);
  const resid = A.map((r, i) => r.reduce((s, v, j) => s + v * x[j], 0) - b[i]);
  report('solve(): residual of a 3x3 system', Math.max(...resid.map(Math.abs)) < 1e-9, `max residual ${Math.max(...resid.map(Math.abs)).toExponential(2)}`);
}

// ---------- 3. One Euro filter ----------
{
  const run = (min, beta, sigma, level = 500, n = 600) => {
    const f = new OneEuro(min, beta), ins = [], outs = [];
    for (let i = 0; i < n; i++) { const v = level + sigma * gauss(); const o = f.filter(v, i / 30); ins.push(v); outs.push(o); }
    return { sin: std(ins), sout: std(outs.slice(60)), bias: mean(outs.slice(60)) - level };
  };
  const presets = [{ min: 1.2, beta: 0.006 }, { min: 0.6, beta: 0.004 }, { min: 0.3, beta: 0.002 }]; // copied from gaze.js SMOOTH
  for (const [i, p] of presets.entries()) {
    {
      const r = run(p.min, p.beta, 20);
      report(`OneEuro preset ${i} noisy constant, sigma=20 px (units app.js feeds it)`, r.sout < r.sin * 0.5, `std in=${r.sin.toFixed(2)} out=${r.sout.toFixed(2)} (x${(r.sout / r.sin).toFixed(2)}) bias=${r.bias.toFixed(2)}`);
      const q = run(p.min, p.beta, 60);
      console.log(`INFO  OneEuro preset ${i} strong jitter sigma=60 px: std in=${q.sin.toFixed(2)} out=${q.sout.toFixed(2)} (x${(q.sout / q.sin).toFixed(2)})  [speed term beta*|dx| lets big jitter through; informational]`);
    }
    const r = run(p.min, p.beta, 0.02, 0.5);
    report(`OneEuro preset ${i} noisy constant, sigma=0.02 normalised units`, r.sout < r.sin * 0.5, `std in=${r.sin.toFixed(4)} out=${r.sout.toFixed(4)} (x${(r.sout / r.sin).toFixed(2)})`);
  }
  // step response: time (s) to reach 90% of a 400 px step with sigma=20 noise
  for (const [i, p] of presets.entries()) {
    const f = new OneEuro(p.min, p.beta); let t90 = null;
    for (let k = 0; k < 150; k++) f.filter(300 + 20 * gauss(), k / 30);
    for (let k = 0; k < 300; k++) { const o = f.filter(700 + 20 * gauss(), (150 + k) / 30); if (t90 === null && o >= 300 + 0.9 * 400) t90 = k / 30; }
    console.log(`      preset ${i} step response (400 px jump, 20 px noise): 90% after ${t90 === null ? '>10 s' : t90.toFixed(2) + ' s'}`);
  }
  const f0 = new OneEuro(1, 0); report('OneEuro: first sample passes through', f0.filter(5, 0) === 5, '');
  const f1 = new OneEuro(1, 0); f1.filter(0, 0); f1.filter(0, 1 / 30); let o = 0; for (let k = 2; k < 300; k++) o = f1.filter(10, k / 30);
  report('OneEuro: converges to a new constant level', Math.abs(o - 10) < 0.05, `final ${o.toFixed(3)}`);
}

// ---------- 4. features(): sign conventions ----------
{
  const mk = () => {
    const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5 }));
    const set = (i, x, y) => { lm[i] = { x, y }; };
    // subject's right eye (image left): outer 33 -> inner 133 ; left eye (image right): inner 362 -> outer 263 ; both axes point to image +x
    set(33, 0.30, 0.40); set(133, 0.40, 0.40); set(159, 0.35, 0.385); set(145, 0.35, 0.415); set(468, 0.35, 0.40);
    set(362, 0.60, 0.40); set(263, 0.70, 0.40); set(386, 0.65, 0.385); set(374, 0.65, 0.415); set(473, 0.65, 0.40);
    set(1, 0.5, 0.5);
    return lm;
  };
  const base = features(mk(), {}, null, 1);
  report('features(): centred irises give hx=vy=0', Math.abs(base.hx) < 1e-9 && Math.abs(base.vy) < 1e-9, `hx=${base.hx} vy=${base.vy}`);
  const dxs = {};
  for (const [name, idx] of [['right eye', 468], ['left eye', 473]]) {
    const lm = mk(); lm[idx] = { x: lm[idx].x + 0.01, y: lm[idx].y }; dxs[name] = features(lm, {}, null, 1).hx;
  }
  report('features(): moving either iris image-right raises hx (same sign on both eyes)', dxs['right eye'] > 0 && dxs['left eye'] > 0, `right-eye shift hx=${dxs['right eye'].toFixed(4)}, left-eye shift hx=${dxs['left eye'].toFixed(4)}`);
  const dys = {};
  for (const [name, idx] of [['right eye', 468], ['left eye', 473]]) {
    const lm = mk(); lm[idx] = { x: lm[idx].x, y: lm[idx].y + 0.01 }; dys[name] = features(lm, {}, null, 1).vy;
  }
  report('features(): moving either iris down raises vy (same sign on both eyes)', dys['right eye'] > 0 && dys['left eye'] > 0, `right ${dys['right eye'].toFixed(4)}, left ${dys['left eye'].toFixed(4)}`);
  // symmetric: moving both irises by the same amount gives twice a single-eye shift averaged
  const lm2 = mk(); lm2[468].x += 0.01; lm2[473].x += 0.01;
  report('features(): hx is the average of the two eyes (both shifted = 2 x one shifted)', Math.abs(features(lm2, {}, null, 1).hx - 2 * dxs['right eye']) < 1e-6, `both=${features(lm2, {}, null, 1).hx.toFixed(5)} single=${dxs['right eye'].toFixed(5)}`);
  const lmB = mk(); lmB[159].y -= 0.02; lmB[386].y -= 0.02;
  report('features(): eyelid opening grows when upper lids rise', features(lmB, {}, null, 1).open > base.open, `open ${base.open.toFixed(3)} -> ${features(lmB, {}, null, 1).open.toFixed(3)}`);
  // rotation invariance: a head roll of 20 degrees should barely change hx/vy
  const rot = (lm, a) => lm.map(p => ({ x: 0.5 + (p.x - 0.5) * Math.cos(a) - (p.y - 0.5) * Math.sin(a), y: 0.5 + (p.x - 0.5) * Math.sin(a) + (p.y - 0.5) * Math.cos(a) }));
  const lmS = mk(); lmS[468].x += 0.01; lmS[473].x += 0.01;
  const f0 = features(lmS, {}, null, 1), f20 = features(rot(lmS, 20 * Math.PI / 180), {}, null, 1);
  report('features(): hx/vy invariant to in-plane head roll (20 deg)', Math.abs(f0.hx - f20.hx) < 0.01 && Math.abs(f0.vy - f20.vy) < 0.01, `hx ${f0.hx.toFixed(4)} -> ${f20.hx.toFixed(4)}, vy ${f0.vy.toFixed(4)} -> ${f20.vy.toFixed(4)}`);
  // blendshape-driven bh/bv sign
  const fb = features(mk(), { eyeLookOutLeft: 0.4, eyeLookInRight: 0.4 }, null, 1);
  report('features(): bh>0 for blendshapes eyeLookOutLeft+eyeLookInRight (look toward image-right, same sign as hx)', fb.bh > 0, `bh=${fb.bh}`);
}

// ---------- 5. robust() outlier rejection ----------
{
  const list = Array.from({ length: 40 }, () => ({ hx: 0.01 + 0.001 * gauss(), vy: 0.02 + 0.001 * gauss() }));
  list.push({ hx: 0.2, vy: 0.02 }, { hx: 0.01, vy: -0.2 });
  const kept = robust(list, 'eyes');
  report('robust(): drops 2 gross outliers, keeps most inliers', kept.length >= 33 && kept.length <= 40 && !kept.some(f => f.hx === 0.2 || f.vy === -0.2), `kept ${kept.length}/42`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall gaze-math checks passed');
process.exit(fails ? 1 : 0);
