import './styles.css';
import * as XLSX from 'xlsx';
import { migrateEntries } from './vault-data.js';
import { passwordAlerts, snoozePasswordAlert } from './alerts.js';

const DB_NAME = 'boveda-plus-local-db';
const DB_VERSION = 1;
const STORE_NAME = 'vault';
const RECORD_KEY = 'state';
const KDF_ITERATIONS = 310_000;
const AUTO_LOCK_MS = 5 * 60 * 1000;
const PASSWORD_REVEAL_MS = 5000;

const state = {
  view: 'all',
  search: '',
  categoryFilter: 'all',
  categories: [],
  categoryDeleteTarget: null,
  detailId: null,
  detailReturnView: 'all',
  modal: null,
  pendingPlainImport: null,
  entries: [],
  record: null,
  dekBytes: null,
  editId: null,
  passwordRevealTimer: null,
  autoLockTimer: null,
};

const app = document.querySelector('#app');

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function concatBytes(...chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredRecord() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeStoredRecord(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(record, RECORD_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('No se pudo guardar la bóveda'));
  });
}

async function deriveKek(pin, salt) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptBytes(key, bytes) {
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
}

async function decryptBytes(key, envelope) {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(envelope.iv) },
    key,
    base64ToBytes(envelope.ciphertext),
  );
  return new Uint8Array(plaintext);
}

async function wrapDek(pin, dekBytes, salt = randomBytes(16)) {
  const kek = await deriveKek(pin, salt);
  const wrapped = await encryptBytes(kek, dekBytes);
  return { salt: bytesToBase64(salt), wrapped };
}

async function unwrapDek(pin, record) {
  const kek = await deriveKek(pin, base64ToBytes(record.salt));
  return decryptBytes(kek, record.wrapped);
}

async function encryptEntries(dekBytes, entries) {
  const key = await crypto.subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  return encryptBytes(key, new TextEncoder().encode(JSON.stringify(entries)));
}

async function decryptEntries(dekBytes, payload) {
  const key = await crypto.subtle.importKey('raw', dekBytes, { name: 'AES-GCM' }, false, ['decrypt']);
  const bytes = await decryptBytes(key, payload);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function createVault(pin) {
  const dekBytes = randomBytes(32);
  const wrappedInfo = await wrapDek(pin, dekBytes);
  const record = {
    format: 'boveda-local-v1',
    createdAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2-SHA-256', iterations: KDF_ITERATIONS },
    salt: wrappedInfo.salt,
    wrapped: wrappedInfo.wrapped,
    payload: await encryptEntries(dekBytes, { entries: [], categories: [] }),
  };
  await writeStoredRecord(record);
  state.record = record;
  state.dekBytes = dekBytes;
  state.entries = [];
  state.categories = [];
  state.pendingPlainImport = null;
}

async function unlockVault(pin, record = state.record) {
  const dekBytes = await unwrapDek(pin, record);
  const decoded = await decryptEntries(dekBytes, record.payload);
  const entries = Array.isArray(decoded) ? decoded : decoded?.entries;
  const categories = Array.isArray(decoded) ? [] : decoded?.categories;
  if (!Array.isArray(entries) || !Array.isArray(categories)) throw new Error('Formato de bóveda no válido');
  state.record = record;
  state.dekBytes = dekBytes;
  state.entries = migrateEntries(entries);
  state.categories = [...new Set(categories.map((category) => String(category).trim()).filter(Boolean))];
  if (entries.some((entry) => Object.hasOwn(entry, 'type') || Object.hasOwn(entry, 'favorite'))) await persistEntries();
}

async function persistEntries() {
  state.record = {
    ...state.record,
    payload: await encryptEntries(state.dekBytes, { entries: state.entries, categories: state.categories }),
  };
  await writeStoredRecord(state.record);
}

function lockVault() {
  window.clearTimeout(state.autoLockTimer);
  window.clearTimeout(state.passwordRevealTimer);
  state.dekBytes = null;
  state.entries = [];
  state.categories = [];
  state.editId = null;
  state.modal = null;
  state.view = 'all';
  render();
}

function armAutoLock() {
  window.clearTimeout(state.autoLockTimer);
  state.autoLockTimer = window.setTimeout(lockVault, AUTO_LOCK_MS);
}

function touch() {
  if (state.dekBytes) armAutoLock();
}

function isUnlocked() {
  return Boolean(state.dekBytes);
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
}

function ageInfo(value) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  const months = Math.floor(days / 30);
  if (days >= 90) return { className: 'danger', text: `Hace ${months || 3} meses del último cambio. Conviene actualizarla.` };
  if (days >= 60) return { className: 'warning', text: `Hace ${months || 2} meses del último cambio.` };
  return { className: 'quiet', text: `Último cambio: ${formatDate(value)}` };
}

function initials(title) {
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '••';
}

function compareEntriesByTitle(a, b) {
  return String(a.title || '').localeCompare(String(b.title || ''), 'es', { sensitivity: 'base' });
}

function sortedCategories() {
  return [...state.categories].sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

function firstLetter(value) {
  return String(value || '').trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0).toUpperCase();
}

function safeExternalUrl(value) {
  if (!value) return '';
  try {
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(value) ? new URL(value) : new URL(`https://${value}`);
    return ['http:', 'https:'].includes(candidate.protocol) ? candidate.href : '';
  } catch {
    return '';
  }
}

function entryCard(entry, compact = false) {
  const age = entry.alertsDisabled === true
    ? { className: 'quiet', text: `Último cambio: ${formatDate(entry.lastChangedAt)}` }
    : ageInfo(entry.lastChangedAt);
  const url = safeExternalUrl(entry.url);
  const masked = maskedPassword(entry.password);
  return `<article class="entry-card ${compact ? 'compact' : ''}" data-entry-letter="${escapeHtml(firstLetter(entry.title))}" data-action="view" data-id="${entry.id}" aria-label="Ver ${escapeHtml(entry.title || 'Sin nombre')}">
    <div class="entry-main">
      <div class="entry-icon">${escapeHtml(initials(entry.title))}</div>
      <div class="entry-copy">
        <h3>${escapeHtml(entry.title || 'Sin nombre')}</h3>
        ${entry.url ? `<p class="entry-url">${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.url)}</a>` : escapeHtml(entry.url)}</p>` : ''}
        ${entry.username ? `<p class="entry-username">${escapeHtml(entry.username)}</p>` : ''}
        <p class="entry-password"><span data-card-password="${entry.id}">${masked}</span><button class="card-reveal" aria-label="Ver contraseña durante cinco segundos" data-action="reveal-card" data-id="${entry.id}">◉</button></p>
      </div>
    </div>
    <div class="entry-actions">
      <button class="button button-soft" data-action="copy" data-id="${entry.id}">Copiar contraseña</button>
      <button class="icon-button edit-button" aria-label="Editar ${escapeHtml(entry.title)}" data-action="edit" data-id="${entry.id}">✎</button>
    </div>
    ${compact ? '' : `<p class="age ${age.className}"><span class="age-dot"></span>${escapeHtml(age.text)}</p>`}
  </article>`;
}

function maskedPassword(password) {
  return '*'.repeat(Math.max(8, Math.min(18, String(password || '').length)));
}

function detailValue(label, value) {
  return `<div class="detail-row"><span class="detail-label">${label}</span><div class="detail-value">${value}</div></div>`;
}

function renderView() {
  const entry = state.entries.find((item) => item.id === state.detailId);
  if (!entry) return `<section class="empty-card"><h3>Contraseña no encontrada</h3><button class="button button-primary" data-action="back">Volver</button></section>`;
  const url = safeExternalUrl(entry.url);
  const urlValue = entry.url ? (url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(entry.url)}</a>` : escapeHtml(entry.url)) : '<span class="detail-muted">Sin URL</span>';
  return `<section class="page-heading detail-heading"><p class="eyebrow">CONSULTAR CONTRASEÑA</p><h1>${escapeHtml(entry.title)}</h1><p class="subtle">Información protegida de tu bóveda.</p></section>
    <section class="detail-card">
      ${detailValue('Categoría', escapeHtml(entry.category || 'Sin categoría'))}
      ${detailValue('Nombre', escapeHtml(entry.title))}
      ${entry.url ? detailValue('URL', urlValue) : ''}
      ${entry.username ? detailValue('Nombre de usuario', escapeHtml(entry.username)) : ''}
      ${detailValue('Contraseña', `<div class="detail-secret-row"><div class="masked-secret" data-detail-password="${entry.id}">${maskedPassword(entry.password)}</div><button class="detail-reveal" type="button" data-action="reveal-detail" data-id="${entry.id}" aria-label="Ver contraseña durante cinco segundos">◉</button></div><div class="entry-actions"><button class="button button-soft" data-action="copy" data-id="${entry.id}">Copiar contraseña</button><button class="icon-button edit-button" aria-label="Editar ${escapeHtml(entry.title)}" data-action="edit" data-id="${entry.id}">✎</button></div>`)}
      ${entry.extraCode ? detailValue('Código adicional', escapeHtml(entry.extraCode)) : ''}
      ${entry.notes ? detailValue('Notas', escapeHtml(entry.notes).replaceAll('\n', '<br />')) : ''}
    </section>`;
}

function shell(content) {
  return `<div class="app-shell">
    <header class="topbar">
      <div class="brand"><span class="brand-mark"><img src="/icon.svg" alt="" /></span><div><strong>Bóveda Plus</strong><small>solo en este dispositivo</small></div></div>
      <div class="top-actions">
        <button class="icon-button lock-button" aria-label="Bloquear ahora" title="Bloquear ahora" data-action="lock">🔒</button>
        ${renderAlertsButton()}
        <button class="icon-button menu-button" aria-label="Abrir menú" data-action="menu">☰</button>
      </div>
    </header>
    ${['view', 'edit', 'add'].includes(state.view) ? '<div class="back-row"><button class="back-button" data-action="back">← Volver</button></div>' : ''}
    <main class="main-content ${state.view === 'all' ? 'all-content' : ''}">${content}</main>
    <nav class="bottom-nav" aria-label="Navegación principal">
      <button class="nav-item ${state.view === 'all' || state.view === 'add' || state.view === 'edit' || state.view === 'view' ? 'active' : ''}" data-view="all"><span>▦</span><small>Contraseñas</small></button>
      <button class="nav-item ${state.view === 'categories' ? 'active' : ''}" data-view="categories"><span>⚙</span><small>Categorías</small></button>
    </nav>
    <div id="modal-root">${state.modal ? renderModal() : ''}</div>
  </div>`;
}

function renderAll() {
  const query = state.search.trim().toLowerCase();
  const filteredEntries = state.entries.filter((entry) => state.categoryFilter === 'all' || (entry.category || '') === state.categoryFilter);
  const entries = filteredEntries.filter((entry) => [entry.title, entry.url, entry.username].join(' ').toLowerCase().includes(query)).sort(compareEntriesByTitle);
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const availableLetters = new Set(entries.map((entry) => firstLetter(entry.title)));
  return `<section class="page-heading"><p class="eyebrow">TU BÓVEDA PLUS</p><h1>Todas tus contraseñas</h1><p class="subtle">${state.entries.length} contraseñas cifradas localmente.</p></section>
    <div class="search-wrap"><span class="search-icon" aria-hidden="true">⌕</span><input id="search-input" type="search" placeholder="Buscar sitio o usuario" value="${escapeHtml(state.search)}" autocomplete="off" /><button type="button" class="search-clear" data-action="clear-search" aria-label="Borrar búsqueda" ${state.search ? '' : 'disabled'}>×</button></div>
    <div class="filters-row"><select id="category-filter" aria-label="Filtrar por categoría"><option value="" ${state.categoryFilter === '' ? 'selected' : ''}>Sin categoría</option><option value="all" ${state.categoryFilter === 'all' ? 'selected' : ''}>Todas las categorías</option>${sortedCategories().map((category) => `<option value="${escapeHtml(category)}" ${state.categoryFilter === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select><button type="button" class="reset-filters" data-action="reset-filters" aria-label="Borrar filtros" title="Borrar filtros"><svg class="filter-reset-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5Z"></path><path d="m4 4 16 16"></path></svg></button></div>
    <div class="list-toolbar"><span>${entries.length} resultado${entries.length === 1 ? '' : 's'}</span></div>
    ${entries.length ? `<div class="stack">${entries.map((entry) => entryCard(entry)).join('')}</div>` : `<div class="empty-card"><div class="empty-icon">⌕</div><h3>${state.entries.length ? 'No encontramos contraseñas' : 'Tu lista está vacía'}</h3><p>${state.entries.length ? 'Prueba otra categoría o búsqueda.' : 'Añade tu primera contraseña para empezar.'}</p><button class="button button-primary" data-view="add">Añadir contraseña</button></div>`}
    <aside class="alphabet-rail" aria-label="Acceso por letra">${letters.map((letter) => `<button class="letter-button " data-letter="${letter}" aria-label="Ir a la primera contraseña que empieza por ${letter}" ${availableLetters.has(letter) ? '' : 'disabled'}>${letter}</button>`).join('')}</aside><button class="floating-add" data-view="add" aria-label="Nueva contraseña" title="Nueva contraseña">+</button>`;
}

function renderForm() {
  const entry = state.editId ? state.entries.find((item) => item.id === state.editId) : null;
  const isEdit = Boolean(entry);
  const selected = entry || { title: '', url: '', username: '', password: '', extraCode: '', notes: '' };
  return `<section class="page-heading form-heading"><p class="eyebrow">${isEdit ? 'EDITAR CONTRASEÑA' : 'NUEVA CONTRASEÑA'}</p><h1>${isEdit ? escapeHtml(selected.title) : 'Guardar contraseña'}</h1><p class="subtle">Los campos se guardan cifrados en esta bóveda.</p></section>
    <form id="entry-form" class="form-card" autocomplete="off">
      <label>Categoría<select name="category"><option value="" ${!selected.category ? 'selected' : ''}>Sin categoría</option>${sortedCategories().map((category) => `<option value="${escapeHtml(category)}" ${selected.category === category ? 'selected' : ''}>${escapeHtml(category)}</option>`).join('')}</select></label>
      <label>Nombre del sitio o aplicación<input name="title" maxlength="100" value="${escapeHtml(selected.title)}" placeholder="Ej. Mi banco" autocomplete="off" /></label>
      <label>URL<input name="url" type="text" maxlength="300" value="${escapeHtml(selected.url)}" placeholder="https://ejemplo.com" autocomplete="off" /></label>
      <label>Nombre de usuario<input name="username" maxlength="200" value="${escapeHtml(selected.username)}" placeholder="usuario@ejemplo.com" autocomplete="off" /></label>
      <label>Contraseña<div class="password-field"><input id="entry-password" name="password" maxlength="500" type="text" class="editor-secret concealed" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" value="${escapeHtml(selected.password)}" placeholder="Escribe o genera una contraseña" autocomplete="off" /><button type="button" class="field-action" data-action="toggle-form-password" aria-label="Mostrar contraseña">◉</button></div></label>
      <div class="password-tools"><button type="button" class="text-button" data-action="generate-password">Generar contraseña segura</button><small>Se recomienda una contraseña diferente por sitio.</small></div>
      <label>Código adicional<input name="extraCode" maxlength="200" value="${escapeHtml(selected.extraCode)}" placeholder="PIN, código de cliente o segundo dato" autocomplete="off" /></label>
      <label>Notas<textarea name="notes" maxlength="1000" rows="3" placeholder="Información útil para iniciar sesión">${escapeHtml(selected.notes)}</textarea></label>
      <label class="alert-preference"><input name="alertsDisabled" type="checkbox" ${selected.alertsDisabled === true ? 'checked' : ''} /><span>No generar alertas para esta contraseña</span></label>
      <div class="form-actions"><button type="button" class="button button-soft" data-action="back">Cancelar</button><button type="submit" class="button button-primary">${isEdit ? 'Guardar cambios' : 'Guardar contraseña'}</button></div>
      ${isEdit ? '<button type="button" class="danger-link" data-action="delete-entry">Eliminar contraseña</button>' : ''}
    </form>`;
}

function renderCategories() {
  return `<section class="page-heading"><p class="eyebrow">ORGANIZACIÓN</p><h1>Categorías</h1><p class="subtle">Agrupa tus contraseñas por temas para encontrarlas más rápido.</p></section>
    <form id="category-form" class="category-form"><input name="category" required maxlength="40" placeholder="Nueva categoría" autocomplete="off" aria-label="Nueva categoría" /><button class="button button-primary category-add-button" type="submit" aria-label="Crear categoría" title="Crear categoría">+</button></form>
    <div class="category-list">${['', ...sortedCategories()].map((category) => {
      const count = state.entries.filter((entry) => (entry.category || '') === category).length;
      return `<div class="category-item"><button class="category-open" data-action="open-category" data-category="${escapeHtml(category)}"><strong>${escapeHtml(category || 'Sin categoría')}</strong><small>${count} contraseñas</small></button>${category ? `<button class="icon-button" aria-label="Eliminar categoría ${escapeHtml(category)}" data-action="delete-category" data-category="${escapeHtml(category)}">×</button>` : ''}</div>`;
    }).join('')}</div>`;

}

function renderAlertsButton() {
  const count = passwordAlerts(state.entries).length;
  return `<button class="icon-button alerts-button ${count ? 'has-alerts' : ''}" data-action="alerts" aria-label="${count ? `${count} alerta${count === 1 ? '' : 's'} pendiente${count === 1 ? '' : 's'}` : 'Sin alertas pendientes'}" title="Alertas"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v5m0 3v.1" /></svg>${count ? `<span class="alerts-count" aria-hidden="true">${count}</span>` : ''}</button>`;
}

function renderAlertsModal() {
  const alerts = passwordAlerts(state.entries);
  return `<div class="modal-backdrop" data-action="close-modal"><section class="sheet dialog alerts-dialog" data-sheet role="dialog" aria-modal="true" aria-labelledby="alerts-title"><div class="sheet-title"><div><p class="eyebrow">TU BÓVEDA PLUS</p><h2 id="alerts-title">Alertas</h2></div><button class="icon-button" data-action="close-modal" aria-label="Cerrar alertas">×</button></div>${alerts.length ? `<div class="alerts-list">${alerts.map(({ entry, days }) => `<article class="alert-item"><h3>${escapeHtml(entry.title || 'Sin nombre')}</h3><p>Han pasado <strong>${days} días</strong> desde el último cambio. Sería conveniente generar una nueva contraseña para mantener la seguridad.</p><div class="alert-actions"><button class="button button-primary" data-action="edit" data-id="${escapeHtml(entry.id)}">Renovar</button><button class="button button-soft" data-action="snooze-alert" data-id="${escapeHtml(entry.id)}">Aplazar 90 días</button></div></article>`).join('')}</div>` : '<p class="subtle">No hay alertas pendientes.</p>'}</section></div>`;
}

function refreshAlertsUi() {
  const signature = JSON.stringify(passwordAlerts(state.entries).map(({ entry, days }) => [entry.id, entry.title, days]));
  const button = document.querySelector('.alerts-button');
  if (button && button.dataset.alertSnapshot !== signature) {
    button.outerHTML = renderAlertsButton();
    document.querySelector('.alerts-button').dataset.alertSnapshot = signature;
  }
  const root = document.querySelector('#modal-root');
  if (root && state.modal === 'alerts' && (root.dataset.alertSnapshot !== signature || !root.querySelector('.alerts-dialog'))) {
    root.innerHTML = renderAlertsModal();
    root.dataset.alertSnapshot = signature;
  } else if (root && state.modal !== 'alerts' && root.querySelector('.alerts-dialog')) root.innerHTML = '';
}

async function snoozeAlert(id) {
  const previousEntries = state.entries;
  const previousRecord = state.record;
  if (!passwordAlerts(state.entries).some(({ entry }) => entry.id === id)) return;
  state.entries = state.entries.map((entry) => entry.id === id ? snoozePasswordAlert(entry) : entry);
  try {
    await persistEntries();
  } catch {
    state.entries = previousEntries;
    state.record = previousRecord;
    showToast('No se pudo guardar el aplazamiento. Inténtalo de nuevo.', 'error');
    return;
  }
  refreshAlertsUi();
  showToast('Alerta aplazada 90 días', 'success');
}

function renderModal() {
  if (state.modal === 'alerts') return renderAlertsModal();
  if (state.modal === 'menu') return `<div class="modal-backdrop menu-backdrop" data-action="close-modal"><section class="sheet menu-sheet" data-sheet><div class="sheet-handle"></div><div class="sheet-title"><div><p class="eyebrow">BÓVEDA PLUS</p><h2>Herramientas</h2></div><button class="icon-button" data-action="close-modal">×</button></div><div class="menu-list"><button data-action="export"><span>↓</span><div><strong>Descargar copia cifrada</strong><small>Guárdala en tus archivos o nube personal</small></div></button><button data-action="import"><span>↑</span><div><strong>Importar copia cifrada</strong><small>Recupera un archivo .pwvault</small></div></button><button data-action="download-template"><span>▤</span><div><strong>Descargar plantilla vacía</strong><small>Plantilla oficial para importar contraseñas</small></div></button><button data-action="import-plain"><span>⇧</span><div><strong>Importar contraseñas en plano</strong><small>Carga la plantilla rellenada; se cifrará en este dispositivo</small></div></button><button data-action="change-master"><span>⌘</span><div><strong>Cambiar clave maestra</strong><small>Se conserva tu contenido cifrado</small></div></button></div><div class="menu-note">Los archivos se procesan aquí en el dispositivo. La importación en plano los cifra dentro de la bóveda; no los sube a ningún servidor.</div></section></div>`;
  if (state.modal === 'confirm-plain-import') {
    const count = state.pendingPlainImport?.length || 0;
    const categoryCount = new Set((state.pendingPlainImport || []).map((entry) => entry.category).filter(Boolean)).size;
    return `<div class="modal-backdrop" data-action="close-modal"><section class="sheet dialog" data-sheet><div class="sheet-title"><div><p class="eyebrow">IMPORTACIÓN LOCAL</p><h2>Importar contraseñas</h2></div><button class="icon-button" data-action="cancel-plain-import">×</button></div><p class="subtle">Se añadirán <strong>${count}</strong> contraseñas${categoryCount ? ` y ${categoryCount} categoría${categoryCount === 1 ? '' : 's'} nueva${categoryCount === 1 ? '' : 's'}` : ''} a esta bóveda. Las entradas existentes se conservarán.</p><div class="pin-warning import-plain-warning"><span>!</span><p>El Excel está sin cifrar. Se leerá y cifrará en este dispositivo. Conserva el original solo el tiempo necesario y bórralo cuando compruebes la importación.</p></div><div class="form-actions"><button type="button" class="button button-soft" data-action="cancel-plain-import">Cancelar</button><button type="button" class="button button-primary" data-action="confirm-plain-import">Añadir a mi bóveda</button></div></section></div>`;
  }
  if (state.modal === 'change-master') return `<div class="modal-backdrop" data-action="close-modal"><section class="sheet dialog" data-sheet><div class="sheet-title"><div><p class="eyebrow">SEGURIDAD</p><h2>Cambiar clave maestra</h2></div><button class="icon-button" data-action="close-modal">×</button></div><p class="subtle">La nueva clave protegerá la misma bóveda en este dispositivo y en futuras copias.</p><form id="master-form"><label>Nueva clave maestra<input name="newPin" type="password" inputmode="numeric" minlength="4" maxlength="64" required placeholder="Mínimo 4 caracteres" /></label><label>Repite la clave<input name="confirmPin" type="password" inputmode="numeric" minlength="4" maxlength="64" required placeholder="Vuelve a escribirla" /></label><div class="pin-warning"><span>!</span><p>Un PIN de cuatro dígitos es cómodo, pero una copia cifrada podría atacarse por fuerza bruta. Usa más caracteres si quieres proteger una copia en la nube.</p></div><div class="form-actions"><button type="button" class="button button-soft" data-action="close-modal">Cancelar</button><button class="button button-primary" type="submit">Cambiar clave</button></div></form></section></div>`;
  if (state.modal === 'delete-category') {
    const category = state.categoryDeleteTarget;
    if (!category) return '';
    const count = state.entries.filter((entry) => entry.category === category).length;
    return `<div class="modal-backdrop" data-action="close-modal"><section class="sheet dialog category-delete-dialog" data-sheet><div class="sheet-title"><div><p class="eyebrow">CATEGORÍAS</p><h2>Eliminar categoría</h2></div><button class="icon-button" data-action="close-modal">×</button></div><p class="subtle">“${escapeHtml(category)}” tiene ${count} contraseña${count === 1 ? '' : 's'}. ¿Qué quieres hacer?</p><div class="category-delete-actions"><button type="button" class="button button-soft" data-action="delete-category-uncategorize">Borrar categoría y dejar las contraseñas sin categoría</button><button type="button" class="button button-danger" data-action="delete-category-with-entries">Borrar categoría y todas sus contraseñas</button><button type="button" class="button button-soft" data-action="cancel-category-delete">Cancelar</button></div></section></div>`;
  }
  return '';
}

function renderSetup() {
  return `<div class="lock-screen"><div class="lock-card"><div class="lock-logo"><img src="/icon.svg" alt="" /></div><p class="eyebrow">BÓVEDA PLUS</p><h1>Tu espacio privado</h1><p class="subtle">Crea una clave maestra para cifrar las contraseñas en este dispositivo.</p><form id="setup-form" class="lock-form"><label>Clave maestra<input name="pin" type="password" inputmode="numeric" minlength="4" maxlength="64" required placeholder="Mínimo 4 caracteres" autocomplete="new-password" /><small>Puede ser el mismo PIN que usas para desbloquear tu móvil.</small></label><label>Repite la clave<input name="confirmPin" type="password" inputmode="numeric" minlength="4" maxlength="64" required placeholder="Vuelve a escribirla" autocomplete="new-password" /></label><div class="pin-warning"><span>!</span><p>Con cuatro dígitos será fácil de recordar, pero una frase más larga protege mejor las copias exportadas.</p></div><button class="button button-primary button-wide" type="submit">Crear mi bóveda</button></form><p class="privacy-note">Cero cuentas · Cero sincronización · Solo este dispositivo</p></div></div>`;
}

function renderUnlock() {
  return `<div class="lock-screen"><div class="lock-card"><div class="lock-logo"><img src="/icon.svg" alt="" /></div><p class="eyebrow">BÓVEDA PLUS</p><h1>Bienvenido de nuevo</h1><p class="subtle">Introduce tu clave maestra para desbloquear tus datos.</p><form id="unlock-form" class="lock-form"><label>Clave maestra<input name="pin" type="password" inputmode="numeric" minlength="4" maxlength="64" required placeholder="Tu clave maestra" autocomplete="current-password" /></label><button class="button button-primary button-wide" type="submit">Desbloquear</button></form><p class="privacy-note">Tus datos no salen de este dispositivo.</p></div></div>`;
}

function render() {
  if (!state.record) {
    app.innerHTML = renderSetup();
    return;
  }
  if (!isUnlocked()) {
    app.innerHTML = renderUnlock();
    return;
  }
  const content = state.view === 'add' || state.view === 'edit' ? renderForm() : state.view === 'view' ? renderView() : state.view === 'categories' ? renderCategories() : renderAll();
  app.innerHTML = shell(content);
  const scroller = document.querySelector('.main-content');

  if (scroller) {
    const updateScrollTop = () => {

      const top = scroller.getBoundingClientRect().top;
      const cards = [...scroller.querySelectorAll('.stack > .entry-card')];
      const current = cards.find((card) => card.getBoundingClientRect().bottom > top + 1);
      for (const button of document.querySelectorAll('[data-letter].letter-button')) {
        const active = button.dataset.letter === (current?.dataset.entryLetter || '');
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      }
    };
    scroller.addEventListener('scroll', updateScrollTop, { passive: true });
    updateScrollTop();
  }
}

function showToast(message, type = 'default') {
  document.querySelector('.toast')?.remove();
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 2600);
}

function validatePin(pin) {
  return typeof pin === 'string' && pin.length >= 4 && pin.length <= 64;
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+-=?@';
  const result = [];
  const random = randomBytes(24);
  for (const byte of random) result.push(alphabet[byte % alphabet.length]);
  return result.join('');
}

async function copyPassword(id) {
  touch();
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.password);
    showToast('Contraseña copiada al portapapeles', 'success');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = entry.password;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.append(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
    showToast('Contraseña copiada al portapapeles', 'success');
  }
}

function revealCardPassword(id) {
  const entry = state.entries.find((item) => item.id === id);
  const output = document.querySelector(`[data-card-password="${id}"]`);
  if (!entry || !output) return;
  window.clearTimeout(state.passwordRevealTimer);
  output.textContent = entry.password;
  state.passwordRevealTimer = window.setTimeout(() => {
    output.textContent = maskedPassword(entry.password);
  }, PASSWORD_REVEAL_MS);
}

function revealDetailPassword(id) {
  const entry = state.entries.find((item) => item.id === id);
  const output = document.querySelector(`[data-detail-password="${id}"]`);
  if (!entry || !output) return;
  window.clearTimeout(state.passwordRevealTimer);
  output.textContent = entry.password;
  state.passwordRevealTimer = window.setTimeout(() => {
    output.textContent = maskedPassword(entry.password);
  }, PASSWORD_REVEAL_MS);
}

function downloadBackup() {
  const exportRecord = { ...state.record, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(exportRecord, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `boveda-plus-${new Date().toISOString().slice(0, 10)}.pwvault`;
  anchor.click();
  URL.revokeObjectURL(url);
  state.modal = null;
  render();
  showToast('Copia cifrada descargada', 'success');
}

function openImportPicker(plain = false) {
  const id = plain ? 'plain-import-input' : 'import-input';
  let input = document.querySelector(`#${id}`);
  if (!input) {
    input = document.createElement('input');
    input.id = id;
    input.type = 'file';
    input.accept = plain ? '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : '.pwvault,.json,application/json';
    input.hidden = true;
    input.addEventListener('change', plain ? handlePlainImport : handleImport);
    document.body.append(input);
  }
  input.value = '';
  input.click();
}

const TEMPLATE_HEADERS = ['Nombre', 'URL', 'Nombre de usuario', 'Contraseña', 'Código adicional', 'Notas', 'Categoría', 'Último cambio'];

function plainValue(value) {
  if (value === undefined || value === null) return '';
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function importDate(value) {
  if (value === '' || value === null || value === undefined) return new Date().toISOString();
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number') {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d, parsed.H, parsed.M, Math.floor(parsed.S))).toISOString();
  }
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3])) return date.toISOString();
  }
  throw new Error('la fecha de Último cambio debe tener formato AAAA-MM-DD');
}

function parsePlainWorkbook(workbook) {
  const worksheet = workbook.Sheets['Contraseñas'];
  if (!worksheet) throw new Error('no encuentro la hoja «Contraseñas». Descarga una plantilla vacía desde Bóveda Plus.');
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true, blankrows: true });
  const headers = (rows[0] || []).map((value) => plainValue(value).trim());
  if (TEMPLATE_HEADERS.some((header) => !headers.includes(header))) throw new Error('las columnas no coinciden con la plantilla oficial. Descarga una plantilla vacía desde Bóveda Plus.');

  const entries = [];
  const issues = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const values = TEMPLATE_HEADERS.map((header) => row[headers.indexOf(header)] ?? '');
    if (values.every((value) => plainValue(value).trim() === '')) continue;
    const rowNumber = index + 1;
    if (values.some((_, col) => worksheet[XLSX.utils.encode_cell({ r: index, c: headers.indexOf(TEMPLATE_HEADERS[col]) })]?.f)) {
      issues.push(`fila ${rowNumber}: quita las fórmulas y escribe valores`);
      continue;
    }
    const [rawTitle, rawUrl, rawUsername, rawPassword, rawExtraCode, rawNotes, rawCategory, rawDate] = values;
    const title = plainValue(rawTitle).trim();
    const password = plainValue(rawPassword);
    try {
      entries.push({
        id: crypto.randomUUID(), title, url: plainValue(rawUrl).trim(),
        username: plainValue(rawUsername).trim(), password,
        extraCode: plainValue(rawExtraCode).trim(), notes: plainValue(rawNotes).trim(),
        category: plainValue(rawCategory).trim(),
        lastChangedAt: importDate(rawDate),
      });
    } catch (error) {
      issues.push(`fila ${rowNumber}: ${error.message}`);
    }
  }
  if (issues.length) throw new Error(`Revisa el Excel. ${issues.slice(0, 5).join('; ')}${issues.length > 5 ? `; y ${issues.length - 5} fila(s) más` : ''}.`);
  if (!entries.length) throw new Error('no hay contraseñas para importar.');
  if (entries.length > 2000) throw new Error('el archivo supera el máximo de 2.000 contraseñas por importación.');
  return entries;
}

async function handlePlainImport(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('el Excel supera el límite de 10 MB.');
    if (!file.name.toLocaleLowerCase('es').endsWith('.xlsx')) throw new Error('elige un archivo .xlsx descargado desde Bóveda Plus.');
    const workbook = XLSX.read(await file.arrayBuffer(), { cellDates: true, cellFormula: true });
    state.pendingPlainImport = parsePlainWorkbook(workbook);
    state.modal = 'confirm-plain-import';
    render();
  } catch (error) {
    showToast(error.message.startsWith('Revisa') || error.message.startsWith('no hay') || error.message.startsWith('el archivo') || error.message.startsWith('el Excel') || error.message.startsWith('elige') || error.message.startsWith('no encuentro') || error.message.startsWith('las columnas') ? error.message : 'No se pudo leer el Excel. Descarga una plantilla nueva desde Bóveda Plus.', 'error');
  }
}

async function confirmPlainImport() {
  const pending = state.pendingPlainImport;
  if (!pending?.length) return;
  const oldEntries = state.entries;
  const oldCategories = state.categories;
  const oldRecord = state.record;
  const categoryNames = new Map(oldCategories.map((category) => [category.toLocaleLowerCase('es'), category]));
  for (const category of pending.map((entry) => entry.category).filter(Boolean)) {
    const key = category.toLocaleLowerCase('es');
    if (!categoryNames.has(key)) categoryNames.set(key, category);
  }
  const additions = [...categoryNames.entries()].filter(([key]) => !oldCategories.some((category) => category.toLocaleLowerCase('es') === key)).map(([, name]) => name);
  const imported = pending.map((entry) => ({ ...entry, category: entry.category ? categoryNames.get(entry.category.toLocaleLowerCase('es')) : '' }));
  state.entries = [...oldEntries, ...imported];
  state.categories = [...oldCategories, ...additions];
  try {
    await persistEntries();
    state.pendingPlainImport = null;
    state.modal = null;
    state.view = 'all';
    state.search = '';
    state.categoryFilter = 'all';
    render();
    showToast(`${pending.length} contraseña${pending.length === 1 ? '' : 's'} importada${pending.length === 1 ? '' : 's'} y cifrada`, 'success');
  } catch {
    state.entries = oldEntries;
    state.categories = oldCategories;
    state.record = oldRecord;
    showToast('No se pudo guardar la importación. La bóveda anterior sigue intacta.', 'error');
  }
}

function downloadTemplate() {
  const anchor = document.createElement('a');
  anchor.href = '/plantillas/Plantilla-importacion-Boveda-Plus.xlsx';
  anchor.download = 'Plantilla-importacion-Boveda-Plus.xlsx';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  state.modal = null;
  render();
}

async function handleImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.format !== 'boveda-local-v1' || !parsed.salt || !parsed.wrapped || !parsed.payload) throw new Error('Formato no reconocido');
    const pin = window.prompt('Escribe la clave maestra de esta copia para verificarla:');
    if (!pin) return;
    const dekBytes = await unwrapDek(pin, parsed);
    const decoded = await decryptEntries(dekBytes, parsed.payload);
    const entries = Array.isArray(decoded) ? decoded : decoded?.entries;
    const categories = Array.isArray(decoded) ? [] : decoded?.categories;
    if (!Array.isArray(entries) || !Array.isArray(categories)) throw new Error('Contenido no válido');
    const migratedEntries = migrateEntries(entries);
    const migratedRecord = { ...parsed, payload: await encryptEntries(dekBytes, { entries: migratedEntries, categories }) };
    await writeStoredRecord(migratedRecord);
    state.record = migratedRecord;
    state.dekBytes = dekBytes;
    state.entries = migratedEntries;
    state.categories = [...new Set(categories.map((category) => String(category).trim()).filter(Boolean))];
    state.view = 'all';
    state.modal = null;
    armAutoLock();
    render();
    showToast('Bóveda Plus importada correctamente', 'success');
  } catch (error) {
    showToast(error.message === 'Formato no reconocido' ? 'El archivo no es una copia válida' : 'No se pudo abrir la copia. Revisa la clave maestra.', 'error');
  }
}

async function changeMaster(form) {
  const data = new FormData(form);
  const newPin = String(data.get('newPin') || '');
  const confirmPin = String(data.get('confirmPin') || '');
  if (!validatePin(newPin)) return showToast('La clave debe tener al menos 4 caracteres', 'error');
  if (newPin !== confirmPin) return showToast('Las claves no coinciden', 'error');
  const wrappedInfo = await wrapDek(newPin, state.dekBytes);
  state.record = { ...state.record, salt: wrappedInfo.salt, wrapped: wrappedInfo.wrapped };
  await writeStoredRecord(state.record);
  state.modal = null;
  render();
  showToast('Clave maestra actualizada', 'success');
}

async function saveEntry(form) {
  const data = new FormData(form);
  const previous = state.entries.find((item) => item.id === state.editId);
  const entry = {
    ...previous,
    id: state.editId || crypto.randomUUID(),
    category: String(data.get('category') || '').trim(),
    title: String(data.get('title') || '').trim(),
    url: String(data.get('url') || '').trim(),
    username: String(data.get('username') || '').trim(),
    password: String(data.get('password') || ''),
    extraCode: String(data.get('extraCode') || '').trim(),
    notes: String(data.get('notes') || '').trim(),
    alertsDisabled: data.get('alertsDisabled') === 'on',
    lastChangedAt: new Date().toISOString(),
  };
  if (previous && entry.password === previous.password) entry.lastChangedAt = previous.lastChangedAt;
  else delete entry.alertSnoozedUntil;
  const existingIndex = state.entries.findIndex((item) => item.id === entry.id);
  if (existingIndex >= 0) state.entries.splice(existingIndex, 1, entry);
  else state.entries.unshift(entry);
  await persistEntries();
  state.view = 'all';
  state.editId = null;
  render();
  showToast(existingIndex >= 0 ? 'Contraseña actualizada' : 'Contraseña guardada', 'success');
}

async function deleteEntry() {
  const entry = state.entries.find((item) => item.id === state.editId);
  if (!entry || !window.confirm(`¿Eliminar “${entry.title}”? Esta acción no se puede deshacer.`)) return;
  state.entries = state.entries.filter((item) => item.id !== state.editId);
  await persistEntries();
  state.view = 'all';
  state.editId = null;
  render();
  showToast('Contraseña eliminada', 'success');
}

function requestCategoryDelete(category) {
  if (!state.categories.includes(category)) return;
  state.categoryDeleteTarget = category;
  state.modal = 'delete-category';
  render();
}

async function deleteCategory(category, removeEntries = false) {
  if (!state.categories.includes(category)) return;
  state.categories = state.categories.filter((item) => item !== category);
  state.entries = removeEntries
    ? state.entries.filter((entry) => entry.category !== category)
    : state.entries.map((entry) => entry.category === category ? { ...entry, category: '' } : entry);
  if (state.categoryFilter === category) state.categoryFilter = 'all';
  state.categoryDeleteTarget = null;
  state.modal = null;
  await persistEntries();
  render();
  showToast(removeEntries ? 'Categoría y contraseñas eliminadas' : 'Categoría eliminada; contraseñas conservadas', 'success');
}

async function createCategory(form) {
  const name = String(new FormData(form).get('category') || '').trim();
  if (!name) return;
  if (state.categories.some((category) => category.toLocaleLowerCase() === name.toLocaleLowerCase())) return showToast('Esa categoría ya existe', 'error');
  state.categories.push(name);
  await persistEntries();
  render();
  showToast('Categoría creada', 'success');
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action], [data-view], [data-letter]');
  if (!target) return;
  if (event.target.closest('a')) return;
  touch();
  if (target.dataset.letter !== undefined) {
    const scroller = document.querySelector('.main-content');

    const entry = [...document.querySelectorAll('.stack > .entry-card')].find((card) => card.dataset.entryLetter === target.dataset.letter);
    if (entry) scroller.scrollTo({ top: scroller.scrollTop + entry.getBoundingClientRect().top - scroller.getBoundingClientRect().top, behavior: 'instant' });
    return;
  }
  if (target.dataset.view) {
    state.view = target.dataset.view;
    state.search = '';
    state.editId = null;
    render();
    return;
  }
  const action = target.dataset.action;
  if (action === 'alerts') { state.modal = 'alerts'; refreshAlertsUi(); return; }
  if (action === 'snooze-alert') return snoozeAlert(target.dataset.id);
  if (action === 'close-modal' && state.modal === 'alerts') {
    if (event.target.closest('[data-sheet]') && !target.classList.contains('icon-button')) return;
    state.modal = null;
    refreshAlertsUi();
    return;
  }
  if (action === 'lock') return lockVault();
  if (action === 'menu') { state.modal = 'menu'; return render(); }
  if (action === 'clear-search') {
    state.search = '';
    render();
    document.querySelector('#search-input')?.focus();
    return;
  }
  if (action === 'reset-filters') {
    state.categoryFilter = 'all';
    return render();
  }
  if (action === 'open-category') {
    state.view = 'all';
    state.categoryFilter = target.dataset.category;
    state.search = '';
    return render();
  }
  if (action === 'close-modal') { if (event.target.closest('[data-sheet]') && !target.classList.contains('icon-button')) return; state.modal = null; state.categoryDeleteTarget = null; state.pendingPlainImport = null; return render(); }
  if (action === 'export') return downloadBackup();
  if (action === 'import') return openImportPicker();
  if (action === 'download-template') return downloadTemplate();
  if (action === 'import-plain') return openImportPicker(true);
  if (action === 'confirm-plain-import') return confirmPlainImport();
  if (action === 'cancel-plain-import') { state.pendingPlainImport = null; state.modal = null; return render(); }
  if (action === 'change-master') { state.modal = 'change-master'; return render(); }
  if (action === 'copy') return copyPassword(target.dataset.id);
  if (action === 'reveal-card') return revealCardPassword(target.dataset.id);
  if (action === 'reveal-detail') return revealDetailPassword(target.dataset.id);

  if (action === 'delete-category') return requestCategoryDelete(target.dataset.category);
  if (action === 'cancel-category-delete') { state.modal = null; state.categoryDeleteTarget = null; return render(); }
  if (action === 'delete-category-uncategorize') return deleteCategory(state.categoryDeleteTarget, false);
  if (action === 'delete-category-with-entries') return deleteCategory(state.categoryDeleteTarget, true);
  if (action === 'edit') {
    const entry = state.entries.find((item) => item.id === target.dataset.id);
    if (!entry) return;
    state.modal = null;
    state.editId = entry.id;
    state.view = 'edit';
    return render();
  }
  if (action === 'view') {
    const entry = state.entries.find((item) => item.id === target.dataset.id);
    if (!entry) return;
    state.detailId = entry.id;
    state.detailReturnView = 'all';
    state.view = 'view';
    return render();
  }
  if (action === 'back') {
    state.view = state.view === 'view' ? state.detailReturnView : 'all';
    state.detailId = null;
    state.editId = null;
    return render();
  }
  if (action === 'generate-password') {
    const input = document.querySelector('#entry-password');
    if (input) { input.value = randomPassword(); input.classList.remove('concealed'); window.setTimeout(() => { input.classList.add('concealed'); }, PASSWORD_REVEAL_MS); }
    return;
  }
  if (action === 'toggle-form-password') {
    const input = document.querySelector('#entry-password');
    if (!input) return;
    input.classList.toggle('concealed');
    if (!input.classList.contains('concealed')) { window.clearTimeout(state.passwordRevealTimer); state.passwordRevealTimer = window.setTimeout(() => { input.classList.add('concealed'); }, PASSWORD_REVEAL_MS); }
    return;
  }
  if (action === 'delete-entry') return deleteEntry();
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'category-filter') {
    state.categoryFilter = event.target.value;
    return render();
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  touch();
  try {
    if (event.target.id === 'setup-form') {
      const data = new FormData(event.target);
      const pin = String(data.get('pin') || '');
      const confirmPin = String(data.get('confirmPin') || '');
      if (!validatePin(pin)) return showToast('La clave debe tener al menos 4 caracteres', 'error');
      if (pin !== confirmPin) return showToast('Las claves no coinciden', 'error');
      await createVault(pin);
      armAutoLock();
      render();
      showToast('Bóveda Plus creada en este dispositivo', 'success');
    } else if (event.target.id === 'unlock-form') {
      const pin = String(new FormData(event.target).get('pin') || '');
      await unlockVault(pin);
      armAutoLock();
      render();
      showToast('Bóveda Plus desbloqueada', 'success');
    } else if (event.target.id === 'entry-form') {
      await saveEntry(event.target);
    } else if (event.target.id === 'category-form') {
      await createCategory(event.target);
    } else if (event.target.id === 'master-form') {
      await changeMaster(event.target);
    }
  } catch {
    if (event.target.id === 'unlock-form') showToast('Clave maestra incorrecta', 'error');
    else showToast('No se pudo guardar la información', 'error');
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'search-input') {
    state.search = event.target.value;
    const cursor = event.target.selectionStart;
    render();
    const next = document.querySelector('#search-input');
    next?.focus();
    next?.setSelectionRange(cursor, cursor);
  }
});

document.addEventListener('pointerdown', touch);
document.addEventListener('keydown', touch);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isUnlocked()) refreshAlertsUi();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal === 'alerts') {
    state.modal = null;
    refreshAlertsUi();
  }
});

async function init() {
  try {
    state.record = await readStoredRecord();
    render();
    window.setInterval(() => { if (isUnlocked() && !document.hidden) refreshAlertsUi(); }, 60_000);
    window.dispatchEvent(new Event('boveda:ready'));
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  } catch {
    app.innerHTML = `<div class="lock-screen"><div class="lock-card"><div class="lock-logo">!</div><h1>No se pudo abrir la bóveda</h1><p class="subtle">Este navegador no permite el almacenamiento local necesario para la aplicación.</p></div></div>`;
    window.dispatchEvent(new Event('boveda:ready'));
  }
}

init();
