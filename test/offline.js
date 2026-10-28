// Offline / service-worker verification for the Zhuyin eye-gaze board.
// Run: node test/offline.js    (starts and kills its own python http.server on :8766; log -> test/offline.log, JSON -> test/offline-results.json)
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8766;
const BASE = `http://localhost:${PORT}/`;
const DIST = '/home/user/zhuyin-eye/docs';
const OUT = __dirname;
const LOG = path.join(OUT, 'offline.log');
fs.writeFileSync(LOG, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => { const s = a.join(' '); console.log(s); fs.appendFileSync(LOG, s + '\n'); };

// ---------- server control ----------
let server = null;
function ping() {
  return new Promise(res => { const r = http.get(BASE, x => { x.resume(); res(true); }); r.on('error', () => res(false)); r.setTimeout(1000, () => { r.destroy(); res(false); }); });
}
async function startServer() {
  if (await ping()) throw new Error(`port ${PORT} already serving something`);
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--directory', DIST], { detached: true, stdio: ['ignore', fs.openSync(path.join(OUT, 'offline-server.log'), 'a'), fs.openSync(path.join(OUT, 'offline-server.log'), 'a')] });
  for (let i = 0; i < 50; i++) { if (await ping()) return; await sleep(100); }
  throw new Error('server did not come up');
}
async function stopServer() {
  if (!server) return;
  try { process.kill(-server.pid, 'SIGKILL'); } catch (e) { try { server.kill('SIGKILL'); } catch (_) { } }
  server = null;
  for (let i = 0; i < 50; i++) { if (!(await ping())) return; await sleep(100); }
  throw new Error('server still answering after kill');
}

// ---------- error collection ----------
const errors = [];
let step = 'init';
function hook(page, tag) {
  page.on('console', m => { if (m.type() === 'error') errors.push({ step, tag, kind: 'console.error', text: m.text(), url: m.location().url }); });
  page.on('pageerror', e => errors.push({ step, tag, kind: 'pageerror', text: e.message }));
  page.on('requestfailed', r => errors.push({ step, tag, kind: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure() && r.failure().errorText}` }));
  page.on('response', r => { if (r.status() >= 400) errors.push({ step, tag, kind: 'http' + r.status(), text: r.url() }); });
}
const isXnnpack = e => /Created TensorFlow Lite XNNPACK delegate/i.test(e.text);

// ---------- tiny harness ----------
const R = {};
async function check(n, name, fn) {
  step = 'step' + n;
  const notes = [], fails = [];
  const t = {
    eq(a, b, label) { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails.push(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); return ok; },
    ok(c, label) { if (!c) fails.push(label); return !!c; },
    note(s) { notes.push(s); },
    fail(s) { fails.push(s); },
  };
  try { await fn(t); } catch (e) { fails.push('EXCEPTION: ' + String(e.stack || e.message).split('\n').slice(0, 3).join(' | ')); }
  R[n] = { name, pass: fails.length === 0, fails, notes };
  log(`[${R[n].pass ? 'PASS' : 'FAIL'}] step ${n}. ${name}`);
  fails.forEach(f => log('    FAIL: ' + f));
  notes.forEach(f => log('    note: ' + f));
}

const S = page => page.evaluate(() => JSON.parse(JSON.stringify((({ view, group, comp, text }) => ({ view, group, comp, text }))(ZhuyinBoard.state))));
async function tapTile(page, i) { await page.click(`#board button[data-i="${i}"]`, { timeout: 3000 }); await sleep(380); }
const bigText = (page, i) => page.locator(`#board button[data-i="${i}"] .big`).first().innerText();

// sw.js lists, parsed straight from the file
const swSrc = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
const CORE_FILES = JSON.parse(swSrc.match(/const CORE_FILES = (\[.*?\]);/)[1]);
const MODEL_FILES = JSON.parse(swSrc.match(/const MODEL_FILES = (\[.*?\]);/)[1]);
const ALL_FILES = [...CORE_FILES, ...MODEL_FILES];

const missingFromCache = (page) => page.evaluate(async files => {
  const miss = [];
  for (const f of files) { const m = await caches.match(new URL(f, location.href).href, { ignoreSearch: true }); if (!m) miss.push(f); }
  return miss;
}, ALL_FILES);

const cacheReport = page => page.evaluate(async () => {
  const out = { caches: {}, total: 0 };
  for (const k of await caches.keys()) {
    const c = await caches.open(k); let sum = 0; const items = [];
    for (const req of await c.keys()) { const res = await c.match(req); const b = await res.blob(); sum += b.size; items.push(`${new URL(req.url).pathname} ${b.size}`); }
    out.caches[k] = { entries: items.length, bytes: sum, items }; out.total += sum;
  }
  return out;
});

const settle = async (page) => { await page.waitForLoadState('load'); await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => { }); };

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  let ctx = null, ctxBlocked = null;
  try {
    await startServer();
    log(`server started on ${PORT}; CORE_FILES=${CORE_FILES.length} MODEL_FILES=${MODEL_FILES.length}`);

    ctx = await browser.newContext({ viewport: { width: 1133, height: 744 }, permissions: ['camera'] });
    const page = await ctx.newPage();
    hook(page, 'main');
    const nonLocal = new Set();
    ctx.on('request', r => { if (!r.url().startsWith(BASE) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) nonLocal.add(r.url()); });

    // 1 --------------------------------------------------------------
    await check(1, 'online: SW installs, page controlled, all CORE+MODEL files cached, #offlineState says offline-ready', async t => {
      await page.goto(BASE, { waitUntil: 'load' });
      const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.ready; return { scope: r.scope, active: !!r.active, state: r.active && r.active.state }; });
      t.note(`sw ready: ${JSON.stringify(reg)}`);
      await page.reload({ waitUntil: 'load' });
      const ctl = await page.evaluate(() => !!navigator.serviceWorker.controller);
      t.ok(ctl, 'navigator.serviceWorker.controller is null after reload');
      const t0 = Date.now(); let miss = ALL_FILES;
      while (Date.now() - t0 < 120000) { miss = await missingFromCache(page); if (!miss.length) break; await sleep(500); }
      t.note(`cache complete after ${((Date.now() - t0) / 1000).toFixed(1)}s; missing=${JSON.stringify(miss)}`);
      t.eq(miss, [], 'files missing from caches');
      const rep = await cacheReport(page);
      for (const [k, v] of Object.entries(rep.caches)) t.note(`cache ${k}: ${v.entries} entries, ${v.bytes} bytes`);
      t.note(`TOTAL cache size: ${rep.total} bytes = ${(rep.total / 1048576).toFixed(2)} MiB`);
      R.cacheReport = rep;
      await page.click('#startSettings'); await sleep(600);
      let txt = '';
      for (let i = 0; i < 20; i++) { txt = (await page.locator('#offlineState').innerText()).trim(); if (!txt.includes('檢查中')) break; await sleep(250); }
      t.note(`#offlineState: "${txt}"`);
      t.ok(txt.includes('已可以離線使用'), `#offlineState lacks "已可以離線使用": "${txt}"`);
      await page.click('#settingsDone'); await sleep(300);
    });

    // 2 --------------------------------------------------------------
    await ctx.setOffline(true);
    await stopServer();
    log('--- OFFLINE: context.setOffline(true) + server killed (ping=' + (await ping()) + ') ---');
    await check(2, 'offline reload: start overlay, type 媽, font loaded', async t => {
      await page.reload({ waitUntil: 'load' });
      await settle(page);
      t.ok(await page.locator('#start').isVisible(), '#start overlay not visible after offline reload');
      t.ok(await page.locator('#startBtn').isVisible(), '#startBtn not visible');
      t.note('controller after offline reload: ' + await page.evaluate(() => !!navigator.serviceWorker.controller));
      await page.click('#startBtn'); await sleep(500);
      t.eq(await page.locator('#board button[data-i]').count(), 8, 'home tile count');
      await tapTile(page, 0); let s = await S(page); t.eq(s.view, 'group', 'view after tile 0');
      await tapTile(page, 2); s = await S(page); t.eq([s.view, s.comp.ini], ['mf', 'ㄇ'], 'after ㄇ');
      await tapTile(page, 4); s = await S(page); t.eq([s.view, s.group], ['fgroup', 'ㄚㄛㄜㄝ'], 'after final group');
      await tapTile(page, 0); s = await S(page); t.eq([s.view, s.comp.fin], ['tone', 'ㄚ'], 'after ㄚ');
      await tapTile(page, 0); s = await S(page); t.eq(s.view, 'cand', 'after 一聲');
      const first = await bigText(page, 0); t.eq(first, '媽', 'first candidate');
      await tapTile(page, 0); s = await S(page);
      const last = s.text[s.text.length - 1];
      t.eq(last && last.t, '媽', 'last unit t');
      const f = await page.evaluate(async () => {
        await document.fonts.ready;
        const faces = []; document.fonts.forEach(ff => faces.push({ family: ff.family, status: ff.status }));
        return { check: document.fonts.check('40px "ZhuyinBoard Round"', 'ㄅ'), faces };
      });
      t.note('fonts: ' + JSON.stringify(f));
      t.eq(f.check, true, 'document.fonts.check');
      const face = f.faces.find(x => x.family.replace(/["']/g, '') === 'ZhuyinBoard Round');
      t.ok(!!face, 'no FontFace "ZhuyinBoard Round" registered');
      t.eq(face && face.status, 'loaded', 'FontFace status');
    });

    // 3 --------------------------------------------------------------
    await check(3, 'offline: /?from=homescreen in a new page renders (ignoreSearch)', async t => {
      const p3 = await ctx.newPage(); hook(p3, 'p3');
      const resp = await p3.goto(BASE + '?from=homescreen', { waitUntil: 'load' });
      await settle(p3);
      t.note(`status=${resp && resp.status()} fromServiceWorker=${resp && resp.fromServiceWorker()} url=${p3.url()}`);
      t.ok(await p3.locator('#start').isVisible(), '#start not visible on ?from=homescreen');
      t.ok(await p3.locator('#startBtn').isVisible(), '#startBtn not visible');
      t.ok(await p3.evaluate(() => typeof window.ZhuyinBoard === 'object' && !!window.ZHUYIN_DICT), 'ZhuyinBoard / ZHUYIN_DICT not defined (app.js/dict not served)');
      await p3.close();
    });

    // 4 --------------------------------------------------------------
    await check(4, 'offline camera mode: .calib-card within 60 s (MediaPipe bundle+wasm+model from cache)', async t => {
      const swReqs = [];
      const onResp = r => { const u = r.url(); if (/vendor\//.test(u)) swReqs.push(`${new URL(u).pathname.split('/').pop()}:${r.status()}${r.fromServiceWorker() ? ':sw' : ':net'}`); };
      page.on('response', onResp);
      await page.reload({ waitUntil: 'load' }); await settle(page);
      await page.click('#startSettings'); await sleep(400);
      await page.check('#in-camera'); await page.click('#settingsDone'); await sleep(300);
      await page.click('#startBtn');
      const t0 = Date.now(), banners = []; let last = null, up = false, at = null;
      while (Date.now() - t0 < 60000) {
        const s = await page.evaluate(() => { const b = document.querySelector('#banner'); return { b: b.hidden ? '' : b.textContent, calib: !!document.querySelector('.calib .calib-card') }; });
        if (s.b !== last) { banners.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:"${s.b}"`); last = s.b; }
        if (s.calib) { up = true; at = ((Date.now() - t0) / 1000).toFixed(1); break; }
        await sleep(250);
      }
      t.note('banner timeline: ' + banners.join(' > '));
      t.note('vendor/ responses: ' + swReqs.join(', '));
      t.ok(up, 'no .calib-card within 60 s offline');
      if (up) {
        t.note(`.calib-card appeared after ${at}s`);
        t.note('GazeCam.isRunning=' + await page.evaluate(() => window.GazeCam && GazeCam.isRunning()));
        await page.click('button[data-a="skip"]'); await sleep(500);
      } else {
        t.note('final banner: "' + await page.evaluate(() => { const b = document.querySelector('#banner'); return b.hidden ? '' : b.textContent; }) + '"');
      }
      page.off('response', onResp);
      t.note('non-localhost requests seen during whole test: ' + ([...nonLocal].join(', ') || '(none)'));
    });

    // 5 --------------------------------------------------------------
    await ctx.close(); ctx = null;
    await ctx; // no-op
    await startServer();
    log('--- ONLINE again: server restarted ---');
    await check(5, 'negative: serviceWorkers blocked -> #offlineState says cannot be used offline', async t => {
      ctxBlocked = await browser.newContext({ viewport: { width: 1133, height: 744 }, serviceWorkers: 'block', permissions: ['camera'] });
      const p5 = await ctxBlocked.newPage(); hook(p5, 'blocked');
      await p5.goto(BASE, { waitUntil: 'load' }); await settle(p5);
      await p5.click('#startSettings'); await sleep(600);
      let txt = '';
      for (let i = 0; i < 20; i++) { txt = (await p5.locator('#offlineState').innerText()).trim(); if (!txt.includes('檢查中')) break; await sleep(250); }
      t.note(`#offlineState: "${txt}"`);
      t.ok(txt.includes('不能離線'), `#offlineState lacks "不能離線": "${txt}"`);
      t.note('controller=' + await p5.evaluate(() => !!navigator.serviceWorker.controller) + ', caches=' + JSON.stringify(await p5.evaluate(() => caches.keys())));
    });
  } finally {
    try { if (ctx) await ctx.close(); } catch (e) { }
    try { if (ctxBlocked) await ctxBlocked.close(); } catch (e) { }
    try { await browser.close(); } catch (e) { }
    try { await stopServer(); } catch (e) { log('stopServer: ' + e.message); }
  }

  // ---------- summary ----------
  log('\n=========== SUMMARY ===========');
  for (const k of [1, 2, 3, 4, 5]) if (R[k]) log(`${R[k].pass ? 'PASS' : 'FAIL'}  step ${k}. ${R[k].name}`); else log(`SKIP  step ${k}`);
  const uniq = new Map();
  for (const e of errors) { const k = [e.step, e.kind, e.text.slice(0, 160)].join('|'); if (!uniq.has(k)) uniq.set(k, { ...e, n: 0 }); uniq.get(k).n++; }
  log('\n--- console/page errors & failed requests (deduplicated) ---');
  let any = false;
  for (const e of uniq.values()) { any = true; log(`${isXnnpack(e) ? '[xnnpack info, ignored] ' : ''}x${e.n} ${e.step}/${e.tag} ${e.kind}: ${e.text.slice(0, 240)}`); }
  if (!any) log('(none)');
  fs.writeFileSync(path.join(OUT, 'offline-results.json'), JSON.stringify({ R, errors: [...uniq.values()] }, null, 1));
  process.exit(Object.keys(R).filter(k => /^\d$/.test(k)).every(k => R[k].pass) ? 0 : 1);
})().catch(async e => { console.error('FATAL', e); try { await stopServer(); } catch (_) { } process.exit(2); });
