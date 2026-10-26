const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  let legacy = false;
  let failAsset = false;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    // Match Cloudflare's canonical URL redirect, absent from Vite's dev server.
    if (pathname === '/index.html') { res.writeHead(307, { Location: '/' }); res.end(); return; }
    const file = path.resolve('dist', pathname === '/' ? 'index.html' : '.' + pathname);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    if (pathname === '/sw.js' && legacy) {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync('tests/fixtures/sw-v5.js'));
      return;
    }
    if (failAsset && pathname.startsWith('/assets/')) { res.writeHead(503); res.end(); return; }
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
    for (const upgrade of [false, true]) {
      legacy = upgrade;
      const context = await browser.newContext({ viewport: { width:390,height:844 } });
      let page = await context.newPage();
      const url = `http://127.0.0.1:${server.address().port}/`;
      await page.goto(url);
      await page.locator('#setup-form').waitFor({timeout:10000});
      await page.locator('[name=pin]').fill('1234');
      await page.locator('[name=confirmPin]').fill('1234');
      await page.locator('#setup-form button[type=submit]').click();
      await page.locator('.floating-add').click();
      await page.locator('[name=title]').fill('Conservar esta entrada');
      await page.locator('[name=password]').fill('test-keep');
      await page.locator('#entry-form button[type=submit]').click();
      await page.locator('.entry-card').waitFor();
      await page.evaluate(() => navigator.serviceWorker.ready);
      if (upgrade) {
        await page.waitForFunction(async () => (await caches.keys()).includes('boveda-v5'));
        legacy = false;
        failAsset = true;
        await page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          await registration.update();
          const installing = registration.installing;
          if (installing && installing.state !== 'redundant') await new Promise(resolve => {
            installing.addEventListener('statechange', () => { if (installing.state === 'redundant') resolve(); });
          });
        });
        assert.ok(await page.evaluate(() => caches.has('boveda-v5')), 'Failed update must preserve previous cache');
        failAsset = false;
        await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
        await page.waitForFunction(async () => (await caches.keys()).some(key => key.startsWith('boveda-plus-v1-')) && !(await caches.has('boveda-v5')));
      }
      await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
      const cachedDocument = await page.evaluate(async () => {
        const response = await caches.match('/');
        return { redirected: response.redirected, status: response.status };
      });
      assert.equal(cachedDocument.redirected, false);
      assert.equal(cachedDocument.status, 200);
      await page.reload();
      await page.locator('#unlock-form').waitFor({ timeout: 10000 });
      // Simulate a closed PWA, losing the HTTP cache, with no connection on reopen.
      const session = await context.newCDPSession(page);
      await session.send('Network.clearBrowserCache');
      await page.close();
      await context.setOffline(true);
      page = await context.newPage();
      await page.goto(url);
      await page.locator('#unlock-form').waitFor({timeout:10000});
      await page.locator('[name=pin]').fill('1234');
      await page.locator('#unlock-form button[type=submit]').click();
      await page.locator('.entry-card h3').waitFor({timeout:10000});
      assert.equal(await page.locator('.entry-card h3').textContent(), 'Conservar esta entrada');
      console.log(`PASS: ${upgrade ? 'v5 upgrade survives interrupted download, then updates' : 'fresh install'}; offline reopen without HTTP cache; encrypted entry preserved`);
      await context.close();
    }
    failAsset = true;
    const brokenContext = await browser.newContext();
    const brokenPage = await brokenContext.newPage();
    await brokenPage.goto(`http://127.0.0.1:${server.address().port}/`);
    await brokenPage.locator('#startup-retry').waitFor({ timeout: 15000 });
    assert.ok((await brokenPage.locator('#startup-message').textContent()).includes('Tus datos guardados se conservan'));
    console.log('PASS: failed JavaScript download shows a recovery message instead of a blank screen');
    await brokenContext.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
