// diagnostic: what are the ERR_ABORTED requests in camera mode?
const { chromium } = require('playwright');
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await b.newContext({ viewport: { width: 1133, height: 744 }, permissions: ['camera'] });
  const p = await ctx.newPage(); const t0 = Date.now();
  p.on('request', r => { if (/vendor/.test(r.url())) console.log(((Date.now() - t0) / 1000).toFixed(1), 'REQ', r.method(), r.url().replace('http://localhost:8765', ''), r.resourceType()); });
  p.on('requestfinished', r => { if (/vendor/.test(r.url())) console.log(((Date.now() - t0) / 1000).toFixed(1), 'FIN', r.method(), r.url().replace('http://localhost:8765', '')); });
  p.on('requestfailed', r => console.log(((Date.now() - t0) / 1000).toFixed(1), 'FAILED', r.method(), r.url().replace('http://localhost:8765', ''), r.failure().errorText));
  p.on('response', r => { if (/vendor/.test(r.url())) console.log('   resp', r.status(), r.headers()['content-type'], r.url().split('/').pop()); });
  await p.goto('http://localhost:8765/'); await p.check('#in-camera').catch(async () => { await p.click('#startSettings'); await p.check('#in-camera'); await p.click('#settingsDone'); });
  await p.click('#startBtn');
  await p.waitForSelector('.calib-card', { timeout: 90000 }); console.log('calib at', (Date.now() - t0) / 1000);
  await sleep(3000); await b.close();
})();
