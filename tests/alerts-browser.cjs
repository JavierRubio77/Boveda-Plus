const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const XLSX = require('xlsx');
const day = 86_400_000;
const start = Date.parse('2026-01-01T00:00:00Z');

(async () => {
  const browser = await chromium.launch({channel:'msedge',headless:true,args:['--no-proxy-server']});
  try {
    const page = await browser.newPage({viewport:{width:390,height:844},serviceWorkers:'block'});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://127.0.0.1:4179/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = path.resolve('dist', pathname === '/' ? 'index.html' : '.' + pathname);
      return fs.existsSync(file) ? route.fulfill({path:file}) : route.fulfill({status:404,body:''});
    });
    await page.clock.setFixedTime(new Date(start + 90 * day));
    await page.goto('http://127.0.0.1:4179/');
    await page.locator('[name=pin]').fill('1234');
    await page.locator('[name=confirmPin]').fill('1234');
    await page.locator('#setup-form button[type=submit]').click();
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    await page.locator('.floating-add').click();
    await page.locator('[name=notes]').fill('Borrador que debe conservarse');
    await page.locator('[data-action=alerts]').click();
    await page.getByRole('button',{name:'Cerrar alertas'}).click();
    assert.equal(await page.locator('[name=notes]').inputValue(),'Borrador que debe conservarse');
    await page.locator('.back-row .back-button').click();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([
      ['Nombre','URL','Nombre de usuario','Contraseña','Código adicional','Notas','Categoría','Último cambio'],
      ['Banco','','','antigua','','','','2026-01-01'],
    ]),'Contraseñas');
    await page.locator('[data-action=menu]').click();
    const chooser = page.waitForEvent('filechooser');
    await page.locator('[data-action=import-plain]').click();
    await (await chooser).setFiles({name:'alerts.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})});
    await page.locator('[data-action=confirm-plain-import]').click();
    await page.locator('.alerts-button.has-alerts').waitFor();
    await page.locator('[data-action=alerts]').click();
    assert.ok((await page.locator('.alert-item').textContent()).includes('90 días'));
    await page.screenshot({path:'outputs/alerts-modal.png'});
    await page.getByRole('button',{name:'Cerrar alertas'}).click();
    await page.setViewportSize({width:320,height:700});
    const header = await page.locator('.topbar').evaluate(el => ({
      brandRight: el.querySelector('.brand').getBoundingClientRect().right,
      actionsLeft: el.querySelector('.top-actions').getBoundingClientRect().left,
      actionsRight: el.querySelector('.top-actions').getBoundingClientRect().right,
    }));
    assert.ok(header.brandRight <= header.actionsLeft && header.actionsRight <= 320, 'Header must fit small phones');
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-action=alerts]').click();
    await page.locator('[data-action=snooze-alert]').click();
    await page.locator('.alerts-dialog').getByText('No hay alertas pendientes.').waitFor();
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    await page.reload();
    await page.locator('[name=pin]').fill('1234');
    await page.locator('#unlock-form button[type=submit]').click();
    await page.locator('.entry-card').waitFor();
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    const setDays = async days => {
      await page.clock.setFixedTime(new Date(start + days * day));
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    };
    await setDays(179);
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    await setDays(180);
    await page.locator('[data-action=alerts]').click();
    assert.ok((await page.locator('.alert-item').textContent()).includes('180 días'));
    await page.locator('[data-action=snooze-alert]').click();
    await page.locator('.alerts-dialog').getByText('No hay alertas pendientes.').waitFor();
    await setDays(270);
    assert.ok((await page.locator('.alert-item').textContent()).includes('270 días'));
    await page.getByRole('button',{name:'Renovar',exact:true}).click();
    await page.locator('#entry-form').waitFor();
    assert.equal(await page.locator('[name=title]').inputValue(),'Banco');
    await page.locator('[name=notes]').fill('Editar notas no renueva la contraseña');
    await page.locator('#entry-form button[type=submit]').click();
    await page.locator('.alerts-button.has-alerts').waitFor();
    await page.locator('.entry-card .edit-button').click();
    await page.locator('[name=alertsDisabled]').check();
    await page.locator('#entry-form button[type=submit]').click();
    await page.locator('.entry-card').waitFor();
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    assert.ok(!(await page.locator('.entry-card').textContent()).includes('Conviene actualizarla'));
    await page.reload();
    await page.locator('[name=pin]').fill('1234');
    await page.locator('#unlock-form button[type=submit]').click();
    await page.locator('.entry-card .edit-button').click();
    assert.ok(await page.locator('[name=alertsDisabled]').isChecked());
    await page.locator('[name=alertsDisabled]').uncheck();
    await page.locator('#entry-form button[type=submit]').click();
    await page.locator('.alerts-button.has-alerts').waitFor();
    await page.locator('[data-action=alerts]').click();
    await page.getByRole('button',{name:'Renovar',exact:true}).click();
    await page.locator('[name=password]').fill('renovada');
    await page.locator('#entry-form button[type=submit]').click();
    await page.locator('.entry-card').waitFor();
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    await setDays(359);
    assert.equal(await page.locator('.alerts-button.has-alerts').count(),0);
    await setDays(360);
    await page.locator('[data-action=alerts]').click();
    assert.ok((await page.locator('.alert-item').textContent()).includes('90 días'));
    assert.deepEqual(errors,[]);
    console.log('PASS: alerts at 90/180/270 days, persistent snooze/disable, unchanged password age on note edits, renewal reset and preserved editor draft');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
