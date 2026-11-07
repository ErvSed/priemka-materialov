'use strict';

const CENTRAL_API_BASE = 'https://45-81-253-203.sslip.io/priemka-api';
const API_BASE = /(^|\.)github\.io$/i.test(window.location.hostname)
  ? CENTRAL_API_BASE
  : '/priemka-api';
const SESSION_KEY = 'priemka.portal.session.v1';
const HISTORY_LIMIT = 40;

const $ = (id) => document.getElementById(id);

const refs = {
  boot: $('bootScreen'),
  loginView: $('loginView'),
  loginForm: $('loginForm'),
  loginCode: $('loginCode'),
  loginToggle: $('loginToggle'),
  loginError: $('loginError'),
  loginSubmit: $('loginSubmit'),
  appView: $('appView'),
  rolePill: $('rolePill'),
  userName: $('userName'),
  usersBtn: $('usersBtn'),
  logoutBtn: $('logoutBtn'),
  addBtn: $('addBtn'),
  statActive: $('statActive'),
  statUnits: $('statUnits'),
  statArchived: $('statArchived'),
  statSync: $('statSync'),
  tabActive: $('tabActive'),
  tabArchive: $('tabArchive'),
  activeCount: $('activeCount'),
  archiveCount: $('archiveCount'),
  searchInput: $('searchInput'),
  periodSelect: $('periodSelect'),
  importBtn: $('importBtn'),
  exportBtn: $('exportBtn'),
  duplicateNotice: $('duplicateNotice'),
  tableWrap: $('tableWrap'),
  ledgerTable: document.querySelector('.ledger-table'),
  recordsBody: $('recordsBody'),
  emptyState: $('emptyState'),
  emptyTitle: $('emptyTitle'),
  emptyText: $('emptyText'),
  visibleCount: $('visibleCount'),
  materialDialog: $('materialDialog'),
  materialTitle: $('materialTitle'),
  materialForm: $('materialForm'),
  materialDate: $('materialDate'),
  materialName: $('materialName'),
  materialUnit: $('materialUnit'),
  materialQty: $('materialQty'),
  materialNote: $('materialNote'),
  materialError: $('materialError'),
  materialSubmit: $('materialSubmit'),
  archiveDialog: $('archiveDialog'),
  archiveForm: $('archiveForm'),
  archiveTitle: $('archiveTitle'),
  archiveName: $('archiveName'),
  archiveLead: $('archiveLead'),
  archiveConfirm: $('archiveConfirm'),
  usersDialog: $('usersDialog'),
  userCreateForm: $('userCreateForm'),
  newUserName: $('newUserName'),
  createUserBtn: $('createUserBtn'),
  userError: $('userError'),
  newCodeBox: $('newCodeBox'),
  newCodeTitle: $('newCodeTitle'),
  newCodeValue: $('newCodeValue'),
  copyNewCodeBtn: $('copyNewCodeBtn'),
  usersList: $('usersList'),
  refreshUsersBtn: $('refreshUsersBtn'),
  importFile: $('importFile'),
  toastRegion: $('toastRegion')
};

const state = {
  account: null,
  records: [],
  accounts: [],
  view: 'active',
  query: '',
  period: 'all',
  editingId: null,
  archiveId: null,
  archiveMode: 'archive',
  loading: false,
  saving: false,
  pollTimer: null,
  lastSync: null,
  importBusy: false
};

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function readSessionToken() {
  try {
    return window.localStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function writeSessionToken(token) {
  try {
    if (token) window.localStorage.setItem(SESSION_KEY, token);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {
    // Cookie fallback still works when the portal and API share an origin.
  }
}

function clearSessionToken() {
  writeSessionToken('');
}

async function api(path, { method = 'GET', body = null } = {}) {
  const token = readSessionToken();
  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body !== null ? { 'Content-Type': 'application/json' } : {})
      },
      body: body !== null ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет.');
  }

  let payload = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Сервер ответил ошибкой ${response.status}.`;
    throw new ApiError(message, response.status);
  }
  if (!payload || typeof payload !== 'object') {
    throw new ApiError('Сервер вернул некорректный ответ.');
  }
  return payload;
}

/* ---------- Utilities ---------- */

function plural(count, one, few, many) {
  const value = Math.abs(Number(count)) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

function recordWord(count) {
  return plural(count, 'запись', 'записи', 'записей');
}

function todayISO() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function formatDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '—';
  const [year, month, day] = value.split('-');
  return `${day}.${month}.${year}`;
}

function formatQty(value) {
  const qty = Number(value);
  if (!Number.isFinite(qty)) return '—';
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(qty);
}

function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function normalizeSearch(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function normalizeDuplicateText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[\s\u00A0\u202F]+/g, ' ');
}

function normalizeUnit(value) {
  const unit = normalizeDuplicateText(value);
  const aliases = { 'м2': 'м²', 'м3': 'м³', 'кв.м': 'м²', 'куб.м': 'м³' };
  return aliases[unit] || unit.replace(/\.$/u, '');
}

function duplicateSignature(record) {
  const qty = Math.round((Number(record.qty) || 0) * 1000) / 1000;
  return [record.date, normalizeDuplicateText(record.name), normalizeUnit(record.unit), qty].join('\u0000');
}

function duplicateCounts(records) {
  const counts = new Map();
  records.forEach((record) => {
    const signature = duplicateSignature(record);
    counts.set(signature, (counts.get(signature) || 0) + 1);
  });
  return counts;
}

function isAdmin() {
  return state.account?.role === 'admin';
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' toast--error' : ''}`;
  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.textContent = type === 'error' ? '!' : '✓';
  const text = document.createElement('p');
  text.textContent = message;
  toast.append(mark, text);
  refs.toastRegion.append(toast);
  while (refs.toastRegion.children.length > 3) {
    refs.toastRegion.firstElementChild?.remove();
  }
  window.setTimeout(() => toast.remove(), type === 'error' ? 7_000 : 4_500);
}

function setError(element, message = '') {
  element.textContent = message;
  element.hidden = !message;
}

function setButtonBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.disabled = true;
    button.classList.add('is-busy');
  } else {
    button.textContent = button.dataset.label || button.textContent;
    delete button.dataset.label;
    button.disabled = false;
    button.classList.remove('is-busy');
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function replaceChildren(element, children) {
  element.replaceChildren(...children);
}

/* ---------- Auth and session ---------- */

function setLoginError(message = '') {
  setError(refs.loginError, message);
}

function showLogin(message = '') {
  stopPolling();
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close());
  state.account = null;
  state.records = [];
  state.accounts = [];
  state.lastSync = null;
  document.body.dataset.role = '';
  refs.appView.hidden = true;
  refs.loginView.hidden = false;
  refs.boot.hidden = true;
  refs.loginCode.value = '';
  refs.loginCode.type = 'password';
  refs.loginToggle.querySelector('use')?.setAttribute('href', '#i-eye');
  refs.loginToggle.setAttribute('aria-label', 'Показать код');
  setLoginError(message);
  document.title = 'Вход — ПРИЁМКА';
}

function showApp() {
  refs.loginView.hidden = true;
  refs.appView.hidden = false;
  refs.boot.hidden = true;
  document.body.dataset.role = state.account?.role === 'admin' ? 'admin' : 'user';
  refs.rolePill.textContent = isAdmin() ? 'Администратор' : 'Пользователь';
  refs.rolePill.classList.toggle('role-pill--user', !isAdmin());
  refs.userName.textContent = state.account?.name || '—';
  refs.userName.title = state.account?.name || '';
  refs.addBtn.hidden = false;
  clearFilters();
  renderAll();
  startPolling();
  document.title = `${state.account?.name || 'Пользователь'} — ПРИЁМКА`;
}

async function loadSession() {
  try {
    const payload = await api('/session');
    state.account = payload.account;
    await loadRecords();
    if (state.account) showApp();
  } catch (error) {
    if (error.status === 401) {
      clearSessionToken();
      showLogin();
    } else if (error.status) {
      showLogin(error.message);
    } else {
      showLogin();
    }
  } finally {
    refs.boot.hidden = true;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  setLoginError('');
  const code = refs.loginCode.value.trim();
  if (!code) {
    setLoginError('Введите код доступа.');
    refs.loginCode.focus();
    return;
  }

  refs.loginSubmit.disabled = true;
  refs.loginSubmit.textContent = 'Проверяем код…';
  try {
    const payload = await api('/login', { method: 'POST', body: { code } });
    if (payload.sessionToken) writeSessionToken(payload.sessionToken);
    state.account = payload.account;
    await loadRecords();
    if (!state.account) return;
    showApp();
    showToast(`Добро пожаловать, ${state.account.name}.`);
  } catch (error) {
    if (error.status === 401) clearSessionToken();
    setLoginError(error.message || 'Не удалось войти.');
    refs.loginCode.select();
  } finally {
    refs.loginSubmit.disabled = false;
    refs.loginSubmit.textContent = 'Войти в общую базу';
  }
}

async function logout() {
  try {
    await api('/logout', { method: 'POST', body: {} });
  } catch {
    // The local session is discarded even if the network request failed.
  }
  clearSessionToken();
  showLogin();
  showToast('Вы вышли из общей базы.');
}

function handleAuthFailure() {
  clearSessionToken();
  if (!state.account) return;
  state.account = null;
  showLogin('Сессия истекла. Войдите по коду снова.');
}

/* ---------- Data ---------- */

async function loadRecords({ silent = true } = {}) {
  if (!state.account || state.loading || state.saving) return;
  state.loading = true;
  try {
    const payload = await api('/records');
    state.records = Array.isArray(payload.records) ? payload.records : [];
    state.lastSync = new Date();
    renderAll();
  } catch (error) {
    if (error.status === 401) {
      handleAuthFailure();
      return;
    }
    if (!silent) showToast(error.message, 'error');
    if (refs.statSync) refs.statSync.textContent = 'нет связи';
  } finally {
    state.loading = false;
  }
}

async function saveRecords(records) {
  if (state.saving) throw new ApiError('Дождитесь завершения текущего сохранения.');
  state.saving = true;
  try {
    const payload = await api('/records', {
      method: 'POST',
      body: { records }
    });
    state.records = Array.isArray(payload.records) ? payload.records : [];
    state.lastSync = new Date();
    renderAll();
    return true;
  } catch (error) {
    if (error.status === 401) {
      handleAuthFailure();
    }
    throw error;
  } finally {
    state.saving = false;
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible' && state.account && !state.saving) {
      loadRecords();
    }
  }, 10_000);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

/* ---------- Rendering ---------- */

function clearFilters() {
  state.view = 'active';
  state.query = '';
  state.period = 'all';
  refs.searchInput.value = '';
  refs.periodSelect.value = 'all';
}

function filteredRecords() {
  let records = state.records.filter((record) =>
    state.view === 'archive' ? Boolean(record.archivedAt) : !record.archivedAt
  );

  const query = normalizeSearch(state.query);
  if (query) {
    records = records.filter((record) => {
      const haystack = normalizeSearch(`${record.name} ${record.note || ''} ${record.unit}`);
      return haystack.includes(query);
    });
  }

  if (state.period !== 'all') {
    const today = todayISO();
    const cutoffDate = new Date();
    cutoffDate.setHours(0, 0, 0, 0);
    if (state.period !== 'today') {
      cutoffDate.setDate(cutoffDate.getDate() - (Number(state.period) - 1));
    }
    const month = String(cutoffDate.getMonth() + 1).padStart(2, '0');
    const day = String(cutoffDate.getDate()).padStart(2, '0');
    const cutoff = `${cutoffDate.getFullYear()}-${month}-${day}`;
    records = records.filter((record) => record.date >= cutoff && record.date <= today);
  }

  return records.sort((left, right) => {
    const byDate = String(right.date).localeCompare(String(left.date));
    if (byDate !== 0) return byDate;
    return String(right.createdAt).localeCompare(String(left.createdAt));
  });
}

function makeRow(record, duplicateCount) {
  const row = document.createElement('tr');
  if (duplicateCount > 1) row.classList.add('is-duplicate');

  const dateCell = document.createElement('td');
  dateCell.className = 'cell-date';
  dateCell.textContent = formatDate(record.date);
  const dateSub = document.createElement('small');
  dateSub.textContent = state.view === 'archive' && record.archivedAt
    ? `архив ${formatDate(String(record.archivedAt).slice(0, 10))}`
    : '';
  if (dateSub.textContent) dateCell.append(dateSub);

  const nameCell = document.createElement('td');
  nameCell.className = 'cell-name';
  const name = document.createElement('strong');
  name.textContent = record.name;
  if (record.archivedAt) {
    const badge = document.createElement('span');
    badge.className = 'badge badge--archive';
    badge.textContent = 'архив';
    name.append(' ', badge);
  }
  if (duplicateCount > 1) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = duplicateCount > 2 ? `дубль ×${duplicateCount}` : 'дубль';
    badge.title = 'Совпадают дата, материал, единица и количество';
    name.append(' ', badge);
  }
  nameCell.append(name);
  if (record.note) {
    const note = document.createElement('small');
    note.textContent = record.note;
    note.title = record.note;
    nameCell.append(note);
  }

  const unitCell = document.createElement('td');
  unitCell.className = 'cell-unit';
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = record.unit;
  unitCell.append(unit);

  const qtyCell = document.createElement('td');
  qtyCell.className = 'cell-qty';
  const qty = document.createElement('span');
  qty.className = 'qty';
  qty.textContent = formatQty(record.qty);
  qtyCell.append(qty);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'cell-actions';
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'row-action';
  edit.dataset.action = 'edit';
  edit.dataset.id = record.id;
  edit.textContent = 'Изменить';
  actions.append(edit);
  if (isAdmin()) {
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = record.archivedAt
      ? 'row-action row-action--restore'
      : 'row-action row-action--danger';
    archive.dataset.action = record.archivedAt ? 'restore' : 'archive';
    archive.dataset.id = record.id;
    archive.textContent = record.archivedAt ? 'Вернуть' : 'В архив';
    actions.append(archive);
  }
  actionsCell.append(actions);

  row.append(dateCell, nameCell, unitCell, qtyCell, actionsCell);
  return row;
}

function renderStats() {
  const active = state.records.filter((record) => !record.archivedAt);
  const archived = state.records.filter((record) => record.archivedAt);
  const units = new Set(active.map((record) => record.unit));
  refs.activeCount.textContent = String(active.length);
  refs.archiveCount.textContent = String(archived.length);
  refs.statActive.textContent = String(active.length);
  refs.statUnits.textContent = String(units.size);
  refs.statArchived.textContent = String(archived.length);
  refs.statSync.textContent = state.lastSync ? formatDateTime(state.lastSync) : '—';
}

function renderRecords() {
  const records = filteredRecords();
  const counts = duplicateCounts(state.records);
  let duplicateRecords = 0;
  counts.forEach((count) => { if (count > 1) duplicateRecords += count; });
  refs.duplicateNotice.hidden = duplicateRecords === 0;
  refs.duplicateNotice.textContent = duplicateRecords
    ? `Возможные дубли: ${duplicateRecords} ${recordWord(duplicateRecords)}. Совпадают дата, материал, единица и количество.`
    : '';

  refs.ledgerTable.hidden = records.length === 0;
  refs.emptyState.hidden = records.length > 0;
  if (records.length === 0) {
    refs.emptyTitle.textContent = state.view === 'archive' ? 'Архив пуст' : 'Пока пусто';
    refs.emptyText.textContent = state.view === 'archive'
      ? 'Сюда попадут записи, перемещённые в архив.'
      : 'Добавьте первую поставку в общую базу.';
  }

  refs.recordsBody.replaceChildren();
  const fragment = document.createDocumentFragment();
  records.forEach((record) => {
    fragment.append(makeRow(record, counts.get(duplicateSignature(record)) || 0));
  });
  refs.recordsBody.append(fragment);
  refs.visibleCount.textContent = `${records.length} ${recordWord(records.length)}`;
}

function renderTabs() {
  refs.tabActive.classList.toggle('is-active', state.view === 'active');
  refs.tabArchive.classList.toggle('is-active', state.view === 'archive');
  refs.tabActive.setAttribute('aria-pressed', String(state.view === 'active'));
  refs.tabArchive.setAttribute('aria-pressed', String(state.view === 'archive'));
}

function renderAll() {
  renderTabs();
  renderStats();
  renderRecords();
}

/* ---------- Material form ---------- */

function resetMaterialForm() {
  refs.materialForm.reset();
  refs.materialDate.value = todayISO();
  refs.materialError.hidden = true;
  refs.materialError.textContent = '';
  state.editingId = null;
}

function openAddMaterial() {
  resetMaterialForm();
  refs.materialTitle.textContent = 'Новый материал';
  refs.materialSubmit.textContent = 'Добавить';
  refs.materialDialog.showModal();
  window.setTimeout(() => refs.materialName.focus(), 30);
}

function openEditMaterial(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record || record.archivedAt) return;
  resetMaterialForm();
  state.editingId = record.id;
  refs.materialTitle.textContent = 'Изменить материал';
  refs.materialSubmit.textContent = 'Сохранить';
  refs.materialDate.value = record.date;
  refs.materialName.value = record.name;
  refs.materialUnit.value = record.unit;
  refs.materialQty.value = String(record.qty).replace('.', ',');
  refs.materialNote.value = record.note || '';
  refs.materialDialog.showModal();
  window.setTimeout(() => refs.materialName.focus(), 30);
}

function parseQuantity(value) {
  const normalized = String(value || '').trim().replace(/[\s\u00A0\u202F]/g, '').replace(',', '.');
  if (!/^\d{1,9}(?:\.\d{1,3})?$/u.test(normalized)) return null;
  const qty = Number(normalized);
  return qty > 0 && qty <= 999_999_999.999 ? Math.round(qty * 1000) / 1000 : null;
}

function snapshot(record) {
  return {
    date: record.date,
    name: record.name,
    unit: record.unit,
    qty: record.qty,
    note: record.note || ''
  };
}

function appendHistory(history, entry) {
  return [...(Array.isArray(history) ? history : []), entry].slice(-HISTORY_LIMIT);
}

async function handleMaterialSubmit(event) {
  event.preventDefault();
  setError(refs.materialError, '');
  const date = refs.materialDate.value;
  const name = refs.materialName.value.trim();
  const unit = refs.materialUnit.value.trim();
  const note = refs.materialNote.value.trim();
  const qty = parseQuantity(refs.materialQty.value);

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    setError(refs.materialError, 'Укажите дату поступления.');
    refs.materialDate.focus();
    return;
  }
  if (!name) {
    setError(refs.materialError, 'Введите наименование материала.');
    refs.materialName.focus();
    return;
  }
  if (name.length > 200) {
    setError(refs.materialError, 'Наименование не должно превышать 200 символов.');
    refs.materialName.focus();
    return;
  }
  if (!unit) {
    setError(refs.materialError, 'Укажите единицу измерения.');
    refs.materialUnit.focus();
    return;
  }
  if (unit.length > 20) {
    setError(refs.materialError, 'Единица измерения не должна превышать 20 символов.');
    refs.materialUnit.focus();
    return;
  }
  if (qty === null) {
    setError(refs.materialError, 'Количество должно быть больше нуля, до трёх знаков после запятой.');
    refs.materialQty.focus();
    return;
  }
  if (note.length > 500) {
    setError(refs.materialError, 'Примечание не должно превышать 500 символов.');
    refs.materialNote.focus();
    return;
  }

  const now = new Date().toISOString();
  const editing = state.editingId ? state.records.find((item) => item.id === state.editingId) : null;
  let changed;
  let nextRecords;

  if (editing) {
    changed = {
      ...editing,
      date,
      name,
      unit,
      qty,
      note,
      updatedAt: now,
      history: appendHistory(editing.history, {
        action: 'edit',
        at: now,
        by: state.account?.name || 'Пользователь',
        snapshot: snapshot(editing)
      })
    };
    nextRecords = state.records.map((item) => (item.id === editing.id ? changed : item));
  } else {
    changed = {
      id: crypto.randomUUID(),
      date,
      name,
      unit,
      qty,
      note,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      history: [{
        action: 'create',
        at: now,
        by: state.account?.name || 'Пользователь',
        snapshot: { date, name, unit, qty, note }
      }]
    };
    nextRecords = [...state.records, changed];
  }

  setButtonBusy(refs.materialSubmit, true, 'Сохраняем…');
  try {
    await saveRecords(nextRecords);
    refs.materialDialog.close();
    showToast(editing ? 'Материал изменён.' : 'Материал добавлен в общую базу.');
  } catch (error) {
    setError(refs.materialError, error.message);
  } finally {
    setButtonBusy(refs.materialSubmit, false);
  }
}

/* ---------- Archive ---------- */

function openArchive(recordId, mode) {
  if (!isAdmin()) return;
  const record = state.records.find((item) => item.id === recordId);
  if (!record) return;
  if (mode === 'archive' && record.archivedAt) return;
  if (mode === 'restore' && !record.archivedAt) return;
  state.archiveId = record.id;
  state.archiveMode = mode;
  refs.archiveName.textContent = record.name;
  refs.archiveTitle.textContent = mode === 'archive' ? 'Переместить в архив?' : 'Вернуть в реестр?';
  refs.archiveLead.innerHTML = mode === 'archive'
    ? 'Запись <strong id="archiveName">—</strong> останется в базе, но будет скрыта из реестра.'
    : 'Запись <strong id="archiveName">—</strong> снова появится в реестре.';
  refs.archiveName = $('archiveName');
  refs.archiveName.textContent = record.name;
  refs.archiveConfirm.textContent = mode === 'archive' ? 'В архив' : 'Вернуть';
  refs.archiveDialog.showModal();
}

async function handleArchiveSubmit(event) {
  event.preventDefault();
  if (!isAdmin()) return;
  const record = state.records.find((item) => item.id === state.archiveId);
  if (!record) {
    refs.archiveDialog.close();
    return;
  }
  const now = new Date().toISOString();
  const restoring = state.archiveMode === 'restore';
  const changed = {
    ...record,
    archivedAt: restoring ? null : now,
    updatedAt: now,
    history: appendHistory(record.history, {
      action: restoring ? 'restore' : 'archive',
      at: now,
      by: state.account?.name || 'Администратор',
      snapshot: snapshot(record)
    })
  };
  const nextRecords = state.records.map((item) => (item.id === record.id ? changed : item));
  setButtonBusy(refs.archiveConfirm, true, 'Сохраняем…');
  try {
    await saveRecords(nextRecords);
    refs.archiveDialog.close();
    showToast(restoring ? 'Запись возвращена в реестр.' : 'Запись перемещена в архив.');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    setButtonBusy(refs.archiveConfirm, false);
  }
}

/* ---------- Users ---------- */

function usersListRow(account) {
  const row = document.createElement('li');
  row.className = 'user-row';
  const copy = document.createElement('div');
  copy.className = 'user-copy';
  const name = document.createElement('strong');
  name.textContent = account.name;
  const meta = document.createElement('span');
  if (account.role === 'admin') {
    meta.textContent = 'Администратор · полный доступ';
  } else if (account.active) {
    const added = account.createdAt ? formatDate(String(account.createdAt).slice(0, 10)) : '';
    meta.textContent = `Пользователь · добавлен ${added}`;
  } else {
    meta.textContent = 'Доступ отозван';
  }
  copy.append(name, meta);

  const actions = document.createElement('div');
  actions.className = 'user-actions';
  if (account.role === 'admin') {
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.textContent = 'администратор';
    actions.append(pill);
  } else {
    const pill = document.createElement('span');
    pill.className = account.active ? 'pill' : 'pill pill--muted';
    pill.textContent = account.active ? 'активен' : 'отозван';
    actions.append(pill);
    if (account.active) {
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'user-action user-action--reset';
      reset.dataset.reset = account.id;
      reset.textContent = 'Новый код';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'user-action user-action--revoke';
      revoke.dataset.revoke = account.id;
      revoke.dataset.name = account.name;
      revoke.textContent = 'Отозвать';
      actions.append(reset, revoke);
    }
  }
  row.append(copy, actions);
  return row;
}

function renderAccounts() {
  refs.usersList.replaceChildren();
  state.accounts.forEach((account) => {
    refs.usersList.append(usersListRow(account));
  });
  if (state.accounts.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'user-copy';
    empty.textContent = 'Пользователей нет.';
    refs.usersList.append(empty);
  }
}

async function loadAccounts() {
  if (!isAdmin()) return;
  try {
    const payload = await api('/accounts');
    state.accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
    renderAccounts();
  } catch (error) {
    if (error.status === 401) {
      handleAuthFailure();
      return;
    }
    setError(refs.userError, error.message);
  }
}

function showNewCode(name, code) {
  refs.newCodeTitle.textContent = `Код для ${name}`;
  refs.newCodeValue.textContent = code;
  refs.newCodeBox.hidden = false;
}

function openUsers() {
  if (!isAdmin()) return;
  setError(refs.userError, '');
  refs.newCodeBox.hidden = true;
  refs.newCodeValue.textContent = '';
  refs.newUserName.value = '';
  refs.usersDialog.showModal();
  loadAccounts();
}

async function handleCreateUser(event) {
  event.preventDefault();
  if (!isAdmin()) return;
  setError(refs.userError, '');
  const name = refs.newUserName.value.trim();
  if (name.length < 2) {
    setError(refs.userError, 'Введите имя сотрудника.');
    refs.newUserName.focus();
    return;
  }
  setButtonBusy(refs.createUserBtn, true, 'Создаём…');
  try {
    const payload = await api('/accounts', { method: 'POST', body: { name } });
    refs.newUserName.value = '';
    showNewCode(payload.account.name, payload.account.code);
    await loadAccounts();
    showToast('Код создан. Скопируйте его и передайте сотруднику.');
  } catch (error) {
    setError(refs.userError, error.message);
  } finally {
    setButtonBusy(refs.createUserBtn, false);
  }
}

async function resetUserCode(accountId) {
  if (!isAdmin()) return;
  if (!window.confirm('Создать новый код? Старый код сразу перестанет работать, текущая сессия сотрудника завершится.')) return;
  setError(refs.userError, '');
  try {
    const payload = await api(`/accounts/${encodeURIComponent(accountId)}/reset`, {
      method: 'POST',
      body: {}
    });
    showNewCode(payload.account.name, payload.account.code);
    await loadAccounts();
    showToast('Новый код создан. Старый больше не действует.');
  } catch (error) {
    setError(refs.userError, error.message);
  }
}

async function revokeUser(accountId, name) {
  if (!isAdmin()) return;
  if (!window.confirm(`Отозвать доступ пользователя ${name}? Его сессия завершится, код перестанет работать.`)) return;
  setError(refs.userError, '');
  try {
    await api(`/accounts/${encodeURIComponent(accountId)}/revoke`, { method: 'POST', body: {} });
    await loadAccounts();
    showToast(`Доступ пользователя ${name} отозван.`);
  } catch (error) {
    setError(refs.userError, error.message);
  }
}

/* ---------- CSV ---------- */

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/u.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!isAdmin()) return;
  const records = filteredRecords();
  if (records.length === 0) {
    showToast('В текущей выборке нет записей.', 'error');
    return;
  }
  const rows = [[
    'Дата поступления', 'Наименование', 'Единица', 'Количество', 'Примечание',
    'Статус', 'Дата архивации', 'Создано', 'Изменено'
  ]];
  records.forEach((record) => {
    rows.push([
      formatDate(record.date),
      record.name,
      record.unit,
      formatQty(record.qty),
      record.note || '',
      record.archivedAt ? 'В архиве' : 'В реестре',
      record.archivedAt ? formatDateTime(record.archivedAt) : '',
      record.createdAt ? formatDateTime(record.createdAt) : '',
      record.updatedAt ? formatDateTime(record.updatedAt) : ''
    ]);
  });
  const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `priemka-${state.view === 'archive' ? 'arhiv' : 'reestr'}-${todayISO()}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_500);
  showToast(`Экспортировано ${records.length} ${recordWord(records.length)}.`);
}

function detectDelimiter(text) {
  const line = text.split(/\r?\n/u).find((value) => value.trim()) || '';
  let semicolons = 0;
  let commas = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && char === ';') semicolons += 1;
    else if (!quoted && char === ',') commas += 1;
  }
  return semicolons >= commas ? ';' : ',';
}

function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (quoted) throw new Error('В CSV незакрытая кавычка.');
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim()));
}

function parseImportDate(value) {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  const match = text.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/u);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) return null;
  const paddedMonth = String(month).padStart(2, '0');
  const paddedDay = String(day).padStart(2, '0');
  return `${year}-${paddedMonth}-${paddedDay}`;
}

function normalizeHeader(value) {
  return normalizeDuplicateText(value).replace(/:+$/u, '').trim();
}

function importColumnIndexes(headers) {
  const normalized = headers.map(normalizeHeader);
  const aliases = {
    date: ['дата поступления', 'дата', 'date'],
    name: ['наименование', 'материал', 'name'],
    unit: ['единица', 'единица измерения', 'ед. изм.', 'ед.изм.', 'unit'],
    qty: ['количество', 'кол-во', 'qty', 'quantity'],
    note: ['примечание', 'note'],
    status: ['статус', 'status'],
    archived: ['дата архивации', 'дата архива', 'archivedat']
  };
  const indexes = {};
  Object.entries(aliases).forEach(([key, values]) => {
    const index = normalized.findIndex((header) => values.includes(header));
    if (index !== -1) indexes[key] = index;
  });
  if (['date', 'name', 'unit', 'qty'].some((key) => indexes[key] === undefined)) {
    throw new Error('В CSV нужны колонки: дата поступления, наименование, единица, количество.');
  }
  return indexes;
}

async function handleImportFile(file) {
  if (!file || !isAdmin() || state.importBusy) return;
  if (file.size > 10 * 1024 * 1024) {
    showToast('Файл больше 10 МБ.', 'error');
    return;
  }
  state.importBusy = true;
  try {
    const text = (await file.text()).replace(/^\uFEFF/u, '');
    if (!text.trim()) throw new Error('CSV пуст.');
    const delimiter = detectDelimiter(text);
    const table = parseCsv(text, delimiter);
    if (table.length < 2) throw new Error('В CSV нет строк с данными.');
    if (table.length - 1 > 5000) throw new Error('Слишком много строк для импорта.');
    const columns = importColumnIndexes(table[0]);
    const read = (cells, key) => (
      columns[key] === undefined ? '' : String(cells[columns[key]] ?? '').trim()
    );
    const existing = new Set(state.records.map(duplicateSignature));
    let invalid = 0;
    let duplicates = 0;
    const imported = [];
    const now = new Date().toISOString();
    const by = state.account?.name || 'Администратор';

    for (const cells of table.slice(1)) {
      const date = parseImportDate(read(cells, 'date'));
      const name = read(cells, 'name');
      const unit = read(cells, 'unit');
      const qty = parseQuantity(read(cells, 'qty'));
      const note = read(cells, 'note');
      if (!date || !name || !unit || qty === null || name.length > 200 || unit.length > 20 || note.length > 500) {
        invalid += 1;
        continue;
      }
      const archivedText = read(cells, 'archived');
      const status = read(cells, 'status');
      const archived = /архив/iu.test(status) || Boolean(archivedText);
      const record = {
        id: crypto.randomUUID(),
        date,
        name,
        unit,
        qty,
        note,
        createdAt: now,
        updatedAt: now,
        archivedAt: archived ? now : null,
        history: [{
          action: 'create',
          at: now,
          by,
          snapshot: { date, name, unit, qty, note }
        }]
      };
      const signature = duplicateSignature(record);
      if (existing.has(signature)) {
        duplicates += 1;
        continue;
      }
      existing.add(signature);
      imported.push(record);
    }

    if (imported.length === 0) {
      showToast(`Новых записей нет. Дубликатов: ${duplicates}, ошибок: ${invalid}.`, 'error');
      return;
    }
    const confirmed = window.confirm(
      `Добавить ${imported.length} ${recordWord(imported.length)}? ` +
      `Дубликатов пропущено: ${duplicates}. Ошибочных строк: ${invalid}.`
    );
    if (!confirmed) return;
    await saveRecords([...state.records, ...imported]);
    showToast(
      `Импортировано ${imported.length} ${recordWord(imported.length)}. ` +
      `Пропущено дублей: ${duplicates}. Ошибок: ${invalid}.`,
      'success'
    );
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    state.importBusy = false;
    refs.importFile.value = '';
  }
}

/* ---------- Events ---------- */

function bindEvents() {
  refs.loginForm.addEventListener('submit', handleLogin);
  refs.loginToggle.addEventListener('click', () => {
    const show = refs.loginCode.type === 'password';
    refs.loginCode.type = show ? 'text' : 'password';
    refs.loginToggle.querySelector('use')?.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
    refs.loginToggle.setAttribute('aria-label', show ? 'Скрыть код' : 'Показать код');
    refs.loginCode.focus();
  });

  refs.logoutBtn.addEventListener('click', logout);
  refs.addBtn.addEventListener('click', openAddMaterial);
  refs.usersBtn.addEventListener('click', openUsers);
  refs.materialForm.addEventListener('submit', handleMaterialSubmit);
  refs.archiveForm.addEventListener('submit', handleArchiveSubmit);

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = $(button.dataset.close);
      if (dialog?.open) dialog.close();
    });
  });

  refs.tabActive.addEventListener('click', () => {
    state.view = 'active';
    renderAll();
  });
  refs.tabArchive.addEventListener('click', () => {
    state.view = 'archive';
    renderAll();
  });
  refs.searchInput.addEventListener('input', () => {
    state.query = refs.searchInput.value;
    renderRecords();
  });
  refs.periodSelect.addEventListener('change', () => {
    state.period = refs.periodSelect.value;
    renderRecords();
  });

  refs.recordsBody.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('button[data-action]')
      : null;
    if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'edit') openEditMaterial(id);
    if (action === 'archive') openArchive(id, 'archive');
    if (action === 'restore') openArchive(id, 'restore');
  });

  refs.userCreateForm.addEventListener('submit', handleCreateUser);
  refs.refreshUsersBtn.addEventListener('click', loadAccounts);
  refs.usersList.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button') : null;
    if (!target) return;
    if (target.dataset.reset) resetUserCode(target.dataset.reset);
    if (target.dataset.revoke) revokeUser(target.dataset.revoke, target.dataset.name || 'сотрудника');
  });
  refs.copyNewCodeBtn.addEventListener('click', async () => {
    const copied = await copyText(refs.newCodeValue.textContent.trim());
    showToast(copied ? 'Код скопирован.' : 'Не удалось скопировать. Выделите код вручную.', copied ? 'success' : 'error');
  });
  refs.newUserName.addEventListener('input', () => setError(refs.userError, ''));

  refs.importBtn.addEventListener('click', () => {
    if (!isAdmin()) return;
    refs.importFile.click();
  });
  refs.exportBtn.addEventListener('click', exportCsv);
  refs.importFile.addEventListener('change', () => {
    const file = refs.importFile.files?.[0];
    if (file) handleImportFile(file);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.account) loadRecords();
  });
  window.addEventListener('focus', () => {
    if (state.account) loadRecords();
  });
  window.addEventListener('online', () => {
    if (state.account) loadRecords({ silent: false });
  });
}

bindEvents();
loadSession();
