// End-to-end test of the Zhuyin eye-gaze board.  Run: node test/e2e.js   (server on :8765 must be running)
const { chromium } = require('playwright');
const fs = require('fs');
const BASE = 'http://localhost:8765/';
const OUT = '/home/user/zhuyin-eye/test';
const SHOTS = OUT + '/shots';
fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- error collection ----------
const errors = [];
let where = 'init';
function hook(page, tag) {
  page.on('console', m => { if (m.type() === 'error') errors.push({ where: `${tag}/${where}`, kind: 'console.error', text: m.text(), url: m.location().url }); });
  page.on('pageerror', e => errors.push({ where: `${tag}/${where}`, kind: 'pageerror', text: e.message }));
  page.on('requestfailed', r => errors.push({ where: `${tag}/${where}`, kind: 'requestfailed', text: `${r.method()} ${r.url()} ${r.failure() && r.failure().errorText}` }));
  page.on('response', r => { if (r.status() >= 400) errors.push({ where: `${tag}/${where}`, kind: 'http' + r.status(), text: r.url() }); });
}
const isFont = e => /fonts\.(googleapis|gstatic)\.com/.test(e.text + (e.url || ''));

// ---------- tiny test harness ----------
const R = {};
async function check(n, name, fn) {
  where = 'check' + n;
  const notes = [], fails = [];
  const t = {
    eq(a, b, label) { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fails.push(`${label}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); return ok; },
    ok(c, label) { if (!c) fails.push(label); return !!c; },
    note(s) { notes.push(s); },
    fail(s) { fails.push(s); },
  };
  try { await fn(t); } catch (e) { fails.push('EXCEPTION: ' + String(e.message).split('\n')[0]); }
  R[n] = { name, pass: fails.length === 0, fails, notes };
  console.log(`[${R[n].pass ? 'PASS' : 'FAIL'}] ${n}. ${name}`);
  fails.forEach(f => console.log('    FAIL: ' + f));
  notes.forEach(f => console.log('    note: ' + f));
}

// ---------- page helpers ----------
async function newPage(browser, vp = { width: 1133, height: 744 }, opts = {}, tag = 'main') {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: opts.dsf || 2, colorScheme: opts.colorScheme || 'light', permissions: opts.permissions || [] });
  const page = await ctx.newPage();
  hook(page, tag);
  await page.goto(BASE, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  return { ctx, page };
}
const S = page => page.evaluate(() => JSON.parse(JSON.stringify((({ view, group, page, tone, comp, text }) => ({ view, group, page, tone, comp, text }))(ZhuyinBoard.state))));
const tile = (page, i) => page.locator(`#board button[data-i="${i}"]`);
async function tap(page, sel) { await page.click(sel, { timeout: 3000 }); await sleep(380); }
const tapTile = (page, i) => tap(page, `#board button[data-i="${i}"]`);
const rail = (page, n) => tap(page, `[data-rail="${n}"]`);
async function resetBoard(page, keepText = false) {
  await page.evaluate(k => { const Z = ZhuyinBoard; if (!k) Z.state.text.length = 0; Z.state.comp = { ini: '', med: '', fin: '' }; Z.state.tone = null; Z.go('home'); }, keepText);
  await sleep(120);
}
const tileInfo = page => page.evaluate(() => [...document.querySelectorAll('#board > *')].map((el, i) => el.tagName === 'BUTTON'
  ? { i: +el.dataset.i, disabled: el.disabled, text: el.innerText.replace(/\s+/g, ' ').trim(), cls: el.className, ms: [...el.querySelectorAll('.m')].map(m => ({ t: m.textContent, off: m.classList.contains('off') })) }
  : { i, div: true }));
const bigText = (page, i) => page.locator(`#board button[data-i="${i}"] .big`).first().innerText();
async function openSettings(page) {
  const g = await page.locator('#gear').boundingBox();
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down(); await sleep(1200); await page.mouse.up();
  await page.waitForSelector('#settings:not([hidden])', { timeout: 2000 });
}
async function closeSettings(page) { await page.click('#settingsDone'); await sleep(300); }
async function watchView(page, ms, step = 100) {
  const tl = [], t0 = Date.now(); let last = null;
  while (Date.now() - t0 < ms) {
    const s = await page.evaluate(() => ZhuyinBoard.state.view + ' ini=' + ZhuyinBoard.state.comp.ini);
    if (s !== last) { tl.push(`${Date.now() - t0}ms:${s}`); last = s; }
    await sleep(step);
  }
  return tl;
}

// =====================================================================
async function layoutProbe(page) {
  return page.evaluate(() => {
    const Z = ZhuyinBoard, S = Z.state, D = window.ZHUYIN_DICT;
    const setComp = (ini = '', med = '', fin = '') => { S.comp = { ini, med, fin }; S.tone = null; S.page = 0; };
    const TM = 'ˊˇˋ˙';
    const dec = k => TM.includes(k.slice(-1)) ? [k.slice(0, -1), k.slice(-1)] : [k, ''];
    const INI = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ', MED = 'ㄧㄨㄩ';
    const parse = b => { let ini = '', med = '', fin = ''; const a = [...b]; if (INI.includes(a[0])) ini = a.shift(); if (a.length && MED.includes(a[0])) med = a.shift(); fin = a.join(''); return [ini, med, fin]; };
    const keys = Object.keys(D.chars);
    const k8 = keys.find(k => [...D.chars[k]].length === 8);
    const k9 = keys.find(k => [...D.chars[k]].length === 9);
    const kmax = keys.reduce((a, k) => [...D.chars[k]].length > [...D.chars[a]].length ? k : a, keys[0]);
    const candView = (key, pg = 0) => () => { const [b, t] = dec(key); const [i, m, f] = parse(b); setComp(i, m, f); S.tone = t; Z.go('cand'); S.page = pg; Z.render(); };
    const nextChar = Object.keys(D.next).find(c => [...D.next[c]].length >= 7) || Object.keys(D.next)[0];
    const longPhrases = ['我要喝很多很多的水謝謝', '請幫我把平板拿過來', '好', '我今天很開心', '我想要看電視', '我肚子餓了想吃飯', '不要', '再一次再一次再一次'];
    const origPhrases = Z.cfg.phrases;
    const V = [
      ['home', () => { setComp(); Z.go('home'); }],
      ['group-4', () => { setComp(); Z.go('group', 'ㄅㄆㄇㄈ'); }],
      ['group-3', () => { setComp(); Z.go('group', 'ㄍㄎㄏ'); }],
      ['mf-none', () => { setComp(); Z.go('mf'); }],
      ['mf-ㄇ', () => { setComp('ㄇ'); Z.go('mf'); }],
      ['mf-ㄐ', () => { setComp('ㄐ'); Z.go('mf'); }],
      ['f-ㄍㄨ', () => { setComp('ㄍ', 'ㄨ'); Z.go('f'); }],
      ['f-ㄧ', () => { setComp('', 'ㄧ'); Z.go('f'); }],
      ['fgroup-5', () => { setComp('ㄇ'); Z.go('fgroup', 'ㄢㄣㄤㄥㄦ'); }],
      ['fgroup-4', () => { setComp('ㄇ'); Z.go('fgroup', 'ㄚㄛㄜㄝ'); }],
      ['tone-ㄇㄚ', () => { setComp('ㄇ', '', 'ㄚ'); Z.go('tone'); }],
      ['tone-ㄓㄨㄤ', () => { setComp('ㄓ', 'ㄨ', 'ㄤ'); Z.go('tone'); }],
      ['tone-ㄋㄩㄝ', () => { setComp('ㄋ', 'ㄩ', 'ㄝ'); Z.go('tone'); }],
      ['cand-ㄇㄚ˙(small)', candView('ㄇㄚ˙')],
      ['cand-ㄇㄚ(first,hints)', candView('ㄇㄚ')],
      ['cand-ㄧˋ p0', candView('ㄧˋ', 0)],
      ['cand-ㄧˋ p1', candView('ㄧˋ', 1)],
      ['cand-8items ' + k8, candView(k8)],
      ['cand-9items ' + k9, candView(k9)],
      ['cand-max ' + kmax, candView(kmax, 0)],
      ['next-' + nextChar, () => { setComp(); S.lastChar = nextChar; Z.go('next'); }],
      ['menu', () => { setComp(); Z.go('menu'); }],
      ['phrases', () => { setComp(); Z.go('phrases'); }],
      ['phrases-long', () => { Z.cfg.phrases = longPhrases; setComp(); Z.go('phrases'); }],
      ['clear', () => { setComp(); Z.go('clear'); }],
      ['rest', () => { setComp(); Z.go('rest'); }],
    ];
    const vw = innerWidth, vh = innerHeight, landscape = vw > vh;
    const R = el => el.getBoundingClientRect();
    const inV = r => r.left >= -0.5 && r.top >= -0.5 && r.right <= vw + 0.5 && r.bottom <= vh + 0.5;
    const res = [];
    for (const [name, setup] of V) {
      setup();
      const one = { name, vw, vh, issues: [], notes: [] };
      one.scrollW = document.documentElement.scrollWidth; one.scrollH = document.documentElement.scrollHeight;
      if (one.scrollW > vw) one.issues.push(`document scrollWidth ${one.scrollW} > innerWidth ${vw}`);
      if (one.scrollH > vh) one.issues.push(`document scrollHeight ${one.scrollH} > innerHeight ${vh}`);
      if (document.body.scrollWidth > vw) one.issues.push(`body scrollWidth ${document.body.scrollWidth} > ${vw}`);
      const els = [...document.querySelectorAll('#board button'), ...document.querySelectorAll('#rail button')];
      one.n = document.querySelectorAll('#board button').length;
      let minDim = 1e9;
      for (const el of els) {
        const r = R(el), isRail = !!el.dataset.rail;
        const lab = isRail ? 'rail:' + el.dataset.rail : `tile#${el.dataset.i}(${(el.getAttribute('aria-label') || '').slice(0, 10)})`;
        if (r.width < 1 || r.height < 1) one.issues.push(`${lab} zero size ${r.width}x${r.height}`);
        if (!inV(r)) one.issues.push(`${lab} outside viewport [${r.left.toFixed(1)},${r.top.toFixed(1)},${r.right.toFixed(1)},${r.bottom.toFixed(1)}]`);
        minDim = Math.min(minDim, r.width, r.height);
        const cs = getComputedStyle(el);
        const pb = { l: r.left + parseFloat(cs.borderLeftWidth), r: r.right - parseFloat(cs.borderRightWidth), t: r.top + parseFloat(cs.borderTopWidth), b: r.bottom - parseFloat(cs.borderBottomWidth) };
        const cb = { l: pb.l + parseFloat(cs.paddingLeft), r: pb.r - parseFloat(cs.paddingRight), t: pb.t + parseFloat(cs.paddingTop), b: pb.b - parseFloat(cs.paddingBottom) };
        const kids = [...el.children].filter(c => !c.classList.contains('fill'));
        let u = null;
        for (const c of kids) { const q = R(c); if (!q.width && !q.height) continue; u = u ? { l: Math.min(u.l, q.left), r: Math.max(u.r, q.right), t: Math.min(u.t, q.top), b: Math.max(u.b, q.bottom) } : { l: q.left, r: q.right, t: q.top, b: q.bottom }; }
        if (u) {
          const o = { L: pb.l - u.l, R: u.r - pb.r, T: pb.t - u.t, B: u.b - pb.b };
          const worst = Math.max(o.L, o.R, o.T, o.B);
          one.slack = Math.min(one.slack === undefined ? 1e9 : one.slack, -worst);
          if (worst > 0.5) one.issues.push(`${lab} text CLIPPED by ${worst.toFixed(1)}px (L${o.L.toFixed(1)} R${o.R.toFixed(1)} T${o.T.toFixed(1)} B${o.B.toFixed(1)}) tile ${r.width.toFixed(0)}x${r.height.toFixed(0)} content ${(u.r - u.l).toFixed(0)}x${(u.b - u.t).toFixed(0)}`);
          else {
            const c2 = Math.max(cb.l - u.l, u.r - cb.r, cb.t - u.t, u.b - cb.b);
            if (c2 > 0.5) one.notes.push(`${lab} text eats padding (${c2.toFixed(1)}px)`);
          }
        }
        for (const s of kids.filter(c => /\b(big|row|lbl|sub)\b/.test(c.className))) {
          if (s.scrollWidth > el.clientWidth + 1 || s.scrollHeight > el.clientHeight + 1) one.issues.push(`${lab} .${s.className} scroll ${s.scrollWidth}x${s.scrollHeight} > tile client ${el.clientWidth}x${el.clientHeight}`);
        }
        if (el.scrollWidth > el.clientWidth + 4 || el.scrollHeight > el.clientHeight + 4) one.issues.push(`${lab} tile scroll ${el.scrollWidth}x${el.scrollHeight} > client ${el.clientWidth}x${el.clientHeight}`);
      }
      one.minDim = Math.round(minDim);
      for (const sel of ['.out', '.comp', '#gear']) { const q = R(document.querySelector(sel)); if (!inV(q)) one.issues.push(`${sel} outside viewport [${q.left.toFixed(0)},${q.top.toFixed(0)},${q.right.toFixed(0)},${q.bottom.toFixed(0)}]`); }
      const bd = R(document.querySelector('#board')), rl = R(document.querySelector('#rail'));
      one.board = [bd.left, bd.top, bd.right, bd.bottom].map(Math.round); one.rail = [rl.left, rl.top, rl.right, rl.bottom].map(Math.round);
      if (landscape) { if (!(rl.left >= bd.right - 0.5 && rl.width < rl.height)) one.issues.push(`rail not on the right: rail ${one.rail} board ${one.board}`); }
      else if (!(rl.top >= bd.bottom - 0.5 && rl.width > rl.height)) one.issues.push(`rail not at the bottom: rail ${one.rail} board ${one.board}`);
      res.push(one);
    }
    Z.cfg.phrases = origPhrases;
    return res;
  });
}

// =====================================================================
(async () => {
  const browser = await chromium.launch();
  const { ctx, page } = await newPage(browser, { width: 1133, height: 744 }, {}, 'main');

  // 1 ---------------------------------------------------------------
  await check(1, 'start screen -> home with 8 tiles', async t => {
    t.ok(await page.locator('#start').isVisible(), '#start not visible');
    t.ok(await page.locator('#startBtn').isVisible(), '#startBtn not visible');
    t.eq((await page.locator('#startBtn').innerText()).trim(), '開始', 'start button label');
    await page.click('#startBtn'); await sleep(500);
    t.ok(!(await page.locator('#start').isVisible()), '#start still visible after click');
    t.eq((await S(page)).view, 'home', 'view');
    t.eq(await page.locator('#board button[data-i]').count(), 8, 'tile count');
    const info = await tileInfo(page);
    const exp = ['ㄅㄆㄇㄈ', 'ㄉㄊㄋㄌ', 'ㄍㄎㄏ', 'ㄐㄑㄒ', 'ㄓㄔㄕㄖ', 'ㄗㄘㄙ', '沒有聲母', '常用句'];
    exp.forEach((e, i) => t.ok(info[i] && info[i].text.includes(e), `tile ${i} should contain "${e}", got "${info[i] && info[i].text}"`));
  });

  // 2 ---------------------------------------------------------------
  await check(2, 'type 媽 (ㄇㄚ, 一聲)', async t => {
    await resetBoard(page);
    await tapTile(page, 0); t.eq((await S(page)).view, 'group', 'view after ㄅㄆㄇㄈ');
    const g = await tileInfo(page); t.eq(g.map(x => x.text), ['ㄅ', 'ㄆ', 'ㄇ', 'ㄈ'], 'group tiles');
    await tapTile(page, 2); let s = await S(page); t.eq([s.view, s.comp.ini], ['mf', 'ㄇ'], 'after ㄇ');
    await tapTile(page, 4); s = await S(page); t.eq(s.view, 'fgroup', 'after final group'); t.eq(s.group, 'ㄚㄛㄜㄝ', 'group id');
    await tapTile(page, 0); s = await S(page); t.eq([s.view, s.comp.fin], ['tone', 'ㄚ'], 'after ㄚ');
    await tapTile(page, 0); s = await S(page); t.eq(s.view, 'cand', 'after 一聲');
    const cands = (await tileInfo(page)).map(x => x.text.slice(0, 1));
    t.note('candidate order for ㄇㄚ: ' + cands.join(''));
    t.eq(await bigText(page, 0), '媽', 'first candidate');
    const idx = cands.indexOf('媽'); t.ok(idx >= 0, '媽 not among candidates');
    await tapTile(page, Math.max(0, idx)); s = await S(page);
    const last = s.text[s.text.length - 1];
    t.eq(last && last.t, '媽', 'last unit t (after clicking the 媽 tile)'); t.eq(last && last.z, 'ㄇㄚ', 'last unit z');
    t.eq(s.view, 'home', 'view after pick');
    t.ok(await page.locator('#out ruby').count() > 0, '#out has no <ruby>');
    t.eq((await page.locator('#out ruby rt').last().innerText()).trim(), 'ㄇㄚ', 'ruby rt text');
  });

  // 3 ---------------------------------------------------------------
  await check(3, 'type 我 (no initial, ㄨ + ㄛ, ˇ)', async t => {
    await resetBoard(page);
    await tapTile(page, 6); let s = await S(page); t.eq(s.view, 'mf', 'view after 沒有聲母');
    await tapTile(page, 1); s = await S(page); t.eq([s.view, s.comp.med], ['f', 'ㄨ'], 'after ㄨ');
    await tapTile(page, 0); s = await S(page); t.eq([s.view, s.group], ['fgroup', 'ㄚㄛㄜㄝ'], 'after group');
    const info = await tileInfo(page); t.eq(info.map(x => x.text), ['ㄚ', 'ㄛ', 'ㄜ', 'ㄝ'], 'fgroup tiles');
    t.ok(!info[1].disabled, 'ㄛ tile should be enabled after ㄨ');
    await tapTile(page, 1); s = await S(page); t.eq([s.view, s.comp.fin], ['tone', 'ㄛ'], 'after ㄛ');
    await tapTile(page, 2); s = await S(page); t.eq(s.view, 'cand', 'after ˇ');
    t.eq(await bigText(page, 0), '我', 'first candidate');
    await tapTile(page, 0); s = await S(page);
    const last = s.text[s.text.length - 1]; t.eq([last && last.t, last && last.z], ['我', 'ㄨㄛˇ'], 'last unit');
  });

  // 4 ---------------------------------------------------------------
  await check(4, 'assist: after ㄐ, ㄨ disabled; ㄧ ㄩ enabled; invalid finals marked m off', async t => {
    await resetBoard(page);
    await tapTile(page, 3); await tapTile(page, 0);
    let s = await S(page); t.eq([s.view, s.comp.ini], ['mf', 'ㄐ'], 'after ㄐ');
    const info = await tileInfo(page);
    t.eq(info.slice(0, 3).map(x => x.text.slice(0, 1)), ['ㄧ', 'ㄨ', 'ㄩ'], 'medial tiles');
    t.eq([info[0].disabled, info[1].disabled, info[2].disabled], [false, true, false], 'disabled state of ㄧ ㄨ ㄩ');
    t.ok(info[3].div, 'cell 3 should be an empty div');
    for (const i of [4, 5, 6]) {
      t.ok(info[i].ms.length >= 4 && info[i].ms.every(m => m.off), `final group ${i} all members should be "m off" after ㄐ (got ${JSON.stringify(info[i].ms.map(m => m.t + (m.off ? '-' : '+')))})`);
      t.ok(info[i].disabled, `final group tile ${i} should be disabled (no valid member)`);
    }
    t.ok(info[7].disabled, 'done tile should be disabled for bare ㄐ');
    // partial validity: ㄍ has ㄍㄚ ㄍㄜ valid but ㄍㄝ not
    await resetBoard(page); await page.evaluate(() => { ZhuyinBoard.state.comp.ini = 'ㄍ'; ZhuyinBoard.go('mf'); }); await sleep(100);
    const g = await tileInfo(page);
    t.ok(!g[4].disabled && g[4].ms.some(m => m.off) && g[4].ms.some(m => !m.off), `ㄍ: group ㄚㄛㄜㄝ should be enabled with a mix of on/off members, got ${JSON.stringify(g[4].ms.map(m => m.t + (m.off ? '-' : '+')))}`);
    // exhaustive comparison to the dictionary
    const mism = await page.evaluate(() => {
      const Z = ZhuyinBoard, St = Z.state, D = window.ZHUYIN_DICT.chars, TMk = 'ˊˇˋ˙';
      const INI = [...'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ'], MED = [...'ㄧㄨㄩ'], FG = ['ㄚㄛㄜㄝ', 'ㄞㄟㄠㄡ', 'ㄢㄣㄤㄥㄦ'];
      const bases = new Map(), prefix = new Set();
      for (const k of Object.keys(D)) { const hasT = TMk.includes(k.slice(-1)); const b = hasT ? k.slice(0, -1) : k; const tm = hasT ? k.slice(-1) : ''; if (!bases.has(b)) bases.set(b, new Set()); bases.get(b).add(tm); for (let i = 1; i <= b.length; i++) prefix.add(b.slice(0, i)); }
      const out = [];
      const read = () => [...document.querySelectorAll('#board > *')];
      for (const ini of ['', ...INI]) {
        St.comp = { ini, med: '', fin: '' }; Z.go('mf'); let el = read();
        MED.forEach((m, i) => { if (el[i].disabled !== !prefix.has(ini + m)) out.push(`mf ini=${ini || '-'} med ${m}: disabled=${el[i].disabled}, dict says valid=${prefix.has(ini + m)}`); });
        FG.forEach((g, gi) => {
          const e = el[4 + gi], ms = [...e.querySelectorAll('.m')];
          [...g].forEach((f, k) => { if (ms[k].classList.contains('off') === prefix.has(ini + f)) out.push(`mf ini=${ini || '-'} fin ${f}: off=${ms[k].classList.contains('off')}, dict valid=${prefix.has(ini + f)}`); });
          const any = [...g].some(f => prefix.has(ini + f)); if (e.disabled === any) out.push(`mf ini=${ini || '-'} group ${g}: disabled=${e.disabled} but any-valid=${any}`);
        });
        if (el[7].disabled === (ini !== '' && bases.has(ini))) out.push(`mf ini=${ini || '-'} done: disabled=${el[7].disabled}, bases.has=${bases.has(ini)}`);
        for (const med of MED) {
          if (!prefix.has(ini + med)) continue;
          St.comp = { ini, med, fin: '' }; Z.go('f'); el = read();
          FG.forEach((g, gi) => { const e = el[gi], ms = [...e.querySelectorAll('.m')]; [...g].forEach((f, k) => { if (ms[k].classList.contains('off') === prefix.has(ini + med + f)) out.push(`f ${ini}${med} fin ${f}: off=${ms[k].classList.contains('off')}, dict valid=${prefix.has(ini + med + f)}`); }); });
          if (el[3].disabled === bases.has(ini + med)) out.push(`f ${ini}${med} done: disabled=${el[3].disabled}, bases.has=${bases.has(ini + med)}`);
        }
      }
      // tone availability for every syllable base in the dictionary
      let toneChecked = 0, unparsable = 0;
      for (const [b, set] of bases) {
        const a = [...b]; let ini = '', med = '', fin = '';
        if (INI.includes(a[0])) ini = a.shift(); if (a.length && MED.includes(a[0])) med = a.shift(); fin = a.join('');
        if (ini + med + fin !== b || (fin && ![...'ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ'].includes(fin))) { unparsable++; continue; }
        St.comp = { ini, med, fin }; Z.go(fin ? 'tone' : 'tone'); const el = read(); toneChecked++;
        ['', 'ˊ', 'ˇ', 'ˋ', '˙'].forEach((m, i) => { if (el[i].disabled === set.has(m)) out.push(`tone ${b}${m}: disabled=${el[i].disabled}, dict has=${set.has(m)}`); });
      }
      out.push(`#info toneChecked=${toneChecked} unparsable=${unparsable} bases=${bases.size}`);
      St.comp = { ini: '', med: '', fin: '' }; Z.go('home');
      return out;
    });
    t.note(mism.filter(x => x.startsWith('#info')).join('; '));
    mism.filter(x => !x.startsWith('#info')).slice(0, 10).forEach(x => t.fail('dict mismatch: ' + x));
  });

  // 5 ---------------------------------------------------------------
  await check(5, 'back button', async t => {
    await resetBoard(page);
    await tapTile(page, 0); await tapTile(page, 2); await tapTile(page, 4); await tapTile(page, 0);
    let s = await S(page); t.eq([s.view, s.comp.ini, s.comp.fin], ['tone', 'ㄇ', 'ㄚ'], 'precondition tone view');
    await rail(page, 'back'); s = await S(page);
    t.eq(s.view, 'mf', 'view after back from tone'); t.eq(s.comp.fin, '', 'comp.fin after back'); t.eq(s.comp.ini, 'ㄇ', 'comp.ini kept');
    await rail(page, 'back'); s = await S(page); t.eq([s.view, s.comp.ini], ['home', ''], 'second back (mf -> home, ini cleared)');
    // from home with text
    await page.evaluate(() => { const Z = ZhuyinBoard; if (!Z.state.text.length) Z.state.text.push({ t: '媽', z: 'ㄇㄚ' }); Z.state.text.push({ t: '我', z: 'ㄨㄛˇ' }); Z.go('home'); }); await sleep(100);
    const before = (await S(page)).text; await rail(page, 'back'); const after = (await S(page)).text;
    t.eq(after.length, before.length - 1, 'text length after back at home'); t.eq(after, before.slice(0, -1), 'text content after back');
    // extras: group -> home, fgroup -> mf, cand -> tone
    await tapTile(page, 0); await rail(page, 'back'); s = await S(page); t.eq(s.view, 'home', 'back from group');
    await tapTile(page, 0); await tapTile(page, 2); await tapTile(page, 4); await rail(page, 'back'); s = await S(page); t.eq([s.view, s.comp.ini], ['mf', 'ㄇ'], 'back from fgroup');
    await tapTile(page, 4); await tapTile(page, 0); await tapTile(page, 0); s = await S(page); t.eq(s.view, 'cand', 'precondition cand'); await rail(page, 'back'); s = await S(page); t.eq([s.view, s.comp.fin], ['tone', 'ㄚ'], 'back from cand');
    // back button disabled at pristine start
    await resetBoard(page); t.ok(await page.locator('[data-rail="back"]').isDisabled(), 'back should be disabled at empty home');
    t.ok(await page.locator('[data-rail="speak"]').isDisabled(), 'speak should be disabled with no text');
  });

  // 6 ---------------------------------------------------------------
  await check(6, 'settings: zhuyin-only output', async t => {
    await resetBoard(page, true);
    await openSettings(page);
    t.ok(await page.locator('#settings').isVisible(), 'settings not visible after gear hold');
    await page.check('#op-zhuyin'); await closeSettings(page);
    t.ok(!(await page.locator('#settings').isVisible()), 'settings still visible after Done');
    t.eq(await page.evaluate(() => ZhuyinBoard.cfg.output), 'zhuyin', 'cfg.output');
    await tapTile(page, 0); await tapTile(page, 2); await tapTile(page, 4); await tapTile(page, 0);
    let s = await S(page); t.eq(s.view, 'tone', 'tone view'); await tapTile(page, 2);
    s = await S(page); const last = s.text[s.text.length - 1];
    t.eq(last && last.zh, true, 'last.zh'); t.eq(last && last.t, 'ㄇㄚˇ', 'last.t'); t.eq(s.view, 'home', 'view after pick');
    t.ok(await page.locator('#out .u.zh').count() > 0, '#out has no .u.zh span');
    // 輕聲 formatting
    await tapTile(page, 0); await tapTile(page, 2); await tapTile(page, 4); await tapTile(page, 0); await tapTile(page, 4);
    s = await S(page); const l2 = s.text[s.text.length - 1]; t.eq(l2 && l2.t, '˙ㄇㄚ', '輕聲 text formatting (mark in front)');
    await openSettings(page); await page.check('#op-hanzi'); await closeSettings(page);
    t.eq(await page.evaluate(() => ZhuyinBoard.cfg.output), 'hanzi', 'cfg.output restored');
  });

  // 7 ---------------------------------------------------------------
  await check(7, 'hover dwell + position lock', async t => {
    await resetBoard(page, true);
    await openSettings(page); await page.check('#in-hover'); await closeSettings(page);
    t.eq(await page.evaluate(() => ZhuyinBoard.cfg.input), 'hover', 'cfg.input');
    const b0 = await tile(page, 0).boundingBox(); const cx = b0.x + b0.width / 2, cy = b0.y + b0.height / 2;
    await page.mouse.move(cx, cy);
    const tl1 = await watchView(page, 1800);
    let s = await S(page);
    t.note('step1 (tile0 centre, 1.8s) timeline: ' + tl1.join(' > '));
    t.eq(s.view, 'group', 'view after 1.8 s on home tile 0');
    const groupBox0 = await tile(page, 0).boundingBox();
    t.note(`home tile0 rect x=${b0.x.toFixed(0)}..${(b0.x + b0.width).toFixed(0)} y=${b0.y.toFixed(0)}..${(b0.y + b0.height).toFixed(0)}; pointer=(${cx.toFixed(0)},${cy.toFixed(0)}); group tile0 rect x=${groupBox0.x.toFixed(0)}..${(groupBox0.x + groupBox0.width).toFixed(0)} centre=(${(groupBox0.x + groupBox0.width / 2).toFixed(0)},${(groupBox0.y + groupBox0.height / 2).toFixed(0)})`);
    const tl2 = await watchView(page, 2000);
    s = await S(page);
    t.note('step2 (still, +2s) timeline: ' + (tl2.join(' > ')));
    t.eq([s.view, s.comp.ini], ['group', ''], 'step2: stays in group view, nothing auto-selected (position lock)');
    await page.mouse.move(cx, 60); await sleep(500);
    await page.mouse.move(cx, cy);
    const tl3 = await watchView(page, 1800);
    s = await S(page);
    t.note('step3 (away to y=60 for .5s, back for 1.8s) timeline: ' + tl3.join(' > '));
    t.ok(s.comp.ini === 'ㄅ' || s.comp.ini !== '', `step3: expected a symbol selected, got view=${s.view} ini="${s.comp.ini}"`);
    // 3b: same as step 3 but without the step-2 double selection getting in the way
    await page.mouse.move(cx, 60); await sleep(700); await resetBoard(page, true);
    await page.mouse.move(cx, cy); const a1 = await watchView(page, 1800);
    await page.mouse.move(cx, 60); await sleep(500);
    const preS = await S(page);
    await page.mouse.move(cx, cy); const a2 = await watchView(page, 1800);
    s = await S(page);
    t.note(`step3b (hover->group, leave immediately for .5 s, return): ${a1.join(' > ')} | after leaving: view=${preS.view} ini="${preS.comp.ini}" | after return: ${a2.join(' > ')}`);
    t.ok(preS.view === 'group' && s.view === 'mf' && s.comp.ini === 'ㄅ', `step3b: expected group then symbol ㄅ selected (view mf), got view=${s.view} ini="${s.comp.ini}"`);
    // lock matrix: which home tiles re-select under a motionless pointer after the first selection
    for (const ti of [0, 2, 5, 7]) {
      await page.mouse.move(cx, 60); await sleep(700); await resetBoard(page, true);
      const b = await tile(page, ti).boundingBox(); const px = b.x + b.width / 2, py = b.y + b.height / 2;
      await page.mouse.move(px, py); await watchView(page, 1900);
      const s1 = await S(page); await watchView(page, 2000); const s2 = await S(page);
      const again = s2.view !== s1.view || s2.comp.ini !== s1.comp.ini;
      t.note(`lock matrix: home tile ${ti} -> ${s1.view}; after 2 s motionless -> ${s2.view} ini="${s2.comp.ini}" ${again ? '<== SECOND SELECTION WITHOUT MOVING' : '(locked, ok)'}`);
      if (again) t.fail(`position lock failed for home tile ${ti}: ${s1.view} -> ${s2.view} (ini="${s2.comp.ini}") with a motionless pointer`);
    }
    // reset input to tap
    await resetBoard(page, true);
    await openSettings(page); await page.check('#in-tap'); await closeSettings(page);
    t.eq(await page.evaluate(() => ZhuyinBoard.cfg.input), 'tap', 'cfg.input reset');
    await page.mouse.move(5, 400); await sleep(2000);
    t.eq((await S(page)).view, 'home', 'no dwell activation after reset to tap mode');
  });

  // 8 ---------------------------------------------------------------
  await check(8, 'menu -> rest', async t => {
    await resetBoard(page, true);
    await page.evaluate(() => { const Z = ZhuyinBoard; if (!Z.state.text.length) Z.state.text.push({ t: '媽', z: 'ㄇㄚ' }); Z.render(); });
    await tapTile(page, 0); await tapTile(page, 2);       // ㄇ chosen -> mf
    await rail(page, 'menu'); let s = await S(page); t.eq(s.view, 'menu', 'menu view');
    const m = await tileInfo(page); t.eq(m.length, 8, 'menu tile count');
    t.eq(m.map(x => x.text).join('|'), '，|。|？|！|空格|常用句|全部清除|休息', 'menu tile labels');
    await tapTile(page, 7); s = await S(page); t.eq(s.view, 'rest', 'rest view');
    for (const r of ['back', 'speak', 'menu']) t.ok(await page.locator(`[data-rail="${r}"]`).isDisabled(), `rail ${r} should be disabled in rest`);
    t.eq(await page.locator('#board button[data-i]').count(), 1, 'rest tile count');
    await tapTile(page, 0); s = await S(page); t.eq([s.view, s.comp.ini], ['mf', 'ㄇ'], 'returns to previous stage (mf with ㄇ)');
    for (const r of ['back', 'speak', 'menu']) t.ok(!(await page.locator(`[data-rail="${r}"]`).isDisabled()), `rail ${r} should be enabled again`);
    // menu toggles closed again with 更多
    await rail(page, 'menu'); await rail(page, 'menu'); s = await S(page); t.eq(s.view, 'mf', 'menu button toggles menu closed');
  });

  // 9 ---------------------------------------------------------------
  await check(9, 'menu -> 常用句 -> first phrase', async t => {
    await resetBoard(page);
    await rail(page, 'menu'); await tapTile(page, 5); let s = await S(page); t.eq(s.view, 'phrases', 'phrases view');
    const p = await tileInfo(page); t.eq(p.length, 8, 'phrase tile count'); t.eq(p[0].text, '我要喝水', 'first phrase label');
    await tapTile(page, 0); s = await S(page);
    t.eq(s.text.slice(-4).map(u => u.t).join(''), '我要喝水', 'text ends with 我要喝水'); t.eq(s.view, 'home', 'view after phrase');
    t.eq(s.text.slice(-4).map(u => u.z), ['ㄨㄛˇ', 'ㄧㄠˋ', 'ㄏㄜ', 'ㄕㄨㄟˇ'], 'phrase readings (z)');
  });

  // extras -----------------------------------------------------------
  await check('X1', 'extras: text persists after reload; menu clear flow; predict "next" view', async t => {
    await resetBoard(page);
    await page.evaluate(() => { const Z = ZhuyinBoard; Z.state.text.push({ t: '媽', z: 'ㄇㄚ' }); Z.go('home'); }); await rail(page, 'menu'); // triggers nothing but ensures a render
    await rail(page, 'back'); // leave menu
    await page.evaluate(() => { try { localStorage.setItem('zhuyin-eye:v1', JSON.stringify({ settings: ZhuyinBoard.cfg, text: ZhuyinBoard.state.text })); } catch (e) {} });
    await page.reload({ waitUntil: 'load' });
    t.ok((await S(page)).text.length >= 1, 'text should persist across reload');
    t.ok(await page.locator('#start').isVisible(), 'start overlay should show again after reload');
    await page.click('#startBtn'); await sleep(400);
    await rail(page, 'menu'); await tapTile(page, 6); let s = await S(page); t.eq(s.view, 'clear', 'clear view');
    await tapTile(page, 1); s = await S(page); t.eq([s.view, s.text.length > 0], ['home', true], '不要清除 returns to stage view and keeps text');
    await rail(page, 'menu'); await tapTile(page, 6); await tapTile(page, 0); s = await S(page); t.eq([s.view, s.text.length], ['home', 0], '全部清除 empties text');
  });

  console.log('\n--- layout (check 10) ---');
  const viewports = [['landscape 1133x744', { width: 1133, height: 744 }, {}], ['portrait 744x1133', { width: 744, height: 1133 }, {}], ['phone 390x844', { width: 390, height: 844 }, {}], ['landscape size-L (cfg.size=1.12)', { width: 1133, height: 744 }, { size: 1.12 }]];
  const layout = {};
  for (const [label, vp, o] of viewports) {
    where = 'check10';
    const { ctx: c2, page: p2 } = await newPage(browser, vp, {}, 'layout');
    await p2.click('#startBtn'); await sleep(400);
    if (o.size) await p2.evaluate(sz => { ZhuyinBoard.cfg.size = sz; document.documentElement.style.setProperty('--scale', sz); }, o.size);
    layout[label] = await layoutProbe(p2);
    if (label.startsWith('portrait')) { // positive control: force an overflow and make sure the probe notices it
      await p2.addStyleTag({ content: '.tile .big{font-size:240px !important}' });
      layout.control = (await layoutProbe(p2)).reduce((n, r) => n + r.issues.length, 0);
    }
    await c2.close();
  }
  await check(10, 'layout at 3 viewports (+ size L)', async t => {
    t.note(`probe positive control (forced 240px glyphs): ${layout.control} issues flagged (must be > 0)`);
    t.ok(layout.control > 0, 'layout probe did not detect a forced overflow (probe is blind)');
    for (const [label, rows] of Object.entries(layout)) {
      if (label === 'control') continue;
      const issues = rows.flatMap(r => r.issues.map(i => `[${label}] ${r.name}: ${i}`));
      const minDim = Math.min(...rows.map(r => r.minDim));
      const minAt = rows.find(r => r.minDim === minDim).name;
      const tight = rows.filter(r => r.slack !== undefined).reduce((a, r) => (a === null || r.slack < a.slack) ? r : a, null);
      t.note(`[${label}] tightest text-to-tile-edge slack ${tight ? tight.slack.toFixed(1) + 'px in ' + tight.name : 'n/a'}`);
      t.note(`[${label}] ${rows.length} views probed, min tile/rail dimension ${minDim}px (${minAt}); max scrollW=${Math.max(...rows.map(r => r.scrollW))} vs vw=${rows[0].vw}`);
      const cramped = rows.flatMap(r => r.notes.map(i => `${r.name}: ${i}`));
      if (cramped.length) t.note(`[${label}] text touches padding in ${cramped.length} places, e.g. ${cramped.slice(0, 3).join(' | ')}`);
      issues.forEach(i => t.fail(i));
    }
  });

  // 13 screenshots + dark -------------------------------------------
  where = 'check13';
  const shotsDone = [];
  await check(13, 'screenshots', async t => {
    const sh = async (p, name) => { await sleep(450); await p.screenshot({ path: `${SHOTS}/${name}` }); shotsDone.push(name); };
    const a = await newPage(browser, { width: 1133, height: 744 }, { dsf: 1 }, 'shots');
    const p = a.page;
    await sh(p, 'start.png');
    await p.click('#startBtn'); await sleep(300);
    await sh(p, 'home-land.png');
    await tapTile(p, 0); await tapTile(p, 2); await tapTile(p, 4); await tapTile(p, 0);
    await sh(p, 'tone-land.png');
    await tapTile(p, 0);
    await sh(p, 'cand-land.png');
    await tapTile(p, 0);
    await tapTile(p, 3); await tapTile(p, 0);
    await sh(p, 'mf-assist-land.png');
    await openSettings(p); await sh(p, 'settings.png');
    await a.ctx.close();
    const b = await newPage(browser, { width: 744, height: 1133 }, { dsf: 1 }, 'shots');
    await b.page.click('#startBtn'); await sh(b.page, 'home-port.png'); await b.ctx.close();
    const c = await newPage(browser, { width: 1133, height: 744 }, { dsf: 1, colorScheme: 'dark' }, 'shots');
    await c.page.click('#startBtn'); await sh(c.page, 'home-dark.png'); await c.ctx.close();
    t.note('saved: ' + shotsDone.join(', '));
  });
  await ctx.close();
  await browser.close();

  // 11 camera --------------------------------------------------------
  where = 'check11';
  const cbrowser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const cam = await newPage(cbrowser, { width: 1133, height: 744 }, { permissions: ['camera'] }, 'camera');
  const cp = cam.page;
  const allConsole = [];
  cp.on('console', m => allConsole.push(`${m.type()}: ${m.text().slice(0, 160)}`));
  await check(11, 'camera mode with fake camera -> calibration overlay', async t => {
    await cp.click('#startSettings'); await sleep(300);
    await cp.check('#in-camera'); await cp.click('#settingsDone'); await sleep(300);
    await cp.click('#startBtn');
    const t0 = Date.now(), banners = []; let last = null, up = false, ls = null;
    while (Date.now() - t0 < 90000) {
      const s = await cp.evaluate(() => { const b = document.querySelector('#banner'); return { b: b.hidden ? '' : b.textContent, calib: !!document.querySelector('.calib .calib-card'), run: window.GazeCam && GazeCam.isRunning() }; });
      if (s.b !== last) { banners.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:"${s.b}"`); last = s.b; }
      if (s.calib) { up = true; ls = ((Date.now() - t0) / 1000).toFixed(1); break; }
      await sleep(250);
    }
    t.note('banner timeline: ' + banners.join(' > '));
    t.ok(up, 'no .calib-card within 90 s');
    if (up) {
      t.note(`.calib-card appeared after ${ls}s`);
      t.eq(await cp.evaluate(() => GazeCam.isRunning()), true, 'GazeCam.isRunning()');
      t.eq((await cp.locator('.calib-card h2').innerText()).trim(), '先讓 iPad 認識你的眼睛', 'card title');
      await sleep(800);
      const nz = await cp.evaluate(() => { const c = document.querySelector('.calib-card canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4) / 3; });
      t.note(`preview canvas mean brightness ${nz.toFixed(1)} (0 = no camera frames)`);
      t.ok(nz > 3, 'preview canvas is blank: no camera frames drawn');
      await cp.screenshot({ path: `${SHOTS}/calib-card.png` });
      await cp.click('[data-a="skip"]'); await sleep(500);
      t.ok(!(await cp.locator('.calib').count()), '.calib still present after 先不要');
      t.note('after skip: camState="' + (await cp.locator('#camState').innerText()) + '", banner="' + (await cp.evaluate(() => document.querySelector('#banner').hidden ? '' : document.querySelector('#banner').textContent)) + '"');
      // opening settings and pressing Done after the skip should not force calibration again
      await openSettings(cp); await closeSettings(cp); await sleep(800);
      const again = await cp.locator('.calib-card').count();
      if (again) { t.fail('closing settings (without changes) re-opened the calibration overlay after the user chose 先不要 (inputChanged flag left true when input was set from the start sheet)'); await cp.click('[data-a="skip"]').catch(() => {}); }
    }
    const cerr = errors.filter(e => e.where.startsWith('camera') && !isFont(e));
    t.note('camera console: ' + (allConsole.filter(x => !/font/i.test(x)).slice(0, 12).join(' || ') || '(none)'));
    cerr.forEach(e => t.note(`error[${e.kind}] ${e.text.slice(0, 200)}`));
  });
  await cam.ctx.close(); await cbrowser.close();

  // ---------- summary ----------
  const uniq = new Map();
  for (const e of errors) { const k = e.kind + '|' + e.text.slice(0, 180); if (!uniq.has(k)) uniq.set(k, { ...e, n: 0 }); uniq.get(k).n++; }
  console.log('\n=========== SUMMARY ===========');
  Object.keys(R).sort((a, b) => (+a || 99) - (+b || 99)).forEach(k => console.log(`${R[k].pass ? 'PASS' : 'FAIL'}  ${k}. ${R[k].name}`));
  console.log('\n--- console/page errors (deduplicated) ---');
  if (!uniq.size) console.log('(none)');
  for (const e of uniq.values()) console.log(`${isFont(e) ? '[font, ignored] ' : ''}x${e.n} ${e.where} ${e.kind}: ${e.text.slice(0, 220)}`);
  fs.writeFileSync(OUT + '/results.json', JSON.stringify({ R, errors: [...uniq.values()], layout }, null, 1));
})().catch(e => { console.error('FATAL', e); process.exit(1); });
