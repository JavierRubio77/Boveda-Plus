const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const XLSX = require('xlsx');

function loadApp() {
  const source = fs.readFileSync('src/main.js', 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/init\(\);\s*$/, '');
  const data = fs.readFileSync('src/vault-data.js', 'utf8').replace('export ', '');
  const alerts = fs.readFileSync('src/alerts.js', 'utf8').replace(/^export /gm, '');
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, btoa, atob, XLSX, console,
    document: { querySelector: () => ({}), addEventListener() {} }, window: {} });
  vm.runInContext(data + '\n' + alerts + '\n' + source, context);
  return { run: (code) => vm.runInContext(code, context), context };
}

test('migration removes only retired fields and is idempotent', () => {
  const { run, context } = loadApp();
  context.original = [{ id: '1', type: 'web', favorite: true, title: 'Árbol', url: 'example.com', password: '  secret  ', notes: 'línea\n2', category: '', lastChangedAt: '2020-01-01', custom: { a: 1 } }];
  const expected = structuredClone(context.original);
  delete expected[0].type;
  delete expected[0].favorite;
  assert.deepEqual(JSON.parse(run('JSON.stringify(migrateEntries(original))')), expected);
  assert.equal(run('JSON.stringify(migrateEntries(migrateEntries(original)))'), JSON.stringify(expected));
  assert.equal(context.original[0].favorite, true);
});

test('unlock migrates and re-encrypts old array and object payloads, preserving metadata', async () => {
  for (const legacyArray of [true, false]) {
    const { run, context } = loadApp();
    context.legacyArray = legacyArray;
    await run(`(async () => {
      const dek = randomBytes(32);
      const wrapped = await wrapDek('1234', dek);
      const entries = [{ id: 'old', type: 'app', favorite: true, url: 'keep-me', password: 'keep', notes: 'notes', custom: 42 }];
      const original = { format: 'boveda-local-v1', ...wrapped, payload: await encryptEntries(dek, legacyArray ? entries : { entries, categories: ['Trabajo'] }) };
      globalThis.saved = null;
      writeStoredRecord = async (record) => { globalThis.saved = record; };
      await unlockVault('1234', original);
      globalThis.result = await decryptEntries(dek, saved.payload);
      globalThis.original = original;
    })()`);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result.entries)), [{ id: 'old', url: 'keep-me', password: 'keep', notes: 'notes', custom: 42 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(context.result.categories)), legacyArray ? [] : ['Trabajo']);
    assert.equal(context.saved.salt, context.original.salt);
  }
});

test('new and legacy Excel templates accept optional credentials and ignore retired columns', () => {
  const { run, context } = loadApp();
  for (const legacy of [false, true]) {
    const headers = ['Nombre', 'URL', 'Nombre de usuario', 'Contraseña', 'Código adicional', 'Notas', 'Categoría', 'Último cambio'];
    const row = ['', 'example.com', '', '', '', 'Keep notes', '', ''];
    if (legacy) { headers.unshift('Tipo de acceso'); row.unshift('obsolete'); headers.push('Favorita'); row.push('obsolete'); }
    context.workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(context.workbook, XLSX.utils.aoa_to_sheet([headers, row]), 'Contraseñas');
    const result = JSON.parse(run('JSON.stringify(parsePlainWorkbook(workbook))'));
    assert.equal(result[0].url, 'example.com');
    assert.equal(result[0].password, '');
    assert.equal(result[0].notes, 'Keep notes');
    assert.ok(!('type' in result[0]) && !('favorite' in result[0]));
  }
});

test('list keeps every letter and editor has no required fields or credential autofill', () => {
  const { run } = loadApp();
  run(`state.entries = [{id:'a', title:'Árbol'}, {id:'b', title:'Banco'}, {id:'z', title:'Zorro'}].map(entry => ({...entry, lastChangedAt: '2026-01-01'}))`);
  const html = run('renderAll()');
  assert.equal((html.match(/class="entry-card/g) || []).length, 3);
  assert.ok(html.includes('data-entry-letter="A"'));
  assert.ok(!html.includes('favorite') && !html.includes('type-filter'));
  const form = run('renderForm()');
  assert.ok(!form.includes(' required') && !form.includes('type="password"'));
  assert.ok(form.includes('autocomplete="off"'));
  assert.ok(run('renderCategories()').includes('Sin categoría'));
});

test('detail shows additional code and notes only when populated; reveal lasts five seconds', () => {
  const { run, context } = loadApp();
  run(`state.entries = [{id:'detail', title:'Ejemplo', password:'secret', extraCode:'1234', notes:'Nota de prueba'}]; state.detailId = 'detail';`);
  assert.ok(run('renderView()').includes('1234'));
  assert.ok(run('renderView()').includes('Nota de prueba'));
  run(`state.entries[0].extraCode = ''; state.entries[0].notes = '';`);
  assert.ok(!run('renderView()').includes('Código adicional'));
  assert.ok(!run('renderView()').includes('Notas'));
  assert.ok(!run('renderForm()').includes('opcional'));
  const output = { textContent: '' };
  context.document.querySelector = () => output;
  context.window.clearTimeout = () => {};
  let hide;
  context.window.setTimeout = (callback, delay) => { assert.equal(delay, 5000); hide = callback; };
  for (const reveal of ['revealCardPassword', 'revealDetailPassword']) {
    run(`${reveal}('detail')`);
    assert.equal(output.textContent, 'secret');
    hide();
    assert.equal(output.textContent, '********');
  }
});

test('failed alert persistence leaves the original entry and encrypted record unchanged', async () => {
  const { run } = loadApp();
  run(`state.entries = [{id:'old', title:'Banco', password:'keep', lastChangedAt:'2020-01-01T00:00:00Z'}]; state.record = {payload:'original'}; persistEntries = async () => { throw new Error('storage failed'); }; showToast = () => {};`);
  const previous = run('JSON.stringify({entries:state.entries, record:state.record})');
  await run(`snoozeAlert('old')`);
  assert.equal(run('JSON.stringify({entries:state.entries, record:state.record})'), previous);
});
