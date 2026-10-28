#!/usr/bin/env python3
"""把 index.html（Artifact 格式，沒有 <html>/<head>）包成可以自己架站的完整網站 docs/（GitHub Pages 直接用這個資料夾），並打包成 zip。

用法：python3 tools/build.py
"""
import hashlib
import json
import math
import re
import shutil
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "docs"
NAME = "眼睛注音板"
VERSION = "1.0.0"

HEAD = f"""<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="{NAME}">
<meta name="theme-color" content="#E7ECEE" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#11171A" media="(prefers-color-scheme: dark)">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<style>:root{{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);color-scheme:light}}body{{margin:0;font:14px system-ui,sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
</head>
<body>
"""
TAIL = """
<script>
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); // 請瀏覽器不要自動清掉離線資料
}
</script>
</body>
</html>
"""

MP_VERSION = "0.10.35"
CORE_FILES = ["./", "index.html", "app.js", "gaze.js", "data/zhuyin-dict.js", "manifest.webmanifest",
              "icons/icon-180.png", "icons/icon-192.png"]
FONT_FILE = "fonts/zhuyinboard-round.woff2"
MODEL_FILES = ["vendor/mediapipe/vision_bundle.mjs", "vendor/mediapipe/wasm/vision_wasm_internal.js",
               "vendor/mediapipe/wasm/vision_wasm_internal.wasm", "vendor/mediapipe/face_landmarker.task"]

SW = """// 離線快取
// - 鍵盤：先用快取（沒有網路也能馬上打開），同時在背景抓新版，下次打開就是新版
// - 相機眼控模型和字型：只下載一次；程式改版時不用重新下載 15 MB 的模型
const CORE = 'zhuyin-eye-core-%(core)s';
const MODEL = 'zhuyin-eye-model-%(mp)s';
const CORE_FILES = %(core_files)s;
const MODEL_FILES = %(model_files)s;
const isStatic = url => /\\/(vendor|fonts|icons)\\//.test(url.pathname);

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
"""


def icon(size: int) -> Image.Image:
    """圓角方塊裡的一隻眼睛：校正點用的同一組顏色。"""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=(29, 108, 117, 255))
    cx, cy, w, h = s / 2, s / 2, s * 0.72, s * 0.40
    pts = []
    for i in range(181):
        t = math.pi * i / 180
        pts.append((cx - w / 2 + w * i / 180, cy - h / 2 * math.sin(t)))
    for i in range(181):
        t = math.pi * i / 180
        pts.append((cx + w / 2 - w * i / 180, cy + h / 2 * math.sin(t)))
    d.polygon(pts, fill=(250, 251, 251, 255))
    r = s * 0.15
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(27, 40, 46, 255))
    r2 = s * 0.055
    d.ellipse([cx - r2, cy - r2, cx + r2, cy + r2], fill=(233, 169, 59, 255))
    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    if DIST.exists():
        shutil.rmtree(DIST)
    (DIST / "icons").mkdir(parents=True)
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    core_files = list(CORE_FILES)
    if (ROOT / FONT_FILE).exists():  # 自架版用本機字型，離線時字形才不會換掉
        page = re.sub(r'<link rel="preconnect"[^>]*>\n', "", page)
        gf = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Huninn&display=swap">'
        assert gf in page, "Google Fonts link not found in index.html"
        page = page.replace(gf, '<style>@font-face{font-family:"ZhuyinBoard Round";src:url("%s") format("woff2");font-display:swap}</style>' % FONT_FILE)
        stack = '--font-board: "Huninn",'
        assert stack in page, "font stack not found in index.html"
        page = page.replace(stack, '--font-board: "ZhuyinBoard Round",')  # 修改版字型依 OFL 不能沿用原名
        (DIST / "fonts").mkdir()
        for f in (Path(FONT_FILE).name, "OFL.txt"):
            if (ROOT / "fonts" / f).exists():
                shutil.copy2(ROOT / "fonts" / f, DIST / "fonts" / f)
        core_files.append(FONT_FILE)
    (DIST / "index.html").write_text(HEAD + page + TAIL, encoding="utf-8")
    for f in ["app.js", "gaze.js", "data/zhuyin-dict.js", "data/README.md"]:
        (DIST / f).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / f, DIST / f)
    if (ROOT / "vendor").exists():
        shutil.copytree(ROOT / "vendor", DIST / "vendor")
    for size in (180, 192, 512):
        icon(size).save(DIST / "icons" / f"icon-{size}.png")
    manifest = {
        "id": "./", "name": NAME, "short_name": NAME, "lang": "zh-Hant-TW", "start_url": "./", "scope": "./",
        "display": "standalone", "orientation": "any",
        "background_color": "#E7ECEE", "theme_color": "#1D6C75",
        "icons": [{"src": f"icons/icon-{n}.png", "sizes": f"{n}x{n}", "type": "image/png"} for n in (192, 512)],
    }
    (DIST / "manifest.webmanifest").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    digest = hashlib.sha256()
    for f in core_files:
        if f != "./":
            digest.update((DIST / f).read_bytes())
    sw = SW % {"core": digest.hexdigest()[:10], "mp": MP_VERSION,
               "core_files": json.dumps(core_files), "model_files": json.dumps(MODEL_FILES)}
    (DIST / "sw.js").write_text(sw, encoding="utf-8")
    (DIST / ".nojekyll").write_text("", encoding="utf-8")  # GitHub Pages 不要處理檔案
    z = ROOT / "zhuyin-eye-site.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(DIST.rglob("*")):
            if p.is_file():
                zf.write(p, p.relative_to(DIST))
    total = sum(p.stat().st_size for p in DIST.rglob("*") if p.is_file())
    print(f"docs/ {total / 1e6:.1f} MB, zip {z.stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
