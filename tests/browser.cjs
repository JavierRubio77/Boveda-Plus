const { chromium, webkit, firefox } = require('playwright');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  let checked = 0;
  for (const [name, engine] of Object.entries({ chromium, chrome: chromium, webkit, firefox })) {
    let browser;
    try { browser = await engine.launch({ headless: true, ...(['chromium', 'chrome'].includes(name) ? { channel: name === 'chrome' ? 'chrome' : 'msedge', args: ['--no-proxy-server'] } : {}) }); }
    catch (error) { console.log(`${name}: unavailable (${error.message.split('\n')[0]})`); continue; }
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
      page.setDefaultTimeout(10000);
      await page.route('http://127.0.0.1:4179/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        const file = path.resolve('dist', pathname === '/' ? 'index.html' : '.' + pathname);
        return fs.existsSync(file) ? route.fulfill({ path: file }) : route.fulfill({ status: 404, body: '' });
      });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:4179');
      console.log(`${name}: loaded`);
      await page.locator('[name=pin]').fill('1234');
      await page.locator('[name=confirmPin]').fill('1234');
      await page.locator('#setup-form button[type=submit]').click();
      await page.locator('.floating-add').click();
      assert.equal(await page.locator('#entry-form [required]').count(), 0);
      await page.locator('[name=notes]').fill(Array(60).fill('Nota').join('\n'));
      await page.locator('#entry-form button[type=submit]').click();
      await page.locator('.entry-card').waitFor();
      assert.equal(await page.locator('.entry-card h3').textContent(), 'Sin nombre');
      await page.locator('.entry-card h3').click();
      await page.locator('.detail-card').waitFor();
      const backTop = (await page.locator('.back-row').boundingBox()).y;
      await page.locator('.main-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal((await page.locator('.back-row').boundingBox()).y, backTop);
      assert.ok(await page.locator('.back-row .back-button').isVisible());
      const actions = await page.locator('.detail-card .entry-actions > button').evaluateAll(els => els.map(el => ({y:el.getBoundingClientRect().y,width:el.getBoundingClientRect().width})));
      assert.equal(actions[0].y, actions[1].y);
      assert.equal(actions[1].width, 46);
      await page.locator('.detail-card .edit-button').click();
      await page.locator('#entry-form').waitFor();
      const editBackTop = (await page.locator('.back-row').boundingBox()).y;
      await page.locator('.main-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal((await page.locator('.back-row').boundingBox()).y, editBackTop);
      await page.locator('.back-row .back-button').click();

      const workbook = XLSX.utils.book_new();
      const headers = ['Nombre','URL','Nombre de usuario','Contraseña','Código adicional','Notas','Categoría','Último cambio'];
      const rows = Array.from({length:26}, (_, i) => [String.fromCharCode(65+i)+' ejemplo', 'https://example.com', '', 'test', '', '', i % 2 ? 'Trabajo' : '', '']);
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers,...rows]), 'Contraseñas');
      await page.locator('[data-action=menu]').click();
      const chooser = page.waitForEvent('filechooser');
      await page.locator('[data-action=import-plain]').click();
      await (await chooser).setFiles({name:'test.xlsx', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})});
      await page.locator('[data-action=confirm-plain-import]').click();
      await page.locator('.entry-card').nth(26).waitFor();
      await page.locator('.letter-button[data-letter=M]').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.entry-card').count(), 27);
      assert.equal(await page.locator('.letter-button.active').getAttribute('data-letter'), 'M');
      const position = await page.locator('.entry-card[data-entry-letter=M]').evaluate(el => Math.abs(el.getBoundingClientRect().top - document.querySelector('.main-content').getBoundingClientRect().top));
      assert.ok(position < 2, `M alignment ${position}`);
      await page.locator('.letter-button[data-letter=Z]').click();
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.letter-button.active').getAttribute('data-letter'), 'Z');
      await page.locator('.main-content').evaluate(el => { el.scrollTop = 0; });
      await page.waitForTimeout(100);
      assert.equal(await page.locator('.letter-button.active').getAttribute('data-letter'), '');
      await page.locator('[data-view=categories]').click();
      const cards = await page.locator('.category-item').evaluateAll(els => els.map(el => { const r=el.getBoundingClientRect(); return {top:r.top,left:r.left}; }));
      assert.equal(cards.length, 2);
      assert.equal(cards[0].top, cards[1].top);
      assert.ok(cards[1].left > cards[0].left);
      await page.locator('.category-open[data-category=""]').click();
      assert.equal(await page.locator('.entry-card').count(), 14);
      await page.setViewportSize({width:1280,height:900});
      assert.equal(await page.locator('.entry-card').count(),14);
      assert.deepEqual(errors, []);
      checked += 1;
      console.log(`${name}: PASS mobile/desktop, optional fields, detail, Excel, alphabet jump/scroll, category grid/filter`);
    } finally { await browser.close(); }
  }
  assert.ok(checked > 0, 'No browser was available for validation');
})().catch(error => { console.error(error); process.exitCode=1; });
