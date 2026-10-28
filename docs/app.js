/* 眼睛注音板 — 鍵盤流程、停留選取、語音 */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 注音符號 ----------
const INITIALS = 'ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙ';
const MEDIALS = 'ㄧㄨㄩ';
const FINALS = 'ㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦ';
const INITIAL_GROUPS = ['ㄅㄆㄇㄈ', 'ㄉㄊㄋㄌ', 'ㄍㄎㄏ', 'ㄐㄑㄒ', 'ㄓㄔㄕㄖ', 'ㄗㄘㄙ'];
const FINAL_GROUPS = ['ㄚㄛㄜㄝ', 'ㄞㄟㄠㄡ', 'ㄢㄣㄤㄥㄦ'];
const TONES = [
  { mark: '', glyph: 'ˉ', name: '一聲' },
  { mark: 'ˊ', glyph: 'ˊ', name: '二聲' },
  { mark: 'ˇ', glyph: 'ˇ', name: '三聲' },
  { mark: 'ˋ', glyph: 'ˋ', name: '四聲' },
  { mark: '˙', glyph: '˙', name: '輕聲' },
];
// 唸符號時借用的同音字：語音引擎對單獨的注音符號不一定唸得準
const SAY = {
  ㄅ: '玻', ㄆ: '坡', ㄇ: '摸', ㄈ: '佛', ㄉ: '得', ㄊ: '特', ㄋ: '訥', ㄌ: '勒', ㄍ: '哥', ㄎ: '科', ㄏ: '喝',
  ㄐ: '基', ㄑ: '七', ㄒ: '西', ㄓ: '知', ㄔ: '吃', ㄕ: '詩', ㄖ: '日', ㄗ: '資', ㄘ: '雌', ㄙ: '思',
  ㄧ: '衣', ㄨ: '屋', ㄩ: '迂', ㄚ: '啊', ㄛ: '喔', ㄜ: '鵝', ㄝ: '欸', ㄞ: '哀', ㄟ: '誒', ㄠ: '凹', ㄡ: '歐',
  ㄢ: '安', ㄣ: '恩', ㄤ: '骯', ㄥ: '鞥', ㄦ: '兒',
};
const kindOf = s => INITIALS.includes(s) ? 'ini' : MEDIALS.includes(s) ? 'med' : FINALS.includes(s) ? 'fin' : '';

const ICON = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.5"/><rect x="14" y="5" width="4" height="14" rx="1.5"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  space: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h16v-4"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
};

// ---------- 字典 ----------
const DICT = window.ZHUYIN_DICT || { chars: {}, next: {}, word: {} };
DICT.next = DICT.next || {}; DICT.word = DICT.word || {};
const HAS_DICT = Object.keys(DICT.chars || {}).length > 0;
const TONE_MARKS = 'ˊˇˋ˙';
const splitKey = k => TONE_MARKS.includes(k.slice(-1)) ? [k.slice(0, -1), k.slice(-1)] : [k, ''];
const fmtSyl = (base, mark) => mark === '˙' ? '˙' + base : base + mark;
const fmtKey = key => fmtSyl(...splitKey(key));
const BASES = new Map();   // 音節（不含聲調）→ 有字的聲調
const PREFIX = new Set();  // 所有合法音節的開頭，拿來判斷下一個符號拼不拼得出來
const READING = new Map(); // 字 → 最常用的讀音
for (const [key, s] of Object.entries(DICT.chars || {})) {
  const [base, t] = splitKey(key);
  if (!BASES.has(base)) BASES.set(base, new Set());
  BASES.get(base).add(t);
  for (let i = 1; i <= base.length; i++) PREFIX.add(base.slice(0, i));
  [...s].forEach((ch, rank) => { const r = READING.get(ch); if (!r || rank < r.rank) READING.set(ch, { key, rank }); });
}
const charsFor = key => [...((DICT.chars || {})[key] || '')];
const sayKey = key => charsFor(key)[0] || fmtKey(key);

// ---------- 設定 ----------
const DEFAULT_PHRASES = ['我要喝水', '我想上廁所', '我想休息', '我不要', '請幫我', '我好了', '謝謝', '我喜歡這個'];
const DEFAULTS = {
  input: 'tap', dwell: 1.2, output: 'hanzi', assist: true, predict: false, ruby: true,
  speakKeys: true, speakChars: true, sound: false, rate: 0.9, calm: false, size: 1,
  cursor: false, camMode: 'eyes', smooth: 1, calibPoints: 9, phrases: DEFAULT_PHRASES,
};
const STORE = 'zhuyin-eye:v1';
const stored = (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
const cfg = Object.assign({}, DEFAULTS, stored.settings || {});
const save = () => { try { localStorage.setItem(STORE, JSON.stringify({ settings: cfg, text: S.text })); } catch { /* 私密瀏覽等情況，不存也能用 */ } };

// ---------- 狀態 ----------
const S = {
  view: 'home', group: '', page: 0, tone: null, lastChar: '',
  comp: { ini: '', med: '', fin: '' },
  text: Array.isArray(stored.text) ? stored.text.slice(-400) : [],
};
let current = []; // 目前畫面上的格子
const base = () => S.comp.ini + S.comp.med + S.comp.fin;
const ok = s => !cfg.assist || !HAS_DICT || PREFIX.has(base() + s);
const canFinish = () => !!base() && (!cfg.assist || !HAS_DICT || BASES.has(base()));
const stageView = () => S.comp.fin ? 'tone' : S.comp.med ? 'f' : S.comp.ini ? 'mf' : 'home';
const resetComp = () => { S.comp = { ini: '', med: '', fin: '' }; S.tone = null; };

// ---------- 格子 ----------
function symTile(s, enabled = true) {
  return { kind: kindOf(s), html: `<span class="big">${s}</span>`, aria: enabled ? s : `${s}（拼不出來）`, off: !enabled, act: () => pickSymbol(s) };
}
function groupTile(g, kind, act, valid = () => true) {
  const members = [...g];
  const any = members.some(valid);
  return {
    kind, off: !any, act,
    aria: `${members.join(' ')} 這一組`,
    html: `<span class="row" style="--len:${members.length}">${members.map(s => `<span class="m${valid(s) ? '' : ' off'}">${s}</span>`).join('')}</span>`,
  };
}
function doneTile() {
  return { kind: 'tone', off: !canFinish(), aria: '拼好了，選聲調', html: `${ICON.check}<span class="sub">拼好了</span>`, act: () => go('tone') };
}
function fnTile(html, aria, act, extra = {}) { return Object.assign({ kind: 'fn', html, aria, act }, extra); }
function charTile(ch, key, onPick) {
  const hint = DICT.word[ch] || '';
  return { kind: 'char', aria: hint ? `${ch}，${hint}的${ch}` : ch, html: `<span class="big">${ch}</span>${hint ? `<span class="sub">${hint}</span>` : ''}`, act: () => onPick(ch, key) };
}

function buildTiles() {
  const b = base();
  switch (S.view) {
    case 'home': return [
      ...INITIAL_GROUPS.map(g => groupTile(g, 'ini', () => go('group', g))),
      { kind: 'mix', aria: '沒有聲母，從介音或韻母開始', html: '<span class="row" style="--len:5">ㄧㄨㄩㄚㄛ</span><span class="sub">沒有聲母</span>', act: () => go('mf') },
      fnTile(`${ICON.chat}<span class="lbl" style="--len:3">常用句</span>`, '常用句', () => go('phrases')),
    ];
    case 'group': return [...S.group].map(s => symTile(s, true));
    case 'mf': return [
      ...[...MEDIALS].map(s => symTile(s, ok(s))), null,
      ...FINAL_GROUPS.map(g => groupTile(g, 'fin', () => go('fgroup', g), ok)),
      doneTile(),
    ];
    case 'f': return [...FINAL_GROUPS.map(g => groupTile(g, 'fin', () => go('fgroup', g), ok)), doneTile()];
    case 'fgroup': return [...S.group].map(s => symTile(s, ok(s)));
    case 'tone': return TONES.map(t => {
      const key = b + t.mark;
      const avail = !cfg.assist || !HAS_DICT || (BASES.get(b) || new Set()).has(t.mark);
      const ex = charsFor(key)[0] || '';
      const syl = t.mark === '˙' ? `<b class="tm">˙</b>${b}` : `${b}<b class="tm">${t.glyph}</b>`;
      return {
        kind: 'tone', off: !avail, aria: `${t.name}${ex ? '，' + ex : ''}`,
        html: `<span class="big" style="--len:${b.length + 1}">${syl}</span><span class="sub">${t.name}${ex ? '・' + ex : ''}</span>`,
        act: () => pickTone(t.mark),
      };
    });
    case 'cand': {
      const key = b + S.tone, list = charsFor(key);
      if (list.length <= 8) return list.map(ch => charTile(ch, key, pickChar));
      const pages = Math.ceil(list.length / 7);
      const page = list.slice(S.page * 7, S.page * 7 + 7).map(ch => charTile(ch, key, pickChar));
      while (page.length < 7) page.push(null);
      const last = S.page >= pages - 1;
      page.push(fnTile(`${ICON.more}<span class="sub">${last ? '回第一頁' : `更多字 ${S.page + 1}/${pages}`}</span>`, last ? '回到第一頁' : '更多字',
        () => { S.page = last ? 0 : S.page + 1; render(); }));
      return page;
    }
    case 'next': {
      const list = [...(DICT.next[S.lastChar] || '')].slice(0, 7);
      const tiles = list.map(ch => charTile(ch, READING.get(ch)?.key || '', pickNext));
      while (tiles.length < 7) tiles.push(null);
      tiles.push(fnTile(`${ICON.pen}<span class="lbl" style="--len:3">自己拼</span>`, '自己拼', () => go('home')));
      return tiles;
    }
    case 'menu': return [
      ...['，', '。', '？', '！'].map(p => fnTile(`<span class="big">${p}</span>`, p, () => { addText([{ t: p }]); go(stageView()); })),
      fnTile(`${ICON.space}<span class="sub">空格</span>`, '空格', () => { addText([{ t: ' ' }]); go(stageView()); }),
      fnTile(`${ICON.chat}<span class="lbl" style="--len:3">常用句</span>`, '常用句', () => go('phrases')),
      fnTile(`${ICON.trash}<span class="sub">全部清除</span>`, '全部清除', () => go('clear'), { off: !S.text.length }),
      fnTile(`${ICON.pause}<span class="lbl" style="--len:2">休息</span>`, '休息', () => go('rest')),
    ];
    case 'phrases': {
      const list = cfg.phrases.filter(Boolean).slice(0, 8);
      return list.map(p => fnTile(`<span class="lbl" style="--len:${Math.max(3, [...p].length)}">${esc(p)}</span>`, p, () => pickPhrase(p)));
    }
    case 'clear': return [
      { kind: 'warn', aria: '確定全部清除', html: `${ICON.trash}<span class="lbl" style="--len:4">全部清除</span>`, act: () => { S.text = []; save(); go('home'); } },
      fnTile(`<span class="lbl" style="--len:4">不要清除</span>`, '不要清除，回去', () => go(stageView())),
    ];
    case 'rest': return [
      fnTile(`${ICON.play}<span class="lbl" style="--len:4">繼續打字</span><span class="sub">${cfg.input === 'tap' ? '點一下就繼續' : '看久一點就繼續'}</span>`, '繼續打字',
        () => go(stageView()), { dwell: 2 }),
    ];
  }
  return [];
}

function gridFor(n) {
  const portrait = matchMedia('(orientation: portrait)').matches;
  const L = { 1: [1, 1], 2: [2, 1], 3: [3, 1], 4: [2, 2], 5: [3, 2], 6: [3, 2], 7: [4, 2], 8: [4, 2], 9: [3, 3] };
  const P = { 1: [1, 1], 2: [1, 2], 3: [1, 3], 4: [2, 2], 5: [2, 3], 6: [2, 3], 7: [2, 4], 8: [2, 4], 9: [3, 3] };
  return (portrait ? P : L)[Math.max(1, Math.min(n, 9))];
}

// ---------- 畫面 ----------
const board = $('#board'), out = $('#out');
function tileHTML(t, i) {
  const a = [`class="tile ${t.kind}"`, 'type="button"', `data-i="${i}"`, 'data-target', `aria-label="${esc(t.aria)}"`];
  if (t.off) a.push('disabled');
  if (t.dwell) a.push(`data-dwell="${t.dwell}"`);
  return `<button ${a.join(' ')}><span class="fill" aria-hidden="true"></span>${t.html}</button>`;
}
function render() {
  current = buildTiles();
  const [cols, rows] = gridFor(current.length);
  board.style.setProperty('--cols', cols);
  board.style.setProperty('--rows', rows);
  board.dataset.view = S.view;
  board.innerHTML = current.map((t, i) => t ? tileHTML(t, i) : '<div aria-hidden="true"></div>').join('');
  renderComp(); renderText(); renderRail();
  requestAnimationFrame(() => Dwell.refresh());
}
function renderComp() {
  const now = { home: ['ini'], group: ['ini'], mf: ['med', 'fin'], f: ['fin'], fgroup: ['fin'], tone: ['tone'] }[S.view] || [];
  const toneGlyph = S.tone === null ? '' : (TONES.find(t => t.mark === S.tone) || {}).glyph;
  const vals = { ini: S.comp.ini, med: S.comp.med, fin: S.comp.fin, tone: S.view === 'cand' ? toneGlyph : '' };
  for (const k of ['ini', 'med', 'fin', 'tone']) {
    const el = $(`.slot.${k}`);
    el.querySelector('b').textContent = vals[k] || '';
    el.classList.toggle('full', !!vals[k]);
    el.classList.toggle('now', now.includes(k));
  }
}
function renderText() {
  if (!S.text.length) {
    out.innerHTML = `<span class="ph">打出來的字會在這裡</span><span class="caret"></span>`;
    return;
  }
  out.innerHTML = S.text.map(u => {
    if (u.zh) return `<span class="u zh">${esc(u.t)}</span>`;
    if (cfg.ruby && u.z) return `<ruby class="u">${esc(u.t)}<rt>${esc(fmtKey(u.z))}</rt></ruby>`;
    return `<span class="u">${u.t === ' ' ? '&nbsp;' : esc(u.t)}</span>`;
  }).join('') + '<span class="caret"></span>';
}
function renderRail() {
  const atStart = S.view === 'home' && !base() && !S.text.length;
  $('[data-rail="back"]').disabled = atStart || S.view === 'rest';
  $('[data-rail="speak"]').disabled = !S.text.length || S.view === 'rest';
  $('[data-rail="menu"]').disabled = S.view === 'rest';
}

// ---------- 動作 ----------
function go(view, group = '') { S.view = view; S.group = group; S.page = 0; render(); }
function addText(units) { S.text.push(...units); if (S.text.length > 400) S.text.splice(0, S.text.length - 400); save(); }
function pickSymbol(s) {
  const k = kindOf(s);
  if (k === 'ini') S.comp.ini = s; else if (k === 'med') S.comp.med = s; else S.comp.fin = s;
  if (cfg.speakKeys) Speech.say(SAY[s] || s);
  if (S.comp.fin) return go('tone');
  const rest = S.comp.med ? [...FINALS] : [...MEDIALS, ...FINALS];
  if (!rest.some(ok) && canFinish()) return go('tone');
  go(S.comp.med ? 'f' : 'mf');
}
function pickTone(mark) {
  const b = base(), key = b + mark;
  if (cfg.output === 'zhuyin' || !charsFor(key).length) {
    addText([{ t: fmtSyl(b, mark), z: key, zh: true }]);
    if (cfg.speakKeys || cfg.speakChars) Speech.say(sayKey(key));
    if (cfg.output !== 'zhuyin') toast('字典裡沒有這個音，先用注音寫下來');
    resetComp();
    return go('home');
  }
  if (cfg.speakKeys) Speech.say(sayKey(key));
  S.tone = mark;
  go('cand');
}
function pickChar(ch, key) {
  addText([{ t: ch, z: key }]);
  if (cfg.speakChars) Speech.say(ch);
  resetComp();
  S.lastChar = ch;
  go(cfg.predict && (DICT.next[ch] || '').length ? 'next' : 'home');
}
const pickNext = ch => pickChar(ch, READING.get(ch)?.key || '');
function pickPhrase(p) {
  addText([...p].map(ch => ({ t: ch, z: READING.get(ch)?.key || '' })));
  Speech.say(p);
  resetComp();
  go('home');
}
function back() {
  const v = S.view, c = S.comp;
  if (v === 'rest') return;
  if (v === 'group') return go('home');
  if (v === 'fgroup') return go(c.med ? 'f' : 'mf');
  if (v === 'cand') {
    if (S.page > 0) { S.page--; return render(); }
    S.tone = null;
    return go('tone');
  }
  if (['menu', 'phrases', 'clear', 'next'].includes(v)) return go(stageView());
  if (c.fin) c.fin = ''; else if (c.med) c.med = ''; else if (c.ini) c.ini = '';
  else if (v === 'mf') return go('home');
  else { S.text.pop(); save(); return render(); }
  go(stageView());
}
function speakAll() {
  const s = S.text.map(u => u.zh ? sayKey(u.z) : u.t).join('');
  Speech.say(s.trim() ? s : '');
}
function railAction(name) {
  if (name === 'back') back();
  else if (name === 'speak') speakAll();
  else if (name === 'menu') S.view === 'menu' ? back() : go('menu');
}

let busy = false, lastAct = 0;
function activate(el, via) {
  const now = performance.now();
  if (!el || el.disabled || busy || now - lastAct < 250) return;
  lastAct = now; busy = true;
  const isBack = el.dataset.rail === 'back';
  const cam = window.GazeCam;
  if (cam && cfg.input === 'camera') {
    if (isBack) cam.discardPending();
    else if (via === 'dwell') { cam.commitPending(); const r = el.getBoundingClientRect(); cam.noteTarget((r.left + r.right) / 2 / innerWidth, (r.top + r.bottom) / 2 / innerHeight); }
  }
  el.classList.add('picked');
  Sound.tick();
  setTimeout(() => {
    el.classList.remove('picked');
    busy = false;
    if (el.dataset.rail) return railAction(el.dataset.rail);
    const t = current[+el.dataset.i];
    if (t && !t.off) t.act();
  }, cfg.calm ? 110 : 190);
}
board.addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (b) activate(b, 'tap'); });
$('#rail').addEventListener('click', e => { const b = e.target.closest('button[data-rail]'); if (b) activate(b, 'tap'); });

// ---------- 停留選取（游標停留、相機眼控共用）----------
const Dwell = (() => {
  const cursor = $('#cursor');
  let on = false, targets = [], pt = null, cur = null, cand = null, candSince = 0, prog = 0;
  let lastT = 0, lostSince = 0, lock = null, settleUntil = 0, raf = 0;
  const inside = (r, x, y, m = 0) => x >= r.left - m && x <= r.right + m && y >= r.top - m && y <= r.bottom + m;
  function refresh() {
    targets = $$('[data-target]').filter(el => !el.disabled && el.offsetParent !== null).map(el => ({ el, r: el.getBoundingClientRect() }));
    if (cur && !targets.some(t => t.el === cur)) setCur(null);
  }
  function hit(x, y) {
    const pad = parseFloat(getComputedStyle(board).rowGap) / 2 || 8; // 格子之間的縫也算進最近的格子
    let best = null, bd = Infinity;
    for (const t of targets) {
      if (!inside(t.r, x, y, pad)) continue;
      const d = Math.hypot((x - (t.r.left + t.r.right) / 2) / t.r.width, (y - (t.r.top + t.r.bottom) / 2) / t.r.height);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  function setCur(el) {
    if (cur && cur !== el) { cur.classList.remove('is-gaze'); cur.style.removeProperty('--p'); }
    cur = el; prog = 0;
    if (cur) cur.classList.add('is-gaze');
  }
  function tick(t) {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(t - (lastT || t), 100); lastT = t;
    if (sheetOpen()) { if (cur) setCur(null); return; }
    if (!pt) { if (cur && t - lostSince > 600) setCur(null); return; } // 眨眼或找不到臉：短時間內保留進度
    const [x, y] = pt;
    if (lock) {
      if (!inside(lock, x, y)) { lock.out = lock.out || t; if (t - lock.out > 150) lock = null; } else lock.out = 0;
    }
    const h = hit(x, y);
    let el = h ? h.el : null;
    if (el && lock && inside(lock, x, y)) el = null; // 剛選過的位置要先移開眼睛，換頁後同一個位置的新格子才不會被連續選到
    if (el !== cur) {
      if (el !== cand) { cand = el; candSince = t; }
      if (t - candSince >= (el ? 110 : 260)) setCur(el);
    } else cand = el;
    if (cur && t >= settleUntil) {
      prog += dt / (cfg.dwell * 1000 * (+cur.dataset.dwell || 1));
      if (prog >= 1) {
        const el2 = cur;
        settleUntil = t + 300;
        if (el2.hasAttribute('data-repeat')) { prog = -0.6; } // 「退回」可以一直看著連續退
        else { lock = el2.getBoundingClientRect(); setCur(null); }
        activate(el2, 'dwell');
      }
      if (cur) cur.style.setProperty('--p', Math.max(0, prog).toFixed(3));
    }
  }
  return {
    refresh,
    point(x, y) {
      if (x == null) { if (pt) lostSince = performance.now(); pt = null; return; }
      pt = [x, y];
      const show = on && cfg.cursor && cfg.input === 'camera' && !sheetOpen(); // 游標和視線有偏差時孩子會追著游標跑，所以預設不顯示
      cursor.hidden = !show;
      if (show) { cursor.style.setProperty('--x', x + 'px'); cursor.style.setProperty('--y', y + 'px'); }
    },
    enable(v) {
      on = v; cursor.hidden = true; pt = null; setCur(null);
      cancelAnimationFrame(raf);
      if (v) { refresh(); raf = requestAnimationFrame(tick); }
    },
    get on() { return on; },
  };
})();
document.addEventListener('pointermove', e => { if (cfg.input === 'hover' && Dwell.on) Dwell.point(e.clientX, e.clientY); }, { passive: true });
document.documentElement.addEventListener('pointerleave', () => { if (cfg.input === 'hover') Dwell.point(null); });
addEventListener('resize', () => { render(); checkOrientation(); });

// ---------- 語音、音效 ----------
const Speech = {
  voice: null,
  init() {
    if (!('speechSynthesis' in window)) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find(v => /zh[-_]TW/i.test(v.lang)) || vs.find(v => /^zh/i.test(v.lang) && !/HK|yue/i.test(v.lang)) || null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  },
  say(text) {
    if (!text || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-TW'; u.rate = +cfg.rate;
      if (this.voice) u.voice = this.voice;
      speechSynthesis.speak(u);
    } catch { /* 沒有語音也能打字 */ }
  },
  unlock() { // iPad 規定第一次發聲要在點按裡
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; speechSynthesis.speak(u); } catch { }
  },
};
const Sound = {
  ctx: null,
  unlock() { try { this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)(); this.ctx.resume(); } catch { } },
  tick() {
    if (!cfg.sound || !this.ctx) return;
    const t = this.ctx.currentTime, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sine'; o.frequency.value = 620;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.08, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(this.ctx.destination); o.start(t); o.stop(t + 0.2);
  },
};

// ---------- 訊息 ----------
const bannerEl = $('#banner');
let toastTimer = 0;
function banner(msg) { clearTimeout(toastTimer); bannerEl.textContent = msg || ''; bannerEl.hidden = !msg; }
function toast(msg, ms = 3200) { banner(msg); toastTimer = setTimeout(() => banner(''), ms); }

// ---------- 輸入方式 ----------
const camdot = $('#camdot');
const MODE_NAME = { tap: '觸控／iPad 內建眼動追蹤', hover: '游標停留', camera: '本程式相機眼控' };
let camOrient = '';
const orient = () => innerWidth > innerHeight ? 'land' : 'port';
async function applyInput() {
  $('#modeName').textContent = MODE_NAME[cfg.input];
  const cam = window.GazeCam;
  if (cfg.input !== 'camera') {
    cam?.stop(); camdot.hidden = true;
    Dwell.enable(cfg.input === 'hover');
    return;
  }
  Dwell.enable(true);
  camdot.hidden = false; camdot.className = 'camdot';
  if (!cam) { banner('相機眼控模組沒有載入。'); return; }
  try {
    await cam.start({
      mode: cfg.camMode, smooth: +cfg.smooth,
      onPoint: (x, y) => Dwell.point(x, y),
      onStatus: s => {
        if (s.state === 'face') { camdot.className = 'camdot on'; if (bannerEl.dataset.face) { delete bannerEl.dataset.face; banner(''); } }
        else if (s.state === 'noface') { camdot.className = 'camdot off'; bannerEl.dataset.face = '1'; banner('看不到臉：請坐正、臉對著 iPad'); }
        else if (s.msg) banner(s.msg);
      },
    });
    banner('');
    camOrient = orient();
    if (!cam.isCalibrated()) await calibrate();
  } catch (err) {
    camdot.className = 'camdot off';
    banner(err && err.message ? err.message : '相機開不起來。');
  }
  updateCamState();
}
async function calibrate() {
  const cam = window.GazeCam;
  if (!cam || !cam.isRunning()) return;
  await cam.calibrate({ points: +cfg.calibPoints, sound: cfg.sound });
  updateCamState();
  requestAnimationFrame(() => Dwell.refresh());
}
function checkOrientation() {
  const cam = window.GazeCam;
  if (cfg.input !== 'camera' || !cam?.isRunning() || camOrient === orient()) return;
  camOrient = orient();
  if (!cam.isCalibrated()) calibrate();
}
function updateCamState() {
  const cam = window.GazeCam, el = $('#camState');
  if (!cam) { el.textContent = '相機眼控模組沒有載入'; return; }
  el.textContent = !cam.isRunning() ? '相機沒有開啟' : cam.isCalibrated() ? '已校正' : '還沒校正';
}

// ---------- 開始畫面、家長設定 ----------
const startSheet = $('#start'), settingsSheet = $('#settings');
const sheetOpen = () => !startSheet.hidden || !settingsSheet.hidden || !!document.querySelector('.calib');
let wakeLock = null;
async function keepAwake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { } }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && wakeLock !== null) keepAwake(); });

$('#startBtn').addEventListener('click', () => {
  Speech.unlock(); Sound.unlock(); keepAwake();
  startSheet.hidden = true;
  inputChanged = false;
  render();
  applyInput();
});
$('#startSettings').addEventListener('click', () => openSettings());
function openSettings() {
  syncForm();
  settingsSheet.hidden = false;
  settingsSheet.scrollTop = 0;
  updateCamState();
  updateOffline();
}
async function updateOffline() {
  const el = $('#offlineState');
  const has = async p => { try { return !!(await caches.match(new URL(p, document.baseURI).href, { ignoreSearch: true })); } catch { return false; } };
  let reg = null;
  try { reg = await navigator.serviceWorker?.getRegistration(); } catch { }
  if (!reg) { el.textContent = '這個網址不能離線使用，每次打開都要連網（Claude 預覽頁面就是這樣）。'; return; }
  const core = (await Promise.all(['index.html', 'app.js', 'gaze.js', 'data/zhuyin-dict.js'].map(has))).every(Boolean);
  const cam = (await Promise.all(['vendor/mediapipe/face_landmarker.task', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm'].map(has))).every(Boolean);
  el.textContent = core && cam ? '✓ 已可以離線使用，包含相機眼控。'
    : core ? '鍵盤已可以離線使用；相機眼控的資料（約 15 MB）還在下載，請保持連線。'
    : '正在準備離線資料，請保持連線幾分鐘後再看一次。';
}
$('#settingsDone').addEventListener('click', () => {
  Speech.unlock(); Sound.unlock();
  settingsSheet.hidden = true;
  if (!startSheet.hidden) return;
  render();
  if (inputChanged) { inputChanged = false; applyInput(); }
});
$('#recalib').addEventListener('click', async () => {
  if (cfg.input !== 'camera') { cfg.input = 'camera'; save(); syncForm(); }
  settingsSheet.hidden = true;
  startSheet.hidden = true;
  inputChanged = false;
  const cam = window.GazeCam;
  if (cam?.isRunning()) await calibrate(); else await applyInput();
  render();
});
$('#wipeText').addEventListener('click', () => { S.text = []; save(); render(); $('#textNote').textContent = '已清除'; });
$('#copyText').addEventListener('click', () => {
  const s = S.text.map(u => u.t).join('');
  navigator.clipboard?.writeText(s).then(() => { $('#textNote').textContent = '已複製'; }, () => { $('#textNote').textContent = s || '（沒有字）'; });
});

// 按住齒輪一秒才打開，孩子用眼睛「點一下」不會誤開
(function holdToOpen(el, ms) {
  let raf = 0, t0 = 0;
  const stop = () => { cancelAnimationFrame(raf); el.style.setProperty('--hold', 0); };
  const step = () => {
    const p = Math.min(1, (performance.now() - t0) / ms);
    el.style.setProperty('--hold', p);
    if (p >= 1) { stop(); openSettings(); } else raf = requestAnimationFrame(step);
  };
  el.addEventListener('pointerdown', e => { e.preventDefault(); t0 = performance.now(); raf = requestAnimationFrame(step); });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => el.addEventListener(n, stop));
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings(); } });
  el.addEventListener('contextmenu', e => e.preventDefault());
})($('#gear'), 1000);

let inputChanged = false;
function syncForm() {
  $$('[data-set]').forEach(el => {
    const k = el.dataset.set, v = cfg[k];
    if (el.type === 'checkbox') el.checked = !!v;
    else if (el.type === 'radio') el.checked = String(v) === el.value;
    else if (k === 'phrases') el.value = v.join('\n');
    else el.value = v;
  });
  $('#out-dwell').textContent = `${(+cfg.dwell).toFixed(1)} 秒`;
  $('#out-rate').textContent = `${(+cfg.rate).toFixed(2)} 倍`;
}
$$('[data-set]').forEach(el => {
  const k = el.dataset.set;
  el.addEventListener(el.type === 'range' || k === 'phrases' ? 'input' : 'change', () => {
    if (el.type === 'checkbox') cfg[k] = el.checked;
    else if (el.type === 'radio') { if (!el.checked) return; cfg[k] = typeof DEFAULTS[k] === 'number' ? +el.value : el.value; }
    else if (k === 'phrases') cfg[k] = el.value.split('\n').map(s => s.trim()).filter(Boolean).slice(0, 8);
    else cfg[k] = +el.value;
    save();
    applySetting(k);
  });
});
function applySetting(k) {
  if (k === 'dwell') $('#out-dwell').textContent = `${(+cfg.dwell).toFixed(1)} 秒`;
  if (k === 'rate') $('#out-rate').textContent = `${(+cfg.rate).toFixed(2)} 倍`;
  if (k === 'size') document.documentElement.style.setProperty('--scale', cfg.size);
  if (k === 'calm') document.body.classList.toggle('calm', cfg.calm);
  if (k === 'input') { inputChanged = true; $('#modeName').textContent = MODE_NAME[cfg.input]; }
  if (k === 'camMode') { window.GazeCam?.setMode(cfg.camMode); updateCamState(); }
  if (k === 'smooth') window.GazeCam?.setSmooth(+cfg.smooth);
  if (k === 'assist' || k === 'output') { resetComp(); S.view = 'home'; }
}

// 桌機測試用：數字鍵選第 n 格，Backspace 退回
document.addEventListener('keydown', e => {
  if (sheetOpen() || e.target.closest?.('input, textarea')) return;
  if (/^[1-9]$/.test(e.key)) { const b = $$('#board button[data-i]')[+e.key - 1]; if (b) activate(b, 'key'); }
  else if (e.key === 'Backspace') { e.preventDefault(); activate($('[data-rail="back"]'), 'key'); }
});

// ---------- 啟動 ----------
Speech.init();
document.documentElement.style.setProperty('--scale', cfg.size);
document.body.classList.toggle('calm', !!cfg.calm);
$('#modeName').textContent = MODE_NAME[cfg.input];
if (!HAS_DICT) { cfg.output = 'zhuyin'; toast('字典沒有載入，先用「只打注音」', 5000); }
matchMedia('(orientation: portrait)').addEventListener?.('change', () => render());
render();
window.ZhuyinBoard = { state: S, cfg, render, go }; // 給測試用
})();
