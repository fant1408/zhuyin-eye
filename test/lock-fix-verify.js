// Verifies the suggested one-line fix for the dwell position lock (app.js:356) on a patched COPY served from test/_patched on :8766
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch();
  for (const [label, url] of [['original (dist, :8765)', 'http://localhost:8765/'], ['patched copy (:8766)', 'http://localhost:8766/']]) {
    const p = await (await b.newContext({ viewport: { width: 1133, height: 744 } })).newPage();
    await p.goto(url); await p.click('#startBtn'); await sleep(300);
    // switch to hover mode through the UI path used in e2e: open settings via gear hold
    const g = await p.locator('#gear').boundingBox(); await p.mouse.move(g.x + 20, g.y + 20); await p.mouse.down(); await sleep(1200); await p.mouse.up();
    await p.check('#in-hover'); await p.click('#settingsDone'); await sleep(300);
    const out = [];
    for (const ti of [0, 2, 5, 7]) {
      await p.mouse.move(500, 60); await sleep(700);
      await p.evaluate(() => { const S = ZhuyinBoard.state; S.comp = { ini: '', med: '', fin: '' }; ZhuyinBoard.go('home'); }); await sleep(100);
      const bb = await p.locator(`#board button[data-i="${ti}"]`).boundingBox();
      await p.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(1900);
      const s1 = await p.evaluate(() => ZhuyinBoard.state.view + '/' + ZhuyinBoard.state.comp.ini); await sleep(2200);
      const s2 = await p.evaluate(() => ZhuyinBoard.state.view + '/' + ZhuyinBoard.state.comp.ini);
      out.push(`tile${ti}: ${s1} -> ${s2} ${s1 === s2 ? 'locked' : 'RE-SELECTED'}`);
    }
    // leave and return must still select
    await p.mouse.move(500, 60); await sleep(700);
    await p.evaluate(() => { ZhuyinBoard.go('home'); }); await sleep(100);
    const bb = await p.locator('#board button[data-i="0"]').boundingBox(); const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    await p.mouse.move(cx, cy); await sleep(1900); await p.mouse.move(cx, 60); await sleep(500); await p.mouse.move(cx, cy); await sleep(1900);
    out.push('leave+return: ' + await p.evaluate(() => ZhuyinBoard.state.view + '/' + ZhuyinBoard.state.comp.ini));
    console.log(label + '\n  ' + out.join('\n  '));
  }
  await b.close();
})();
