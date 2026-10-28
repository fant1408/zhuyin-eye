// 離線快取
// - 鍵盤：先用快取（沒有網路也能馬上打開），同時在背景抓新版，下次打開就是新版
// - 相機眼控模型和字型：只下載一次；程式改版時不用重新下載 15 MB 的模型
const CORE = 'zhuyin-eye-core-da613a3d10';
const MODEL = 'zhuyin-eye-model-0.10.35';
const CORE_FILES = ["./", "index.html", "app.js", "gaze.js", "data/zhuyin-dict.js", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png", "fonts/zhuyinboard-round.woff2"];
const MODEL_FILES = ["vendor/mediapipe/vision_bundle.mjs", "vendor/mediapipe/wasm/vision_wasm_internal.js", "vendor/mediapipe/wasm/vision_wasm_internal.wasm", "vendor/mediapipe/face_landmarker.task"];
const isStatic = url => /\/(vendor|fonts|icons)\//.test(url.pathname);

self.addEventListener('install', e => e.waitUntil((async () => {
  await (await caches.open(CORE)).addAll(CORE_FILES);
  const model = await caches.open(MODEL);
  await Promise.all(MODEL_FILES.map(async f => { // 模型下載失敗不影響鍵盤離線使用，之後用到時會再抓
    if (!(await model.match(f))) { try { await model.add(f); } catch (err) { } }
  }));
  await self.skipWaiting();
})()));

self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k !== CORE && k !== MODEL) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith((async () => {
    const hit = await caches.match(req, { ignoreSearch: true });
    if (hit && isStatic(url)) return hit;
    const net = fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(isStatic(url) ? MODEL : CORE).then(c => c.put(req, copy)); }
      return res;
    });
    if (hit) { e.waitUntil(net.catch(() => { })); return hit; }
    try { return await net; }
    catch (err) { return (req.mode === 'navigate' && await caches.match('index.html')) || Response.error(); }
  })());
});
