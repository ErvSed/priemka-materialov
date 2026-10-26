'use strict';

/* ПРИЁМКА — локальный реестр материалов.
   The entire vault is encrypted in the browser with a key derived from the
   user's password. There is deliberately no hard-delete code path. */

const STORAGE_KEY = 'priemka.account.v1';
const SESSION_KEY = 'priemka.session.v1';
const PBKDF2_ITERATIONS = 310_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const INACTIVITY_MS = 30 * 60 * 1000;
const HISTORY_LIMIT = 40;
const UNLOCK_MARKER = 'PRIEMKA_UNLOCK_V1';
const APP_VERSION = '1.1.0';
const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
const MAIL_REQUEST_TIMEOUT_MS = 25_000;
const MAIL_STATUS_TIMEOUT_MS = 10_000;
const MAIL_SYNC_DEBOUNCE_MS = 1_200;
const MAIL_TOKEN_MIN_LENGTH = 24;
const MAIL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const MAIL_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAIL_FREQUENCIES = new Set(['daily', 'weekly', 'monthly']);
const MAIL_RANGES = new Set(['today', '7', '30', 'all']);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const byId = (id) => document.getElementById(id);

const refs = {
  bootScreen: byId('bootScreen'),
  authView: byId('authView'),
  appView: byId('appView'),

  authStatusLabel: byId('authStatusLabel'),
  authKicker: byId('authKicker'),
  authTitle: byId('authTitle'),
  authSubtitle: byId('authSubtitle'),
  authForm: byId('authForm'),
  usernameField: byId('usernameField'),
  authUsername: byId('authUsername'),
  authPassword: byId('authPassword'),
  authConfirm: byId('authConfirm'),
  confirmField: byId('confirmField'),
  authHint: byId('authHint'),
  authError: byId('authError'),
  authSubmit: byId('authSubmit'),
  authSubmitText: byId('authSubmitText'),
  authWarning: byId('authWarning'),
  authWarningText: byId('authWarningText'),
  authSwitch: byId('authSwitch'),
  restoreBlock: byId('restoreBlock'),
  restoreLink: byId('restoreLink'),
  restoreFile: byId('restoreFile'),
  restoreSelected: byId('restoreSelected'),
  restoreFileName: byId('restoreFileName'),
  restoreFileMeta: byId('restoreFileMeta'),
  cancelRestore: byId('cancelRestore'),

  brandLink: byId('brandLink'),
  accountName: byId('accountName'),
  avatarInitial: byId('avatarInitial'),
  userChip: byId('userChip'),
  lockBtn: byId('lockBtn'),
  settingsBtn: byId('settingsBtn'),

  todayLabel: byId('todayLabel'),
  addBtn: byId('addBtn'),
  statActive: byId('statActive'),
  statActiveLabel: byId('statActiveLabel'),
  statWeek: byId('statWeek'),
  statWeekLabel: byId('statWeekLabel'),
  statUnits: byId('statUnits'),
  statUnitsLabel: byId('statUnitsLabel'),
  statArchived: byId('statArchived'),
  statArchivedLabel: byId('statArchivedLabel'),

  tabActive: byId('tabActive'),
  tabArchive: byId('tabArchive'),
  activeCount: byId('activeCount'),
  archiveCount: byId('archiveCount'),
  searchInput: byId('searchInput'),
  periodSelect: byId('periodSelect'),
  exportBtn: byId('exportBtn'),
  unitTotals: byId('unitTotals'),
  totalsEmpty: byId('totalsEmpty'),
  tableWrap: byId('tableWrap'),
  recordsBody: byId('recordsBody'),
  emptyState: byId('emptyState'),
  emptyTitle: byId('emptyTitle'),
  emptyText: byId('emptyText'),
  emptyAction: byId('emptyAction'),
  visibleCount: byId('visibleCount'),

  materialDialog: byId('materialDialog'),
  materialKicker: byId('materialKicker'),
  materialTitle: byId('materialTitle'),
  materialSubtitle: byId('materialSubtitle'),
  materialForm: byId('materialForm'),
  materialId: byId('materialId'),
  materialDate: byId('materialDate'),
  materialName: byId('materialName'),
  materialUnit: byId('materialUnit'),
  materialQty: byId('materialQty'),
  materialNote: byId('materialNote'),
  materialError: byId('materialError'),
  materialSubmit: byId('materialSubmit'),
  historyDetails: byId('historyDetails'),
  historyCount: byId('historyCount'),
  historyList: byId('historyList'),

  archiveDialog: byId('archiveDialog'),
  archiveRecordName: byId('archiveRecordName'),
  archiveForm: byId('archiveForm'),
  archivePassword: byId('archivePassword'),
  archiveError: byId('archiveError'),
  archiveSubmit: byId('archiveSubmit'),

  settingsDialog: byId('settingsDialog'),
  settingsAvatar: byId('settingsAvatar'),
  settingsUsername: byId('settingsUsername'),
  settingsLockBtn: byId('settingsLockBtn'),
  settingsLockLink: byId('settingsLockLink'),
  settingsExportBtn: byId('settingsExportBtn'),
  backupBtn: byId('backupBtn'),
  mailSummary: byId('mailSummary'),
  mailStatusDot: byId('mailStatusDot'),
  mailStatusTitle: byId('mailStatusTitle'),
  mailStatusText: byId('mailStatusText'),
  mailConfigureBtn: byId('mailConfigureBtn'),
  mailEditor: byId('mailEditor'),
  mailForm: byId('mailForm'),
  mailEnabled: byId('mailEnabled'),
  mailEmail: byId('mailEmail'),
  mailFrequency: byId('mailFrequency'),
  mailWeekdayField: byId('mailWeekdayField'),
  mailWeekday: byId('mailWeekday'),
  mailMonthDayField: byId('mailMonthDayField'),
  mailMonthDay: byId('mailMonthDay'),
  mailTime: byId('mailTime'),
  mailRange: byId('mailRange'),
  mailTimezoneLabel: byId('mailTimezoneLabel'),
  mailServerDetails: byId('mailServerDetails'),
  mailServerUrl: byId('mailServerUrl'),
  mailToken: byId('mailToken'),
  mailError: byId('mailError'),
  mailSaveBtn: byId('mailSaveBtn'),
  mailTestBtn: byId('mailTestBtn'),
  mailTestLabel: byId('mailTestLabel'),
  passwordForm: byId('passwordForm'),
  currentPassword: byId('currentPassword'),
  newPassword: byId('newPassword'),
  newPasswordConfirm: byId('newPasswordConfirm'),
  passwordError: byId('passwordError'),
  passwordSubmit: byId('passwordSubmit'),

  toastRegion: byId('toastRegion')
};

const state = {
  account: null,
  key: null,
  username: '',
  records: [],
  view: 'active',
  query: '',
  period: 'all',
  authMode: 'setup',
  pendingRestore: null,
  pendingArchiveId: null,
  editingId: null,
  sessionExpiresAt: null,
  lastActivityAt: 0,
  inactivityTimer: null,
  mail: null,
  mailRemoteStatus: null,
  mailSyncTimer: null
};

const busy = {
  auth: false,
  material: false,
  archive: false,
  password: false,
  mail: false
};

const mailAbortControllers = new Set();

class AppError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AppError';
  }
}

/* ---------- Formatters ---------- */

const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});
const humanDateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long'
});
const weekdayFormatter = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const dayMonthFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit'
});
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
});
const todayFormatter = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long'
});
const qtyFormatter = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
  minimumFractionDigits: 0
});
const csvQtyFormatter = new Intl.NumberFormat('ru-RU', {
  useGrouping: false,
  maximumFractionDigits: 3,
  minimumFractionDigits: 0
});

const UNIT_ORDER = ['шт', 'м', 'м²', 'м³', 'кг', 'т', 'компл.', 'упак.', 'рул.', 'меш.', 'л', 'лист'];
const WEEK_DAYS = 7;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function toISOdate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function todayISO() {
  return toISOdate(new Date());
}

function dateFromISO(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function isValidDateISO(value) {
  return dateFromISO(value) !== null;
}

function isValidTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function formatDate(value) {
  const date = dateFromISO(value);
  return date ? dateFormatter.format(date) : '—';
}

function formatHumanDate(date) {
  return humanDateFormatter.format(date);
}

function formatQty(value) {
  return qtyFormatter.format(Number(value) || 0);
}

function relativeDayLabel(value) {
  const target = dateFromISO(value);
  if (!target) {
    return '';
  }
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (diff === 0) return 'сегодня';
  if (diff === -1) return 'вчера';
  if (diff === 1) return 'завтра';
  if (Math.abs(diff) <= WEEK_DAYS) return weekdayFormatter.format(target);
  if (target.getFullYear() === now.getFullYear()) return humanDateFormatter.format(target);
  return String(target.getFullYear());
}

function formatArchivedSub(timestamp) {
  if (!isValidTimestamp(timestamp)) {
    return 'в архиве';
  }
  return `в архиве ${dayMonthFormatter.format(new Date(timestamp))}`;
}

function pluralRu(count, one, few, many) {
  const n = Math.abs(Number(count)) % 100;
  const n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}

function recordWord(count) {
  return pluralRu(count, 'запись', 'записи', 'записей');
}

function entryWord(count) {
  return pluralRu(count, 'запись', 'записи', 'записей');
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function setTodayLabels() {
  refs.todayLabel.textContent = capitalize(todayFormatter.format(new Date()));
}

function normalizeSearch(value) {
  return String(value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .trim();
}

/* ---------- Mail settings ---------- */

function getBrowserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function isValidTimeZoneName(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone) return false;
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function createDefaultMailSettings() {
  return {
    enabled: false,
    email: '',
    frequency: 'weekly',
    weekday: 5,
    dayOfMonth: 1,
    time: '18:00',
    timezone: getBrowserTimeZone(),
    range: '7',
    serverUrl: '',
    token: '',
    attachArchive: true
  };
}

function isValidMailEmail(value) {
  return typeof value === 'string' && value.length <= 254 && MAIL_EMAIL_RE.test(value);
}

function normalizeMailSettings(raw) {
  const defaults = createDefaultMailSettings();
  if (!raw || typeof raw !== 'object') {
    return defaults;
  }

  const email = typeof raw.email === 'string' ? raw.email.trim().slice(0, 254) : '';
  const frequency = MAIL_FREQUENCIES.has(raw.frequency) ? raw.frequency : defaults.frequency;
  const weekdayValue = Number(raw.weekday);
  const weekday = Number.isInteger(weekdayValue) && weekdayValue >= 1 && weekdayValue <= 7
    ? weekdayValue
    : defaults.weekday;
  const dayValue = Number(raw.dayOfMonth);
  const dayOfMonth = Number.isInteger(dayValue) && dayValue >= 1 && dayValue <= 28
    ? dayValue
    : defaults.dayOfMonth;
  const time = typeof raw.time === 'string' && MAIL_TIME_RE.test(raw.time)
    ? raw.time
    : defaults.time;
  const timezone = isValidTimeZoneName(raw.timezone) ? raw.timezone : defaults.timezone;
  const range = MAIL_RANGES.has(String(raw.range)) ? String(raw.range) : defaults.range;
  const serverUrl = typeof raw.serverUrl === 'string' ? raw.serverUrl.trim() : '';
  const token = typeof raw.token === 'string' ? raw.token.trim() : '';

  return {
    enabled: raw.enabled === true,
    email,
    frequency,
    weekday,
    dayOfMonth,
    time,
    timezone,
    range,
    serverUrl,
    token,
    attachArchive: true
  };
}

function mailConnectionConfigured(mail) {
  return Boolean(
    mail &&
    typeof mail.serverUrl === 'string' &&
    mail.serverUrl.length > 0 &&
    typeof mail.token === 'string' &&
    mail.token.length >= MAIL_TOKEN_MIN_LENGTH
  );
}

function mailConfigurationReady(mail) {
  return Boolean(
    mail &&
    mail.enabled &&
    isValidMailEmail(mail.email) &&
    MAIL_FREQUENCIES.has(mail.frequency) &&
    MAIL_RANGES.has(String(mail.range)) &&
    MAIL_TIME_RE.test(mail.time) &&
    isValidTimeZoneName(mail.timezone) &&
    (mail.frequency !== 'weekly' || (Number.isInteger(mail.weekday) && mail.weekday >= 1 && mail.weekday <= 7)) &&
    (mail.frequency !== 'monthly' || (Number.isInteger(mail.dayOfMonth) && mail.dayOfMonth >= 1 && mail.dayOfMonth <= 28)) &&
    mailConnectionConfigured(mail)
  );
}

function formatMailRangeLabel(range) {
  return {
    today: 'за сегодня',
    7: 'за последние 7 дней',
    30: 'за последние 30 дней',
    all: 'за всё время'
  }[String(range)] || 'за выбранный период';
}

function normalizeMailServerUrl(value, { required = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) {
    if (required) {
      throw new AppError('Укажите адрес почтового сервиса.');
    }
    return '';
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError('Адрес почтового сервиса указан неверно.');
  }

  if (parsed.username || parsed.password) {
    throw new AppError('В адресе сервиса не должно быть логина и пароля.');
  }
  if (parsed.search || parsed.hash) {
    throw new AppError('Адрес почтового сервиса не должен содержать параметры или якорь.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname))) {
    throw new AppError('Используйте HTTPS-адрес почтового сервиса. HTTP допускается только для localhost.');
  }

  const normalized = parsed.toString().replace(/\/+$/, '');
  return normalized;
}

function updateMailFrequencyFields() {
  const frequency = refs.mailFrequency.value;
  refs.mailWeekdayField.hidden = frequency !== 'weekly';
  refs.mailMonthDayField.hidden = frequency !== 'monthly';
}

function setMailStatus(stateName, title, text) {
  if (!refs.mailSummary) return;
  refs.mailSummary.dataset.state = stateName;
  refs.mailStatusTitle.textContent = title;
  refs.mailStatusText.textContent = text;
  refs.mailStatusText.title = text;
}

function setMailEditorOpen(open) {
  refs.mailEditor.hidden = !open;
  refs.mailConfigureBtn.setAttribute('aria-expanded', String(open));
  refs.mailConfigureBtn.textContent = open ? 'Свернуть' : 'Настроить';
}

function populateMailForm() {
  const mail = normalizeMailSettings(state.mail);
  refs.mailEnabled.checked = mail.enabled;
  refs.mailEmail.value = mail.email;
  refs.mailFrequency.value = mail.frequency;
  refs.mailWeekday.value = String(mail.weekday);
  refs.mailMonthDay.value = String(mail.dayOfMonth);
  refs.mailTime.value = mail.time;
  refs.mailRange.value = mail.range;
  refs.mailServerUrl.value = mail.serverUrl;
  refs.mailToken.value = mail.token;
  refs.mailTimezoneLabel.textContent = `${mail.timezone}${mail.timezone === getBrowserTimeZone() ? ' · ваш часовой пояс' : ''}`;
  refs.mailServerDetails.open = !mailConnectionConfigured(mail);
  updateMailFrequencyFields();
  setError(refs.mailError, '');
}

function applyLocalMailStatus() {
  const mail = normalizeMailSettings(state.mail);
  if (!mail.enabled) {
    if (mail.email || mailConnectionConfigured(mail)) {
      setMailStatus(
        'disabled',
        'Автоотправка выключена',
        mail.email ? `Почта: ${mail.email}` : 'Настройки сохранены'
      );
    } else {
      setMailStatus('off', 'Не настроено', 'Автоматические письма выключены');
    }
    return;
  }

  if (!mailConfigurationReady(mail)) {
    setMailStatus('error', 'Не хватает настроек', 'Заполните адрес, расписание и данные сервера');
    return;
  }

  setMailStatus(
    'connected',
    'Автоотправка включена',
    `${describeMailSchedule(mail)} · ${mail.email}`
  );
}

function describeMailSchedule(mail) {
  const weekdays = {
    1: 'каждый понедельник',
    2: 'каждый вторник',
    3: 'каждую среду',
    4: 'каждый четверг',
    5: 'каждую пятницу',
    6: 'каждую субботу',
    7: 'каждое воскресенье'
  };
  if (mail.frequency === 'daily') {
    return `ежедневно в ${mail.time}`;
  }
  if (mail.frequency === 'weekly') {
    return `${weekdays[mail.weekday] || 'еженедельно'} в ${mail.time}`;
  }
  return `${mail.dayOfMonth}-го числа каждого месяца в ${mail.time}`;
}

function applyRemoteMailStatus(status) {
  state.mailRemoteStatus = status || null;
  if (!status) {
    applyLocalMailStatus();
    return;
  }

  if (!status.enabled) {
    setMailStatus(
      'disabled',
      'Автоотправка выключена',
      status.email ? `Почта: ${status.email}` : 'На сервере расписание отключено'
    );
    return;
  }

  if (!status.smtpConfigured) {
    setMailStatus(
      'error',
      'SMTP не настроен на сервере',
      'Заполните SMTP-параметры в окружении почтового сервиса'
    );
    return;
  }

  if (status.lastError) {
    setMailStatus('error', 'Ошибка отправки на сервере', status.lastError);
    return;
  }

  const next = status.nextRunLocal
    ? `Следующее письмо: ${status.nextRunLocal}`
    : 'Расписание ожидает данных из приложения';
  setMailStatus(
    'connected',
    'Автоотправка включена',
    `${next} · ${status.email || ''}`.trim()
  );
}

function stopMailActivity() {
  if (state.mailSyncTimer) {
    clearTimeout(state.mailSyncTimer);
    state.mailSyncTimer = null;
  }
  for (const controller of mailAbortControllers) {
    controller.abort();
  }
  mailAbortControllers.clear();
}

function readMailForm({ requireConnection = false } = {}) {
  const enabled = refs.mailEnabled.checked;
  const email = refs.mailEmail.value.trim();
  const frequency = refs.mailFrequency.value;
  const time = refs.mailTime.value;
  const range = refs.mailRange.value;
  const timezone = getBrowserTimeZone();
  const serverUrl = normalizeMailServerUrl(refs.mailServerUrl.value, { required: enabled || requireConnection });
  const token = refs.mailToken.value.trim();

  if (enabled || requireConnection) {
    if (!email) {
      throw new AppError('Введите email получателя.');
    }
    if (!isValidMailEmail(email)) {
      throw new AppError('Email получателя указан неверно.');
    }
    if (!time || !MAIL_TIME_RE.test(time)) {
      throw new AppError('Укажите время отправки.');
    }
    if (!MAIL_FREQUENCIES.has(frequency)) {
      throw new AppError('Выберите частоту отправки.');
    }
    if (!MAIL_RANGES.has(String(range))) {
      throw new AppError('Выберите период данных.');
    }
    if (!token || token.length < MAIL_TOKEN_MIN_LENGTH) {
      throw new AppError(`Ключ доступа должен содержать не менее ${MAIL_TOKEN_MIN_LENGTH} символов.`);
    }
    if (!serverUrl) {
      throw new AppError('Укажите адрес почтового сервиса.');
    }
  } else {
    if (email && !isValidMailEmail(email)) {
      throw new AppError('Email получателя указан неверно.');
    }
    if (time && !MAIL_TIME_RE.test(time)) {
      throw new AppError('Укажите корректное время отправки.');
    }
    if (token && token.length < MAIL_TOKEN_MIN_LENGTH) {
      throw new AppError(`Ключ доступа должен содержать не менее ${MAIL_TOKEN_MIN_LENGTH} символов.`);
    }
  }

  const weekday = Number(refs.mailWeekday.value);
  const dayOfMonth = Number(refs.mailMonthDay.value);

  if (frequency === 'weekly' && (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
    throw new AppError('Выберите день недели.');
  }
  if (frequency === 'monthly' && (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28)) {
    throw new AppError('Выберите день месяца с 1 по 28.');
  }

  return {
    enabled,
    email,
    frequency,
    weekday,
    dayOfMonth,
    time: time || '18:00',
    timezone,
    range,
    serverUrl,
    token,
    attachArchive: true
  };
}

function toBackendMailConfig(mail) {
  return {
    enabled: Boolean(mail.enabled),
    email: mail.email,
    frequency: mail.frequency,
    time: mail.time,
    timezone: mail.timezone,
    weekday: mail.frequency === 'weekly' ? mail.weekday : null,
    dayOfMonth: mail.frequency === 'monthly' ? mail.dayOfMonth : null,
    range: mail.range,
    attachArchive: true
  };
}

function buildMailSnapshot() {
  const active = state.records
    .filter((record) => !record.archivedAt)
    .map((record) => ({
      date: record.date,
      name: record.name,
      unit: record.unit,
      qty: record.qty,
      note: record.note || ''
    }));

  return {
    username: state.username,
    generatedAt: new Date().toISOString(),
    archivedCount: state.records.filter((record) => record.archivedAt).length,
    records: active
  };
}

function buildMailSyncBody(mail, { enabled = mail.enabled } = {}) {
  return {
    config: toBackendMailConfig({ ...mail, enabled }),
    snapshot: buildMailSnapshot(),
    archive: makeBackupEnvelope(state.account)
  };
}

async function mailApiRequest(pathname, { method = 'GET', body = null, mail, timeout = MAIL_REQUEST_TIMEOUT_MS } = {}) {
  const config = mail || state.mail;
  const serverUrl = normalizeMailServerUrl(config?.serverUrl);
  if (!serverUrl) {
    throw new AppError('Почтовый сервис не подключён. Укажите адрес сервера.');
  }
  if (!config?.token) {
    throw new AppError('Не указан ключ доступа к почтовому сервису.');
  }

  const controller = new AbortController();
  mailAbortControllers.add(controller);
  const timeoutId = window.setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${serverUrl}${pathname}`, {
      method,
      cache: 'no-store',
      credentials: 'omit',
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      throw new AppError(data?.error || `Почтовый сервис ответил ошибкой ${response.status}.`);
    }
    if (!data || typeof data !== 'object') {
      throw new AppError('Почтовый сервис вернул некорректный ответ.');
    }
    return data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error.name === 'AbortError') {
      throw new AppError('Почтовый сервис не ответил вовремя. Проверьте адрес и подключение.');
    }
    console.error(error);
    throw new AppError('Не удалось связаться с почтовым сервисом. Проверьте адрес и CORS.');
  } finally {
    window.clearTimeout(timeoutId);
    mailAbortControllers.delete(controller);
  }
}

async function syncMailSchedule(mail = state.mail) {
  if (!mailConfigurationReady(mail)) {
    throw new AppError('Настройки почты заполнены не полностью.');
  }
  const status = await mailApiRequest('/api/sync', {
    method: 'POST',
    body: buildMailSyncBody(mail),
    mail
  });
  applyRemoteMailStatus(status);
  return status;
}

async function disableMailSchedule(mail) {
  if (!mailConnectionConfigured(mail)) return null;
  const status = await mailApiRequest('/api/sync', {
    method: 'POST',
    body: {
      config: toBackendMailConfig({ ...mail, enabled: false })
    },
    mail
  });
  applyRemoteMailStatus(status);
  return status;
}

async function refreshMailStatus(mail = state.mail) {
  if (!mailConnectionConfigured(mail)) {
    applyLocalMailStatus();
    return null;
  }
  try {
    const status = await mailApiRequest('/api/status', {
      method: 'GET',
      mail,
      timeout: MAIL_STATUS_TIMEOUT_MS
    });
    applyRemoteMailStatus(status);
    return status;
  } catch (error) {
    setMailStatus('error', 'Нет связи с почтовым сервисом', error.message);
    return null;
  }
}

function queueMailSync(delay = MAIL_SYNC_DEBOUNCE_MS) {
  if (state.mailSyncTimer) {
    clearTimeout(state.mailSyncTimer);
    state.mailSyncTimer = null;
  }
  if (!state.key || refs.appView.hidden || !state.mail) {
    return;
  }
  if (!mailConfigurationReady(state.mail)) {
    return;
  }

  state.mailSyncTimer = window.setTimeout(() => {
    state.mailSyncTimer = null;
    if (!state.key || refs.appView.hidden || !mailConfigurationReady(state.mail)) {
      return;
    }
    setMailStatus('syncing', 'Синхронизация с почтовым сервисом', 'Передаём актуальные данные расписания');
    syncMailSchedule(state.mail).catch((error) => {
      console.warn('Mail background sync failed:', error);
      setMailStatus('error', 'Данные не отправлены на сервер', error.message);
    });
  }, delay);
}

/* ---------- Base64 / crypto ---------- */

function bytesToBase64(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function isCipherPayload(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      typeof value.iv === 'string' &&
      value.iv.length > 0 &&
      typeof value.data === 'string' &&
      value.data.length > 0
  );
}

async function deriveKey(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFKC')),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(salt),
      iterations,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

async function encryptJson(key, value) {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(value))
  );
  return {
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext))
  };
}

async function decryptJson(key, payload) {
  if (!isCipherPayload(payload)) {
    throw new AppError('Зашифрованные данные повреждены.');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(payload.iv) },
    key,
    base64ToBytes(payload.data)
  );
  return JSON.parse(decoder.decode(plaintext));
}

async function verifyAccountKey(key, account) {
  try {
    const marker = await decryptJson(key, account.verifier);
    return marker && marker.marker === UNLOCK_MARKER;
  } catch {
    return false;
  }
}

async function verifyPassword(password, account) {
  const key = await deriveKey(password, account.salt, account.iterations);
  return verifyAccountKey(key, account);
}

/* ---------- Validation and storage shape ---------- */

function normalizeSnapshot(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const date = String(value.date || '');
  const name = String(value.name || '');
  const unit = String(value.unit || '');
  const qty = Number(value.qty);
  if (!isValidDateISO(date) || !name || !unit || !Number.isFinite(qty) || qty <= 0) {
    return null;
  }
  return {
    date,
    name,
    unit,
    qty,
    note: typeof value.note === 'string' ? value.note : ''
  };
}

function normalizeHistoryEntry(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const allowedActions = new Set(['create', 'edit', 'archive', 'restore', 'undo']);
  const action = allowedActions.has(value.action) ? value.action : null;
  if (!action || !isValidTimestamp(value.at)) {
    return null;
  }
  return {
    action,
    at: value.at,
    by: typeof value.by === 'string' ? value.by.slice(0, 64) : '',
    snapshot: normalizeSnapshot(value.snapshot)
  };
}

function validateStoredRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('В реестре обнаружена повреждённая запись.');
  }

  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(id)) {
    throw new AppError('В реестре обнаружена повреждённая запись.');
  }

  const date = typeof raw.date === 'string' ? raw.date : '';
  if (!isValidDateISO(date)) {
    throw new AppError('В реестре обнаружена запись с некорректной датой.');
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const unit = typeof raw.unit === 'string' ? raw.unit.trim() : '';
  const note = typeof raw.note === 'string' ? raw.note : '';
  const qty = Number(raw.qty);

  if (!name || name.length > 200 || !unit || unit.length > 20 || note.length > 500) {
    throw new AppError('В реестре обнаружена некорректная запись.');
  }
  if (!Number.isFinite(qty) || qty <= 0 || qty > 999_999_999.999) {
    throw new AppError('В реестре обнаружено некорректное количество.');
  }

  if (raw.archivedAt !== null && raw.archivedAt !== undefined && !isValidTimestamp(raw.archivedAt)) {
    throw new AppError('В реестре обнаружена некорректная отметка архива.');
  }

  const createdAt = isValidTimestamp(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isValidTimestamp(raw.updatedAt) ? raw.updatedAt : createdAt;
  const history = Array.isArray(raw.history)
    ? raw.history.map(normalizeHistoryEntry).filter(Boolean).slice(-HISTORY_LIMIT)
    : [];

  return {
    id,
    date,
    name,
    unit,
    qty: Math.round(qty * 1000) / 1000,
    note,
    createdAt,
    updatedAt,
    archivedAt: raw.archivedAt || null,
    history
  };
}

function validateVaultPayload(payload) {
  if (!payload || typeof payload !== 'object' || payload.schema !== 1 || !Array.isArray(payload.records)) {
    throw new AppError('Содержимое реестра повреждено.');
  }

  const records = payload.records.map(validateStoredRecord);
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) {
      throw new AppError('В реестре обнаружены повторяющиеся записи.');
    }
    ids.add(record.id);
  }
  return {
    records,
    mail: normalizeMailSettings(payload.mail)
  };
}

function validateAccount(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new AppError('Файл не похож на резервную копию ПРИЁМКИ.');
  }
  if (raw.app !== 'priemka' || raw.schema !== 1) {
    throw new AppError('Это не резервная копия ПРИЁМКИ или её версия не поддерживается.');
  }

  const username = typeof raw.username === 'string' ? raw.username : '';
  const salt = typeof raw.salt === 'string' ? raw.salt : '';
  const iterations = Number(raw.iterations);

  if (username.length < 1 || username.length > 64) {
    throw new AppError('В резервной копии некорректный логин.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(salt) || salt.length < 12) {
    throw new AppError('В резервной копии повреждены параметры шифрования.');
  }
  if (!Number.isInteger(iterations) || iterations < 50_000 || iterations > 2_000_000) {
    throw new AppError('В резервной копии некорректные параметры шифрования.');
  }
  if (!isCipherPayload(raw.verifier) || !isCipherPayload(raw.vault)) {
    throw new AppError('В резервной копии отсутствуют зашифрованные данные.');
  }

  return {
    app: 'priemka',
    schema: 1,
    username,
    salt,
    iterations,
    verifier: { iv: raw.verifier.iv, data: raw.verifier.data },
    vault: { iv: raw.vault.iv, data: raw.vault.data },
    createdAt: isValidTimestamp(raw.createdAt) ? raw.createdAt : new Date().toISOString(),
    updatedAt: isValidTimestamp(raw.updatedAt) ? raw.updatedAt : new Date().toISOString()
  };
}

function readAccount() {
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (error) {
    console.error(error);
    return {
      status: 'error',
      message: 'Браузер запрещает доступ к локальному хранилищу. Разрешите хранение данных для этого сайта.'
    };
  }

  if (raw === null) {
    return { status: 'none' };
  }

  try {
    return { status: 'ok', account: validateAccount(JSON.parse(raw)) };
  } catch (error) {
    console.error('Stored account could not be read:', error);
    return {
      status: 'error',
      message: 'Локальные данные не удалось прочитать. Не создавайте новый реестр: это может привести к потере записей.'
    };
  }
}

function writeAccount(account) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch (error) {
    console.error(error);
    throw new AppError(
      'Не удалось сохранить данные в браузере. Проверьте свободное место и разрешение на хранение данных.'
    );
  }
}

function extractBackupAccount(raw) {
  if (raw && raw.format === 'priemka-backup') {
    if (raw.version !== 1) {
      throw new AppError('Эта версия резервной копии пока не поддерживается.');
    }
    return validateAccount(raw.account);
  }
  return validateAccount(raw);
}

function makeBackupEnvelope(account) {
  return {
    app: 'priemka',
    format: 'priemka-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    account
  };
}

/* ---------- Accounts and sessions ---------- */

function validateUsername(username) {
  if (!username) {
    throw new AppError('Введите логин.');
  }
  if (!/^[A-Za-zА-Яа-яЁё0-9_.-]{3,32}$/u.test(username)) {
    throw new AppError('Логин: от 3 до 32 символов, буквы, цифры, точка, дефис или подчёркивание.');
  }
  return username;
}

function validateNewPassword(password, confirmation) {
  if (!password) {
    throw new AppError('Введите пароль.');
  }
  if (password.length < 8) {
    throw new AppError('Пароль должен содержать не менее 8 символов.');
  }
  if (password.length > 256) {
    throw new AppError('Пароль слишком длинный. Используйте не более 256 символов.');
  }
  if (!password.trim()) {
    throw new AppError('Пароль не может состоять только из пробелов.');
  }
  if (password !== confirmation) {
    throw new AppError('Пароли не совпадают.');
  }
  return password;
}

async function buildNewAccount(username, password) {
  const salt = bytesToBase64(randomBytes(16));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const verifier = await encryptJson(key, { marker: UNLOCK_MARKER });
  const mail = createDefaultMailSettings();
  const vault = await encryptJson(key, { schema: 1, records: [], mail });
  const now = new Date().toISOString();

  return {
    account: {
      app: 'priemka',
      schema: 1,
      username,
      salt,
      iterations: PBKDF2_ITERATIONS,
      verifier,
      vault,
      createdAt: now,
      updatedAt: now
    },
    key,
    mail
  };
}

async function saveSession(account, key) {
  state.sessionExpiresAt = Date.now() + SESSION_TTL_MS;
  try {
    const rawKey = await crypto.subtle.exportKey('raw', key);
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        version: 1,
        username: account.username,
        key: bytesToBase64(new Uint8Array(rawKey)),
        expiresAt: state.sessionExpiresAt
      })
    );
  } catch (error) {
    // A blocked sessionStorage only means the user has to sign in again
    // after a page reload. It must not block the current session.
    console.warn('Session persistence is unavailable:', error);
  }
}

function readSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== 1 ||
      typeof parsed.username !== 'string' ||
      typeof parsed.key !== 'string' ||
      typeof parsed.expiresAt !== 'number'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function clearSession() {
  state.sessionExpiresAt = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing else to do.
  }
}

async function tryResumeSession(account) {
  const session = readSession();
  if (!session) {
    return false;
  }
  if (session.username !== account.username || session.expiresAt <= Date.now()) {
    clearSession();
    return false;
  }

  try {
    const rawKey = base64ToBytes(session.key);
    if (rawKey.byteLength !== 32) {
      throw new Error('Unexpected session key length');
    }
    const key = await crypto.subtle.importKey(
      'raw',
      rawKey,
      { name: 'AES-GCM' },
      true,
      ['encrypt', 'decrypt']
    );
    const payload = await decryptJson(key, account.vault);
    const { records, mail } = validateVaultPayload(payload);
    state.account = account;
    state.key = key;
    state.username = account.username;
    state.records = records;
    state.mail = mail;
    state.sessionExpiresAt = session.expiresAt;
    enterApp();
    return true;
  } catch (error) {
    console.warn('Session could not be resumed:', error);
    clearSession();
    return false;
  }
}

/* ---------- Session activity ---------- */

function clearInactivityTimer() {
  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
  }
}

function armInactivityTimer() {
  clearInactivityTimer();
  if (!state.key || refs.appView.hidden) {
    return;
  }

  const now = Date.now();
  const idleFor = state.lastActivityAt ? now - state.lastActivityAt : 0;
  const untilIdle = Math.max(1_000, INACTIVITY_MS - idleFor);
  const untilExpiry = state.sessionExpiresAt ? Math.max(1_000, state.sessionExpiresAt - now) : Number.POSITIVE_INFINITY;
  const delay = Math.max(1_000, Math.min(untilIdle, untilExpiry));

  state.inactivityTimer = setTimeout(() => {
    if (!state.key) return;
    const currentTime = Date.now();
    if (state.sessionExpiresAt && currentTime >= state.sessionExpiresAt) {
      lockApp('Срок сессии истёк. Войдите снова.');
      return;
    }
    if (state.lastActivityAt && currentTime - state.lastActivityAt >= INACTIVITY_MS) {
      lockApp('Реестр заблокирован после 30 минут бездействия.');
      return;
    }
    armInactivityTimer();
  }, delay);
}

function noteActivity() {
  if (!state.key || refs.appView.hidden) {
    return;
  }
  const now = Date.now();
  if (now - state.lastActivityAt < 5_000) {
    return;
  }
  if (state.sessionExpiresAt && now >= state.sessionExpiresAt) {
    lockApp('Срок сессии истёк. Войдите снова.');
    return;
  }
  state.lastActivityAt = now;
  armInactivityTimer();
}

function handleVisibilityChange() {
  if (document.visibilityState !== 'visible' || !state.key) {
    return;
  }
  const now = Date.now();
  if (state.sessionExpiresAt && now >= state.sessionExpiresAt) {
    lockApp('Срок сессии истёк. Войдите снова.');
    return;
  }
  if (state.lastActivityAt && now - state.lastActivityAt >= INACTIVITY_MS) {
    lockApp('Реестр заблокирован после 30 минут бездействия.');
    return;
  }
  armInactivityTimer();
  if (navigator.onLine && mailConfigurationReady(state.mail)) {
    queueMailSync(1_500);
  }
}

/* ---------- UI helpers ---------- */

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function setError(element, message) {
  if (!message) {
    element.hidden = true;
    element.textContent = '';
    return;
  }
  element.textContent = message;
  element.hidden = false;
}

function setAuthError(message) {
  setError(refs.authError, message);
}

function clearPasswordVisibility() {
  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    const input = byId(button.dataset.passwordToggle);
    if (!input) return;
    input.type = 'password';
    button.setAttribute('aria-label', 'Показать пароль');
    const use = button.querySelector('use');
    if (use) use.setAttribute('href', '#i-eye');
  });
}

function hideBootScreen() {
  if (!refs.bootScreen || refs.bootScreen.hidden) {
    return;
  }
  refs.bootScreen.classList.add('is-leaving');
  window.setTimeout(() => {
    refs.bootScreen.hidden = true;
  }, 320);
}

function setButtonBusy(button, isBusy, busyLabel = 'Подождите…') {
  if (!button) return;
  if (isBusy) {
    button.dataset.idleLabel = button.textContent;
    button.textContent = busyLabel;
    button.disabled = true;
    button.classList.add('is-busy');
  } else {
    if (button.dataset.idleLabel) {
      button.textContent = button.dataset.idleLabel;
      delete button.dataset.idleLabel;
    }
    button.disabled = false;
    button.classList.remove('is-busy');
  }
}

function setAuthBusy(isBusy, label = 'Проверяем…') {
  busy.auth = isBusy;
  refs.authSubmit.disabled = isBusy;
  refs.authSubmit.classList.toggle('is-busy', isBusy);
  if (isBusy) {
    refs.authSubmitText.textContent = label;
  } else {
    refs.authSubmitText.textContent = state.authMode === 'setup'
      ? 'Создать реестр'
      : state.authMode === 'restore'
        ? 'Восстановить и войти'
        : 'Войти в реестр';
  }
}

function showToast(message, options = {}) {
  const { type = 'success', actionLabel = '', onAction = null, timeout = 5_500 } = options;
  const toast = document.createElement('div');
  toast.className = `toast${type === 'error' ? ' toast--error' : ''}`;

  const mark = document.createElement('span');
  mark.className = 'toast-mark';
  mark.append(icon(type === 'error' ? 'alert' : type === 'info' ? 'info' : 'check'));
  toast.append(mark);

  const text = document.createElement('p');
  text.textContent = message;
  toast.append(text);

  let dismissTimer = null;
  let dismissed = false;

  function dismiss(immediate = false) {
    if (dismissed) return;
    dismissed = true;
    if (dismissTimer) clearTimeout(dismissTimer);
    if (immediate) {
      toast.remove();
      return;
    }
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 200);
  }

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      dismiss();
      try {
        const result = onAction();
        if (result && typeof result.catch === 'function') {
          result.catch((error) => {
            console.error(error);
            showToast(error instanceof AppError ? error.message : 'Не удалось выполнить действие.', { type: 'error' });
          });
        }
      } catch (error) {
        console.error(error);
        showToast(error instanceof AppError ? error.message : 'Не удалось выполнить действие.', { type: 'error' });
      }
    });
    toast.append(action);
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Закрыть уведомление');
  close.append(icon('x'));
  close.addEventListener('click', () => dismiss());
  toast.append(close);

  while (refs.toastRegion.children.length >= 2) {
    refs.toastRegion.firstElementChild.remove();
  }
  refs.toastRegion.append(toast);

  dismissTimer = window.setTimeout(() => dismiss(), Math.max(2_000, timeout));
}

function clearToasts() {
  refs.toastRegion.replaceChildren();
}

function closeDialog(dialog) {
  if (dialog && dialog.open) {
    dialog.close();
  }
}

function closeAllDialogs() {
  [refs.materialDialog, refs.archiveDialog, refs.settingsDialog].forEach(closeDialog);
}

function syncDialogBusyState() {
  // Reading busy flags through the DOM is intentional: the dialogs cannot be
  // dismissed with Escape while a deliberate write/verification is running.
  if (busy.material) refs.materialDialog.setAttribute('data-busy', 'true');
  else refs.materialDialog.removeAttribute('data-busy');
}

/* ---------- Auth view ---------- */

function showAuth(mode) {
  refs.authView.hidden = false;
  refs.appView.hidden = true;
  document.title = 'ПРИЁМКА — реестр материалов на объекте';
  setAuthMode(mode);
  window.scrollTo(0, 0);
}

function setAuthMode(mode) {
  if (!['setup', 'login', 'restore'].includes(mode)) {
    mode = state.account ? 'login' : 'setup';
  }
  if (mode === 'login' && !state.account) {
    mode = 'setup';
  }
  if (mode === 'restore' && !state.pendingRestore) {
    mode = state.account ? 'login' : 'setup';
  }

  state.authMode = mode;
  clearPasswordVisibility();
  setAuthError('');
  refs.authForm.hidden = false;
  refs.authSubmit.disabled = false;
  refs.authSubmit.classList.remove('is-busy');
  refs.authPassword.value = '';
  refs.authConfirm.value = '';
  refs.authSwitch.hidden = true;

  const isSetup = mode === 'setup';
  const isRestore = mode === 'restore';

  refs.usernameField.hidden = isRestore;
  refs.confirmField.hidden = !isSetup;
  refs.authUsername.required = !isRestore;
  refs.authConfirm.required = isSetup;
  refs.authPassword.autocomplete = isSetup ? 'new-password' : 'current-password';
  refs.authPassword.placeholder = isSetup
    ? 'Не менее 8 символов'
    : isRestore
      ? 'Пароль от резервной копии'
      : 'Введите пароль';

  refs.authUsername.readOnly = false;
  refs.authUsername.value = isSetup ? '' : state.account ? state.account.username : '';

  refs.authKicker.textContent = isSetup
    ? 'Первый запуск'
    : isRestore
      ? 'Восстановление из копии'
      : 'Доступ к реестру';
  refs.authTitle.textContent = isSetup
    ? 'Создайте доступ'
    : isRestore
      ? 'Вернуть реестр'
      : 'С возвращением';
  refs.authSubtitle.textContent = isSetup
    ? 'Придумайте логин и пароль. Реестр будет зашифрован на этом устройстве.'
    : isRestore
      ? `Копия пользователя ${state.pendingRestore?.account.username || ''}. Введите пароль, который использовался при её создании.`
      : 'Введите логин и пароль локального реестра, чтобы продолжить.';

  refs.authHint.textContent = isSetup
    ? 'Минимум 8 символов. Пароль не передаётся по сети и не сохраняется на сервере.'
    : isRestore
      ? 'Пароль не хранится в файле копии. Без него восстановление невозможно.'
      : 'После 30 минут бездействия доступ блокируется автоматически.';

  refs.authWarning.hidden = isRestore;
  refs.authWarningText.textContent = isSetup
    ? 'Пароль невозможно восстановить. Сохраните его в надёжном месте и периодически делайте резервную копию.'
    : 'Если пароль забыт, войти в локальный реестр нельзя. Резервную копию можно восстановить только при первом запуске на чистом устройстве.';

  refs.restoreBlock.hidden = !isSetup;
  refs.restoreSelected.hidden = !isRestore;

  refs.authStatusLabel.textContent = isSetup
    ? 'Первый запуск'
    : isRestore
      ? 'Восстановление'
      : 'Защищённый доступ';

  if (isRestore && state.pendingRestore) {
    refs.restoreFileName.textContent = state.pendingRestore.fileName;
    const date = state.pendingRestore.exportedAt
      ? dateFormatter.format(new Date(state.pendingRestore.exportedAt))
      : 'дата неизвестна';
    refs.restoreFileMeta.textContent = `${state.pendingRestore.account.username} · ${date}`;
  } else {
    refs.restoreFile.value = '';
  }

  setAuthBusy(false);
}

function showFatalAuth(message) {
  refs.authView.hidden = false;
  refs.appView.hidden = true;
  refs.authForm.hidden = true;
  refs.restoreBlock.hidden = true;
  refs.restoreSelected.hidden = true;
  refs.authWarning.hidden = true;
  refs.authSwitch.hidden = true;
  refs.authStatusLabel.textContent = 'Ошибка';
  refs.authKicker.textContent = 'Не удалось открыть';
  refs.authTitle.textContent = 'Реестр недоступен';
  refs.authSubtitle.textContent = message;
  document.title = 'ПРИЁМКА — реестр недоступен';
  window.scrollTo(0, 0);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  if (busy.auth) return;

  setAuthError('');
  const mode = state.authMode;

  try {
    if (mode === 'setup') {
      const username = validateUsername(refs.authUsername.value.trim());
      const password = validateNewPassword(refs.authPassword.value, refs.authConfirm.value);

      const current = readAccount();
      if (current.status === 'ok') {
        state.account = current.account;
        showAuth('login');
        showToast('В этом браузере уже есть реестр. Войдите в него.', { type: 'info' });
        return;
      }
      if (current.status === 'error') {
        throw new AppError(current.message);
      }

      setAuthBusy(true, 'Создаём реестр…');
      const { account, key, mail } = await buildNewAccount(username, password);
      writeAccount(account);

      state.account = account;
      state.username = account.username;
      state.key = key;
      state.records = [];
      state.mail = mail;
      await saveSession(account, key);
      enterApp();
      showToast('Реестр создан. Можно добавлять первую поставку.');
      return;
    }

    if (mode === 'login') {
      const current = readAccount();
      if (current.status === 'error') {
        throw new AppError(current.message);
      }
      if (current.status === 'none') {
        state.account = null;
        showAuth('setup');
        setAuthError('Локальный реестр не найден. Создайте доступ или восстановите копию.');
        return;
      }

      state.account = current.account;
      const enteredUsername = refs.authUsername.value.trim();
      const password = refs.authPassword.value;

      if (!enteredUsername) {
        throw new AppError('Введите логин.');
      }
      if (!password) {
        throw new AppError('Введите пароль.');
      }
      if (enteredUsername.toLocaleLowerCase('ru-RU') !== current.account.username.toLocaleLowerCase('ru-RU')) {
        throw new AppError('Неверный логин или пароль.');
      }

      setAuthBusy(true, 'Открываем реестр…');
      let key;
      try {
        key = await deriveKey(password, current.account.salt, current.account.iterations);
      } catch (error) {
        console.error(error);
        throw new AppError('Не удалось обработать пароль в этом браузере.');
      }

      const valid = await verifyAccountKey(key, current.account);
      if (!valid) {
        throw new AppError('Неверный логин или пароль.');
      }

      let records;
      let mail;
      try {
        const payload = await decryptJson(key, current.account.vault);
        ({ records, mail } = validateVaultPayload(payload));
      } catch (error) {
        console.error(error);
        throw new AppError('Данные реестра повреждены. Проверьте резервную копию.');
      }

      state.key = key;
      state.username = current.account.username;
      state.records = records;
      state.mail = mail;
      await saveSession(current.account, key);
      enterApp();
      showToast(`Реестр открыт. Добро пожаловать, ${current.account.username}.`);
      return;
    }

    if (mode === 'restore') {
      const pending = state.pendingRestore;
      if (!pending) {
        throw new AppError('Сначала выберите файл резервной копии.');
      }
      const current = readAccount();
      if (current.status !== 'none') {
        throw new AppError('В этом браузере уже есть реестр. Восстановление поверх существующих данных отключено.');
      }

      const password = refs.authPassword.value;
      if (!password) {
        throw new AppError('Введите пароль от резервной копии.');
      }

      setAuthBusy(true, 'Проверяем копию…');
      let key;
      try {
        key = await deriveKey(password, pending.account.salt, pending.account.iterations);
      } catch (error) {
        console.error(error);
        throw new AppError('Не удалось обработать пароль в этом браузере.');
      }

      const valid = await verifyAccountKey(key, pending.account);
      if (!valid) {
        throw new AppError('Неверный пароль от резервной копии.');
      }

      let records;
      let mail;
      try {
        const payload = await decryptJson(key, pending.account.vault);
        ({ records, mail } = validateVaultPayload(payload));
      } catch (error) {
        console.error(error);
        throw new AppError('Не удалось расшифровать резервную копию. Файл повреждён.');
      }

      writeAccount(pending.account);
      state.account = pending.account;
      state.key = key;
      state.username = pending.account.username;
      state.records = records;
      state.mail = mail;
      state.pendingRestore = null;
      await saveSession(pending.account, key);
      enterApp();
      showToast('Реестр восстановлен из резервной копии.');
    }
  } catch (error) {
    console.error(error);
    setAuthError(
      error instanceof AppError
        ? error.message
        : 'Не удалось выполнить действие. Попробуйте ещё раз.'
    );
  } finally {
    if (state.authMode === mode) {
      setAuthBusy(false);
    }
  }
}

async function handleRestoreFile(file) {
  if (!file) return;
  setAuthError('');

  if (file.size > MAX_BACKUP_BYTES) {
    setAuthError('Файл резервной копии слишком большой.');
    return;
  }

  try {
    const text = await file.text();
    const raw = JSON.parse(text);
    const account = extractBackupAccount(raw);
    state.pendingRestore = {
      account,
      fileName: file.name,
      exportedAt: raw && raw.format === 'priemka-backup' ? raw.exportedAt : account.updatedAt
    };
    setAuthMode('restore');
  } catch (error) {
    console.error(error);
    state.pendingRestore = null;
    setAuthError(
      error instanceof AppError
        ? error.message
        : 'Не удалось прочитать файл. Выберите JSON-файл резервной копии ПРИЁМКИ.'
    );
  } finally {
    refs.restoreFile.value = '';
  }
}

function cancelRestore() {
  state.pendingRestore = null;
  refs.restoreFile.value = '';
  setAuthMode(state.account ? 'login' : 'setup');
}
/* ---------- Enter / leave application ---------- */

function enterApp() {
  refs.authView.hidden = true;
  refs.appView.hidden = false;
  clearPasswordVisibility();
  closeAllDialogs();
  clearToasts();
  state.mail = normalizeMailSettings(state.mail);
  applyAccountLabels();
  state.view = 'active';
  state.query = '';
  state.period = 'all';
  refs.searchInput.value = '';
  refs.periodSelect.value = 'all';
  state.lastActivityAt = Date.now();
  renderAll();
  applyLocalMailStatus();
  armInactivityTimer();
  document.title = `Реестр · ${state.username} — ПРИЁМКА`;
  window.scrollTo(0, 0);

  if (navigator.storage && typeof navigator.storage.persist === 'function') {
    navigator.storage.persist().catch(() => {});
  }
  queueMailSync(2_500);
  hideBootScreen();
}

function applyAccountLabels() {
  const username = state.account?.username || state.username || 'admin';
  refs.accountName.textContent = username;
  refs.avatarInitial.textContent = username.charAt(0).toLocaleUpperCase('ru-RU');
  refs.userChip.title = `Локальный аккаунт: ${username}`;
  refs.settingsUsername.textContent = username;
  refs.settingsAvatar.textContent = username.charAt(0).toLocaleUpperCase('ru-RU');
}

function lockApp(message = 'Реестр заблокирован.') {
  if (refs.appView.hidden) {
    return;
  }

  clearInactivityTimer();
  stopMailActivity();
  closeAllDialogs();
  clearPasswordVisibility();
  clearSession();
  clearToasts();

  state.key = null;
  state.records = [];
  state.username = '';
  state.mail = null;
  state.mailRemoteStatus = null;
  state.mailSyncTimer = null;
  state.view = 'active';
  state.query = '';
  state.period = 'all';
  state.pendingArchiveId = null;
  state.editingId = null;
  state.lastActivityAt = 0;

  refs.recordsBody.replaceChildren();
  refs.unitTotals.replaceChildren();
  refs.tableWrap.hidden = false;
  refs.emptyState.hidden = true;
  refs.authPassword.value = '';
  refs.authConfirm.value = '';
  refs.archivePassword.value = '';
  refs.currentPassword.value = '';
  refs.newPassword.value = '';
  refs.newPasswordConfirm.value = '';
  refs.mailToken.value = '';
  refs.mailForm.reset();
  setMailEditorOpen(false);
  setMailStatus('off', 'Не настроено', 'Автоматические письма выключены');
  setError(refs.materialError, '');
  setError(refs.archiveError, '');
  setError(refs.passwordError, '');
  setError(refs.mailError, '');

  const loaded = readAccount();
  state.account = loaded.status === 'ok' ? loaded.account : null;

  showAuth(state.account ? 'login' : 'setup');
  if (state.account) {
    showToast(message, { type: 'info' });
  }
}

/* ---------- Rendering ---------- */

function renderAll() {
  if (refs.appView.hidden) return;
  renderStats();
  renderLedger();
}

function renderStats() {
  const active = state.records.filter((record) => !record.archivedAt);
  const archived = state.records.filter((record) => record.archivedAt);
  const today = todayISO();
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (WEEK_DAYS - 1));
  const weekCutoff = toISOdate(cutoff);
  const week = active.filter((record) => record.date >= weekCutoff && record.date <= today).length;
  const units = new Set(active.map((record) => record.unit));

  refs.statActive.textContent = String(active.length);
  refs.statWeek.textContent = String(week);
  refs.statUnits.textContent = String(units.size);
  refs.statArchived.textContent = String(archived.length);
  refs.statActiveLabel.textContent = pluralRu(active.length, 'позиция', 'позиции', 'позиций');
  refs.statWeekLabel.textContent = pluralRu(week, 'поступление', 'поступления', 'поступлений');
  refs.statUnitsLabel.textContent = pluralRu(units.size, 'измерение', 'измерения', 'измерений');
  refs.statArchivedLabel.textContent = 'сохранено';
  refs.activeCount.textContent = String(active.length);
  refs.archiveCount.textContent = String(archived.length);
}

function getFilteredRecords() {
  let records = state.records.filter((record) =>
    state.view === 'archive' ? Boolean(record.archivedAt) : !record.archivedAt
  );

  const query = normalizeSearch(state.query);
  if (query) {
    records = records.filter((record) => {
      const haystack = normalizeSearch(`${record.name} ${record.note} ${record.unit}`);
      return haystack.includes(query);
    });
  }

  if (state.period !== 'all') {
    const today = todayISO();
    let cutoff = today;
    if (state.period !== 'today') {
      const days = Number(state.period);
      const date = new Date();
      date.setHours(0, 0, 0, 0);
      date.setDate(date.getDate() - (days - 1));
      cutoff = toISOdate(date);
    }
    records = records.filter((record) => record.date >= cutoff && record.date <= today);
  }

  return records.sort((left, right) => {
    const byDate = right.date.localeCompare(left.date);
    if (byDate !== 0) return byDate;
    return String(right.createdAt).localeCompare(String(left.createdAt));
  });
}

function makeActionButton(record, action, iconName, label, extraClass = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `action-btn ${extraClass}`.trim();
  button.dataset.action = action;
  button.dataset.id = record.id;
  button.title = label;
  button.setAttribute('aria-label', `${label}: ${record.name}`);
  button.append(icon(iconName));
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);
  return button;
}

function createTableRow(record) {
  const row = document.createElement('tr');
  if (record.archivedAt) {
    row.classList.add('is-archived');
  }
  row.dataset.id = record.id;

  const dateCell = document.createElement('td');
  dateCell.className = 'cell-date';
  const dateStack = document.createElement('div');
  dateStack.className = 'date-stack';
  const dateMain = document.createElement('span');
  dateMain.className = 'date-main';
  dateMain.textContent = formatDate(record.date);
  const dateSub = document.createElement('span');
  dateSub.className = 'date-sub';
  dateSub.textContent = state.view === 'archive' && record.archivedAt
    ? formatArchivedSub(record.archivedAt)
    : relativeDayLabel(record.date);
  dateStack.append(dateMain, dateSub);
  dateCell.append(dateStack);

  const nameCell = document.createElement('td');
  nameCell.className = 'cell-name';
  const itemName = document.createElement('span');
  itemName.className = 'item-name';
  itemName.textContent = record.name;
  if (record.archivedAt) {
    const badge = document.createElement('span');
    badge.className = 'archive-badge';
    badge.textContent = 'архив';
    itemName.append(' ', badge);
  }
  nameCell.append(itemName);

  if (record.note) {
    const note = document.createElement('span');
    note.className = 'item-note';
    note.textContent = record.note;
    note.title = record.note;
    nameCell.append(note);
  }

  const unitCell = document.createElement('td');
  unitCell.className = 'cell-unit';
  const unit = document.createElement('span');
  unit.className = 'unit-pill';
  unit.textContent = record.unit;
  unitCell.append(unit);

  const qtyCell = document.createElement('td');
  qtyCell.className = 'cell-qty';
  const qty = document.createElement('span');
  qty.className = 'qty-value';
  qty.textContent = formatQty(record.qty);
  qtyCell.append(qty);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'cell-actions';
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  if (record.archivedAt) {
    actions.append(makeActionButton(record, 'restore', 'restore', 'Вернуть', 'action-btn--restore'));
  } else {
    actions.append(
      makeActionButton(record, 'edit', 'edit', 'Изменить'),
      makeActionButton(record, 'archive', 'archive', 'В архив', 'action-btn--archive')
    );
  }
  actionsCell.append(actions);

  row.append(dateCell, nameCell, unitCell, qtyCell, actionsCell);
  return row;
}

function renderLedger() {
  const allActive = state.records.filter((record) => !record.archivedAt);
  const allArchived = state.records.filter((record) => record.archivedAt);
  const records = getFilteredRecords();

  refs.activeCount.textContent = String(allActive.length);
  refs.archiveCount.textContent = String(allArchived.length);
  refs.tabActive.classList.toggle('is-active', state.view === 'active');
  refs.tabArchive.classList.toggle('is-active', state.view === 'archive');
  refs.tabActive.setAttribute('aria-pressed', String(state.view === 'active'));
  refs.tabArchive.setAttribute('aria-pressed', String(state.view === 'archive'));

  refs.recordsBody.replaceChildren();
  const fragment = document.createDocumentFragment();
  records.forEach((record) => fragment.append(createTableRow(record)));
  refs.recordsBody.append(fragment);

  refs.tableWrap.hidden = records.length === 0;
  refs.emptyState.hidden = records.length > 0;
  refs.visibleCount.textContent = `${records.length} ${recordWord(records.length)}`;

  renderTotals(records);
  renderEmptyState(records.length);
}

function renderTotals(records) {
  const totals = new Map();
  records.forEach((record) => {
    const current = totals.get(record.unit) || 0;
    totals.set(record.unit, Math.round((current + record.qty) * 1000) / 1000);
  });

  const entries = [...totals.entries()].sort((left, right) => {
    const leftIndex = UNIT_ORDER.indexOf(left[0]);
    const rightIndex = UNIT_ORDER.indexOf(right[0]);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left[0].localeCompare(right[0], 'ru');
  });

  refs.unitTotals.replaceChildren();
  entries.forEach(([unit, total]) => {
    const chip = document.createElement('span');
    chip.className = 'unit-total';
    const value = document.createElement('strong');
    value.textContent = formatQty(total);
    chip.append(value, document.createTextNode(` ${unit}`));
    refs.unitTotals.append(chip);
  });

  refs.unitTotals.hidden = entries.length === 0;
  refs.totalsEmpty.hidden = entries.length > 0;
}

function renderEmptyState(visibleCount) {
  if (visibleCount > 0) return;

  const hasFilters = Boolean(state.query.trim()) || state.period !== 'all';
  const activeCount = state.records.filter((record) => !record.archivedAt).length;
  const archivedCount = state.records.filter((record) => record.archivedAt).length;

  let title = 'Журнал пока пуст';
  let text = 'Добавьте первую поставку — дату, материал, единицу измерения и количество.';
  let action = 'add';
  let actionLabel = 'Принять первый материал';

  if (hasFilters) {
    title = 'Ничего не найдено';
    text = 'По этому запросу и периоду записей нет. Сбросьте фильтры и попробуйте снова.';
    action = 'reset';
    actionLabel = 'Сбросить фильтры';
  } else if (state.view === 'archive') {
    title = 'Архив пуст';
    text = archivedCount > 0
      ? 'В архиве нет записей за выбранный период.'
      : 'Сюда попадут записи, перемещённые из реестра. Удалить их навсегда нельзя.';
    action = activeCount > 0 ? 'registry' : 'add';
    actionLabel = activeCount > 0 ? 'Вернуться в реестр' : 'Принять первый материал';
  } else if (archivedCount > 0) {
    title = 'В реестре пока пусто';
    text = 'Все записи находятся в архиве. Добавьте новую поставку или верните запись из архива.';
    action = 'add';
    actionLabel = 'Принять материал';
  }

  refs.emptyTitle.textContent = title;
  refs.emptyText.textContent = text;
  refs.emptyAction.textContent = actionLabel;
  refs.emptyAction.dataset.action = action;
}

function setView(view) {
  if (state.view === view) return;
  state.view = view;
  state.query = '';
  state.period = 'all';
  refs.searchInput.value = '';
  refs.periodSelect.value = 'all';
  renderLedger();
}

function resetFilters() {
  state.query = '';
  state.period = 'all';
  refs.searchInput.value = '';
  refs.periodSelect.value = 'all';
  renderLedger();
}

function openAddDialog() {
  if (refs.appView.hidden) return;
  state.editingId = null;
  refs.materialForm.reset();
  refs.materialId.value = '';
  refs.materialDate.value = todayISO();
  refs.materialName.value = '';
  refs.materialUnit.value = '';
  refs.materialQty.value = '';
  refs.materialNote.value = '';
  setError(refs.materialError, '');
  refs.materialKicker.textContent = 'Новая позиция';
  refs.materialTitle.textContent = 'Принять материал';
  refs.materialSubtitle.textContent = 'Зафиксируйте поставку. После сохранения запись можно изменить.';
  refs.materialSubmit.textContent = 'Добавить в реестр';
  refs.materialSubmit.disabled = false;
  refs.historyDetails.hidden = true;
  refs.historyDetails.open = false;
  refs.historyList.replaceChildren();
  if (!refs.materialDialog.open) {
    refs.materialDialog.showModal();
  }
  window.setTimeout(() => refs.materialName.focus(), 40);
}

function openEditDialog(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record || record.archivedAt) {
    showToast('Запись не найдена или уже находится в архиве.', { type: 'error' });
    return;
  }

  state.editingId = record.id;
  refs.materialForm.reset();
  refs.materialId.value = record.id;
  refs.materialDate.value = record.date;
  refs.materialName.value = record.name;
  refs.materialUnit.value = record.unit;
  refs.materialQty.value = String(record.qty).replace('.', ',');
  refs.materialNote.value = record.note || '';
  setError(refs.materialError, '');
  refs.materialKicker.textContent = 'Редактирование';
  refs.materialTitle.textContent = 'Изменить материал';
  refs.materialSubtitle.textContent = 'Сохранённая версия останется в истории. Изменение можно отменить сразу после сохранения.';
  refs.materialSubmit.textContent = 'Сохранить изменения';
  refs.materialSubmit.disabled = false;
  renderHistory(record);

  if (!refs.materialDialog.open) {
    refs.materialDialog.showModal();
  }
  window.setTimeout(() => refs.materialName.focus(), 40);
}

function renderHistory(record) {
  refs.historyList.replaceChildren();
  const history = [...(record.history || [])].reverse();
  refs.historyDetails.hidden = history.length === 0;
  refs.historyDetails.open = false;
  refs.historyCount.textContent = `${history.length} ${entryWord(history.length)}`;

  const labels = {
    create: 'Создано',
    edit: 'Изменено',
    archive: 'Перемещено в архив',
    restore: 'Возвращено из архива',
    undo: 'Изменение отменено'
  };

  history.forEach((entry) => {
    const item = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = isValidTimestamp(entry.at) ? dateTimeFormatter.format(new Date(entry.at)) : '—';

    const detail = document.createElement('div');
    const action = document.createElement('span');
    action.className = 'history-action';
    action.textContent = `${labels[entry.action] || 'Изменено'}${entry.by ? ` · ${entry.by}` : ''}`;
    detail.append(action);

    const snapshotText = document.createElement('span');
    snapshotText.className = 'history-details';
    if (entry.snapshot) {
      snapshotText.textContent = `Было: ${entry.snapshot.name} · ${formatQty(entry.snapshot.qty)} ${entry.snapshot.unit} · ${formatDate(entry.snapshot.date)}`;
    } else if (entry.action === 'create') {
      snapshotText.textContent = 'Запись добавлена в реестр.';
    } else {
      snapshotText.textContent = 'Без изменения реквизитов.';
    }
    detail.append(snapshotText);

    item.append(time, detail);
    refs.historyList.append(item);
  });
}

/* ---------- Record input and persistence ---------- */

function parseQuantityInput(raw) {
  const normalized = String(raw)
    .trim()
    .replace(/[\s\u00A0\u202F]/g, '')
    .replace(',', '.');

  if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(normalized)) {
    return null;
  }
  const quantity = Number(normalized);
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999_999_999.999) {
    return null;
  }
  return Math.round(quantity * 1000) / 1000;
}

function readMaterialForm() {
  const date = refs.materialDate.value;
  const name = refs.materialName.value.trim();
  const unit = refs.materialUnit.value.trim();
  const note = refs.materialNote.value.trim();
  const quantity = parseQuantityInput(refs.materialQty.value);

  if (!isValidDateISO(date)) {
    return { error: 'Выберите корректную дату поступления.', field: refs.materialDate };
  }
  if (!name) {
    return { error: 'Введите наименование материала.', field: refs.materialName };
  }
  if (name.length > 200) {
    return { error: 'Наименование не должно превышать 200 символов.', field: refs.materialName };
  }
  if (!unit) {
    return { error: 'Укажите единицу измерения.', field: refs.materialUnit };
  }
  if (unit.length > 20) {
    return { error: 'Единица измерения не должна превышать 20 символов.', field: refs.materialUnit };
  }
  if (quantity === null) {
    return {
      error: 'Количество должно быть больше нуля — до 3 знаков после запятой, например 12,5.',
      field: refs.materialQty
    };
  }
  if (note.length > 500) {
    return { error: 'Примечание не должно превышать 500 символов.', field: refs.materialNote };
  }

  return {
    value: {
      date,
      name,
      unit,
      qty: quantity,
      note
    }
  };
}

function snapshotRecord(record) {
  return {
    date: record.date,
    name: record.name,
    unit: record.unit,
    qty: record.qty,
    note: record.note || ''
  };
}

function sameRecordValues(record, values) {
  return record.date === values.date &&
    record.name === values.name &&
    record.unit === values.unit &&
    record.qty === values.qty &&
    (record.note || '') === values.note;
}

function appendHistory(record, entry) {
  const history = [...(record.history || []), entry];
  return history.slice(-HISTORY_LIMIT);
}

async function persistRecords(nextRecords, options = {}) {
  if (!state.key || !state.account) {
    throw new AppError('Сессия заблокирована. Войдите в реестр снова.');
  }

  const nextMail = normalizeMailSettings(options.mail || state.mail);
  let vault;
  try {
    vault = await encryptJson(state.key, { schema: 1, records: nextRecords, mail: nextMail });
  } catch (error) {
    console.error(error);
    throw new AppError('Не удалось зашифровать данные. Попробуйте ещё раз.');
  }

  const updatedAccount = {
    ...state.account,
    vault,
    updatedAt: new Date().toISOString()
  };
  writeAccount(updatedAccount);
  state.account = updatedAccount;
  state.records = nextRecords;
  state.mail = nextMail;

  if (options.scheduleMail !== false) {
    queueMailSync();
  }
}

async function handleMaterialSubmit(event) {
  event.preventDefault();
  if (busy.material) return;
  setError(refs.materialError, '');

  const parsed = readMaterialForm();
  if (parsed.error) {
    setError(refs.materialError, parsed.error);
    parsed.field?.focus();
    return;
  }

  const values = parsed.value;
  const editingId = state.editingId;
  busy.material = true;
  setButtonBusy(refs.materialSubmit, true, editingId ? 'Сохраняем…' : 'Добавляем…');

  try {
    if (editingId) {
      const existing = state.records.find((record) => record.id === editingId);
      if (!existing || existing.archivedAt) {
        throw new AppError('Эта запись больше недоступна для редактирования.');
      }
      if (sameRecordValues(existing, values)) {
        closeDialog(refs.materialDialog);
        return;
      }

      const now = new Date().toISOString();
      const previous = snapshotRecord(existing);
      const updated = {
        ...existing,
        ...values,
        updatedAt: now,
        history: appendHistory(existing, {
          action: 'edit',
          at: now,
          by: state.username,
          snapshot: previous
        })
      };
      const nextRecords = state.records.map((record) => (record.id === editingId ? updated : record));
      await persistRecords(nextRecords);
      closeDialog(refs.materialDialog);
      renderAll();
      showToast('Изменения сохранены.', {
        actionLabel: 'Отменить',
        onAction: () => undoEdit(editingId, previous, updated.updatedAt),
        timeout: 8_000
      });
      return;
    }

    const now = new Date().toISOString();
    const record = {
      id: crypto.randomUUID(),
      ...values,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      history: [
        {
          action: 'create',
          at: now,
          by: state.username,
          snapshot: null
        }
      ]
    };
    const nextRecords = [...state.records, record];
    await persistRecords(nextRecords);

    state.view = 'active';
    state.query = '';
    state.period = 'all';
    refs.searchInput.value = '';
    refs.periodSelect.value = 'all';

    closeDialog(refs.materialDialog);
    renderAll();
    showToast('Материал добавлен в реестр.');
  } catch (error) {
    console.error(error);
    setError(
      refs.materialError,
      error instanceof AppError ? error.message : 'Не удалось сохранить запись. Попробуйте ещё раз.'
    );
  } finally {
    busy.material = false;
    setButtonBusy(refs.materialSubmit, false);
    syncDialogBusyState();
  }
}

async function undoEdit(recordId, previousSnapshot, expectedUpdatedAt) {
  if (!state.key) {
    throw new AppError('Сессия заблокирована. Войдите снова.');
  }
  const current = state.records.find((record) => record.id === recordId);
  if (!current || current.archivedAt) {
    throw new AppError('Отмена недоступна: запись уже изменилась или находится в архиве.');
  }
  if (current.updatedAt !== expectedUpdatedAt) {
    throw new AppError('Отмена недоступна: запись уже была изменена повторно.');
  }

  const now = new Date().toISOString();
  const beforeUndo = snapshotRecord(current);
  const reverted = {
    ...current,
    ...previousSnapshot,
    updatedAt: now,
    history: appendHistory(current, {
      action: 'undo',
      at: now,
      by: state.username,
      snapshot: beforeUndo
    })
  };
  const nextRecords = state.records.map((record) => (record.id === recordId ? reverted : record));
  await persistRecords(nextRecords);
  renderAll();
  showToast('Изменение отменено. Восстановлена предыдущая версия записи.');
}

/* ---------- Archive / restoration ---------- */

function requestArchive(recordId) {
  const record = state.records.find((item) => item.id === recordId);
  if (!record || record.archivedAt) {
    showToast('Запись не найдена.', { type: 'error' });
    return;
  }

  state.pendingArchiveId = record.id;
  refs.archiveRecordName.textContent = record.name;
  refs.archiveForm.reset();
  refs.archivePassword.value = '';
  setError(refs.archiveError, '');
  refs.archiveSubmit.disabled = false;
  refs.archiveSubmit.textContent = 'Переместить в архив';
  if (!refs.archiveDialog.open) {
    refs.archiveDialog.showModal();
  }
  window.setTimeout(() => refs.archivePassword.focus(), 40);
}

async function handleArchiveSubmit(event) {
  event.preventDefault();
  if (busy.archive) return;

  setError(refs.archiveError, '');
  const recordId = state.pendingArchiveId;
  const password = refs.archivePassword.value;

  if (!recordId) {
    setError(refs.archiveError, 'Запись не выбрана.');
    return;
  }
  if (!password) {
    setError(refs.archiveError, 'Введите текущий пароль для подтверждения.');
    refs.archivePassword.focus();
    return;
  }

  busy.archive = true;
  setButtonBusy(refs.archiveSubmit, true, 'Проверяем пароль…');

  try {
    const valid = await verifyPassword(password, state.account);
    if (!valid) {
      throw new AppError('Неверный пароль. Запись осталась в реестре.');
    }

    const record = state.records.find((item) => item.id === recordId);
    if (!record || record.archivedAt) {
      throw new AppError('Запись уже находится в архиве.');
    }

    refs.archiveSubmit.textContent = 'Архивируем…';
    const now = new Date().toISOString();
    const previous = snapshotRecord(record);
    const archived = {
      ...record,
      archivedAt: now,
      updatedAt: now,
      history: appendHistory(record, {
        action: 'archive',
        at: now,
        by: state.username,
        snapshot: previous
      })
    };
    const nextRecords = state.records.map((item) => (item.id === recordId ? archived : item));
    await persistRecords(nextRecords);

    closeDialog(refs.archiveDialog);
    renderAll();
    showToast('Запись перемещена в архив. Её можно вернуть в любой момент.', {
      actionLabel: 'Вернуть',
      onAction: () => restoreRecord(recordId, archived.updatedAt),
      timeout: 8_000
    });
  } catch (error) {
    console.error(error);
    setError(
      refs.archiveError,
      error instanceof AppError ? error.message : 'Не удалось переместить запись в архив. Попробуйте ещё раз.'
    );
  } finally {
    busy.archive = false;
    refs.archivePassword.value = '';
    setButtonBusy(refs.archiveSubmit, false);
  }
}

async function restoreRecord(recordId, expectedUpdatedAt = null) {
  if (!state.key) {
    throw new AppError('Сессия заблокирована. Войдите снова.');
  }
  const record = state.records.find((item) => item.id === recordId);
  if (!record || !record.archivedAt) {
    throw new AppError('Запись не найдена в архиве.');
  }
  if (expectedUpdatedAt && record.updatedAt !== expectedUpdatedAt) {
    throw new AppError('Запись уже изменилась. Откройте архив, чтобы проверить её.');
  }

  const now = new Date().toISOString();
  const restored = {
    ...record,
    archivedAt: null,
    updatedAt: now,
    history: appendHistory(record, {
      action: 'restore',
      at: now,
      by: state.username,
      snapshot: snapshotRecord(record)
    })
  };
  const nextRecords = state.records.map((item) => (item.id === recordId ? restored : item));
  await persistRecords(nextRecords);

  state.view = 'active';
  state.query = '';
  state.period = 'all';
  refs.searchInput.value = '';
  refs.periodSelect.value = 'all';
  renderAll();
  showToast('Запись возвращена из архива в реестр.');
}

/* ---------- Settings ---------- */

function openSettings() {
  if (refs.appView.hidden) return;
  state.mail = normalizeMailSettings(state.mail);
  clearPasswordVisibility();
  applyAccountLabels();
  refs.passwordForm.reset();
  setError(refs.passwordError, '');
  refs.passwordSubmit.disabled = false;
  populateMailForm();
  setMailEditorOpen(false);
  setError(refs.mailError, '');
  applyLocalMailStatus();
  if (mailConnectionConfigured(state.mail)) {
    refreshMailStatus();
  }
  if (!refs.settingsDialog.open) {
    refs.settingsDialog.showModal();
  }
}

function closeSettingsAndReset() {
  refs.passwordForm.reset();
  setError(refs.passwordError, '');
  setError(refs.mailError, '');
  refs.mailToken.value = '';
  clearPasswordVisibility();
  setMailEditorOpen(false);
}

async function handlePasswordSubmit(event) {
  event.preventDefault();
  if (busy.password) return;
  setError(refs.passwordError, '');

  const currentPassword = refs.currentPassword.value;
  const newPassword = refs.newPassword.value;
  const confirmation = refs.newPasswordConfirm.value;

  try {
    if (!currentPassword) {
      throw new AppError('Введите текущий пароль.');
    }
    if (!newPassword) {
      throw new AppError('Введите новый пароль.');
    }
    validateNewPassword(newPassword, confirmation);
    if (newPassword === currentPassword) {
      throw new AppError('Новый пароль должен отличаться от текущего.');
    }

    busy.password = true;
    setButtonBusy(refs.passwordSubmit, true, 'Проверяем…');

    let oldKey;
    try {
      oldKey = await deriveKey(currentPassword, state.account.salt, state.account.iterations);
    } catch (error) {
      console.error(error);
      throw new AppError('Не удалось проверить текущий пароль.');
    }
    const valid = await verifyAccountKey(oldKey, state.account);
    if (!valid) {
      throw new AppError('Текущий пароль указан неверно.');
    }

    const newSalt = bytesToBase64(randomBytes(16));
    let newKey;
    try {
      newKey = await deriveKey(newPassword, newSalt, PBKDF2_ITERATIONS);
    } catch (error) {
      console.error(error);
      throw new AppError('Не удалось создать новый пароль.');
    }

    const verifier = await encryptJson(newKey, { marker: UNLOCK_MARKER });
    const vault = await encryptJson(newKey, {
      schema: 1,
      records: state.records,
      mail: normalizeMailSettings(state.mail)
    });
    const updatedAccount = {
      ...state.account,
      salt: newSalt,
      iterations: PBKDF2_ITERATIONS,
      verifier,
      vault,
      updatedAt: new Date().toISOString()
    };

    writeAccount(updatedAccount);
    state.account = updatedAccount;
    state.key = newKey;
    await saveSession(updatedAccount, newKey);
    armInactivityTimer();
    queueMailSync(300);
    refs.passwordForm.reset();
    showToast('Пароль обновлён. Новые резервные копии будут использовать его.');
  } catch (error) {
    console.error(error);
    setError(
      refs.passwordError,
      error instanceof AppError ? error.message : 'Не удалось изменить пароль. Попробуйте ещё раз.'
    );
  } finally {
    busy.password = false;
    setButtonBusy(refs.passwordSubmit, false);
  }
}

/* ---------- Mail actions ---------- */

function setMailFormBusy(isBusy, mode = 'save') {
  busy.mail = isBusy;
  refs.mailSaveBtn.disabled = isBusy;
  refs.mailTestBtn.disabled = isBusy;
  refs.mailSaveBtn.classList.toggle('is-busy', isBusy && mode === 'save');
  refs.mailTestBtn.classList.toggle('is-busy', isBusy && mode === 'test');

  if (isBusy) {
    if (mode === 'save') {
      refs.mailSaveBtn.textContent = 'Сохраняем…';
    } else {
      refs.mailTestLabel.textContent = 'Отправляем…';
    }
  } else {
    refs.mailSaveBtn.textContent = 'Сохранить настройки';
    refs.mailTestLabel.textContent = 'Отправить тест';
  }
}

async function handleMailSave(event) {
  event.preventDefault();
  if (busy.mail) return;
  setError(refs.mailError, '');

  let nextMail;
  try {
    nextMail = {
      ...normalizeMailSettings(state.mail),
      ...readMailForm()
    };
  } catch (error) {
    setError(refs.mailError, error instanceof AppError ? error.message : 'Проверьте настройки почты.');
    return;
  }

  const previousMail = normalizeMailSettings(state.mail);
  let locallySaved = false;

  if (state.mailSyncTimer) {
    clearTimeout(state.mailSyncTimer);
    state.mailSyncTimer = null;
  }

  setMailFormBusy(true, 'save');
  setMailStatus('syncing', 'Сохраняем настройки почты', 'Подключаемся к почтовому сервису');

  try {
    await persistRecords(state.records, { mail: nextMail, scheduleMail: false });
    locallySaved = true;
    state.mail = nextMail;

    if (nextMail.enabled) {
      const status = await syncMailSchedule(nextMail);
      const next = status.nextRunLocal ? ` Следующее письмо: ${status.nextRunLocal}.` : '';
      showToast(`Настройки почты сохранены.${next}`, { timeout: 7_000 });
      return;
    }

    if (previousMail.enabled && mailConnectionConfigured(previousMail)) {
      try {
        await disableMailSchedule(previousMail);
      } catch (error) {
        throw new AppError(
          `Настройки сохранены локально, но почтовый сервер не подтвердил отключение. Расписание на сервере может остаться активным. ${error.message}`
        );
      }
    }

    applyLocalMailStatus();
    showToast('Автоотправка выключена. Настройки почты сохранены.');
  } catch (error) {
    console.error(error);
    const message = error instanceof AppError
      ? error.message
      : 'Не удалось сохранить настройки почты. Попробуйте ещё раз.';
    setError(refs.mailError, locallySaved ? `Настройки сохранены в приложении. ${message}` : message);
    setMailStatus('error', 'Почтовый сервис не подключён', message);
  } finally {
    setMailFormBusy(false);
  }
}

async function handleMailTest() {
  if (busy.mail) return;
  setError(refs.mailError, '');

  let testMail;
  try {
    testMail = {
      ...normalizeMailSettings(state.mail),
      ...readMailForm({ requireConnection: true })
    };
  } catch (error) {
    setError(refs.mailError, error instanceof AppError ? error.message : 'Проверьте настройки почты.');
    if (!refs.mailEditor.hidden) {
      refs.mailEmail.focus();
    }
    return;
  }

  if (state.mailSyncTimer) {
    clearTimeout(state.mailSyncTimer);
    state.mailSyncTimer = null;
  }

  setMailFormBusy(true, 'test');
  setMailStatus('syncing', 'Проверяем отправку', 'Отправляем тестовое письмо через почтовый сервис');

  try {
    const result = await mailApiRequest('/api/test', {
      method: 'POST',
      body: {
        config: toBackendMailConfig(testMail),
        snapshot: buildMailSnapshot(),
        archive: makeBackupEnvelope(state.account)
      },
      mail: testMail
    });

    if (!result.ok) {
      throw new AppError('Почтовый сервис не подтвердил отправку письма.');
    }

    setMailStatus('connected', 'Проверка пройдена', `Тестовое письмо отправлено на ${testMail.email}`);
    showToast(`Тестовое письмо отправлено на ${testMail.email}. Не забудьте сохранить настройки.`, {
      timeout: 8_000
    });
  } catch (error) {
    console.error(error);
    const message = error instanceof AppError ? error.message : 'Не удалось отправить тестовое письмо.';
    setError(refs.mailError, message);
    setMailStatus('error', 'Тест не отправлен', message);
  } finally {
    setMailFormBusy(false);
  }
}

function handleMailConfigureClick() {
  const open = refs.mailEditor.hidden;
  if (open) {
    refs.mailTimezoneLabel.textContent = `${getBrowserTimeZone()} · ваш часовой пояс`;
  }
  setMailEditorOpen(open);
  if (open) {
    window.setTimeout(() => refs.mailEmail.focus(), 30);
  }
}



function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_500);
}

function downloadBackup() {
  if (!state.account) {
    showToast('Реестр не открыт. Войдите снова.', { type: 'error' });
    return;
  }
  try {
    const envelope = makeBackupEnvelope(state.account);
    const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `priemka-backup-${todayISO()}.json`);
    showToast('Зашифрованная резервная копия скачана. Храните её вместе с паролем.');
  } catch (error) {
    console.error(error);
    showToast('Не удалось создать резервную копию.', { type: 'error' });
  }
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function exportCsv() {
  const records = getFilteredRecords();
  if (records.length === 0) {
    showToast('В текущей выборке нет записей для экспорта.', { type: 'error' });
    return;
  }

  const rows = [
    ['Дата поступления', 'Наименование', 'Единица', 'Количество', 'Примечание', 'Статус', 'Дата архивации', 'Создано', 'Изменено']
  ];

  records.forEach((record) => {
    rows.push([
      formatDate(record.date),
      record.name,
      record.unit,
      csvQtyFormatter.format(record.qty),
      record.note || '',
      record.archivedAt ? 'В архиве' : 'В реестре',
      record.archivedAt ? dateTimeFormatter.format(new Date(record.archivedAt)) : '',
      dateTimeFormatter.format(new Date(record.createdAt)),
      dateTimeFormatter.format(new Date(record.updatedAt))
    ]);
  });

  const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `priemka-${state.view === 'archive' ? 'arhiv' : 'reestr'}-${todayISO()}.csv`);
  showToast(`Экспортировано ${records.length} ${recordWord(records.length)} в CSV.`);
}

/* ---------- Event wiring ---------- */

function bindEvents() {
  setTodayLabels();

  refs.authForm.addEventListener('submit', handleAuthSubmit);
  refs.authForm.addEventListener('input', () => setAuthError(''));
  refs.authUsername.addEventListener('input', () => setAuthError(''));

  refs.restoreLink.addEventListener('click', () => refs.restoreFile.click());
  refs.restoreFile.addEventListener('change', () => {
    const file = refs.restoreFile.files && refs.restoreFile.files[0];
    if (file) {
      handleRestoreFile(file);
    }
  });
  refs.cancelRestore.addEventListener('click', cancelRestore);

  document.querySelectorAll('[data-password-toggle]').forEach((button) => {
    button.addEventListener('click', () => {
      const input = byId(button.dataset.passwordToggle);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      button.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
      const use = button.querySelector('use');
      if (use) use.setAttribute('href', show ? '#i-eye-off' : '#i-eye');
      input.focus({ preventScroll: true });
    });
  });

  refs.addBtn.addEventListener('click', openAddDialog);
  refs.emptyAction.addEventListener('click', () => {
    if (refs.emptyAction.dataset.action === 'reset') {
      resetFilters();
      return;
    }
    if (refs.emptyAction.dataset.action === 'registry') {
      setView('active');
      return;
    }
    openAddDialog();
  });

  refs.tabActive.addEventListener('click', () => setView('active'));
  refs.tabArchive.addEventListener('click', () => setView('archive'));

  refs.searchInput.addEventListener('input', () => {
    state.query = refs.searchInput.value;
    renderLedger();
  });

  refs.periodSelect.addEventListener('change', () => {
    state.period = refs.periodSelect.value;
    renderLedger();
  });

  refs.exportBtn.addEventListener('click', exportCsv);
  refs.settingsExportBtn.addEventListener('click', exportCsv);
  refs.backupBtn.addEventListener('click', downloadBackup);

  refs.recordsBody.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('button[data-action]') : null;
    if (!target) return;
    const recordId = target.dataset.id;
    const action = target.dataset.action;
    if (action === 'edit') {
      openEditDialog(recordId);
    } else if (action === 'archive') {
      requestArchive(recordId);
    } else if (action === 'restore') {
      restoreRecord(recordId).catch((error) => {
        console.error(error);
        showToast(error instanceof AppError ? error.message : 'Не удалось вернуть запись.', { type: 'error' });
      });
    }
  });

  refs.materialForm.addEventListener('submit', handleMaterialSubmit);
  refs.materialForm.addEventListener('input', () => setError(refs.materialError, ''));
  refs.materialDialog.addEventListener('close', () => {
    state.editingId = null;
    refs.materialForm.reset();
    setError(refs.materialError, '');
    refs.materialSubmit.disabled = false;
    refs.materialSubmit.textContent = 'Добавить в реестр';
  });
  refs.materialDialog.addEventListener('cancel', (event) => {
    if (busy.material) event.preventDefault();
  });

  document.querySelectorAll('.unit-chip').forEach((button) => {
    button.addEventListener('click', () => {
      refs.materialUnit.value = button.dataset.unit || '';
      refs.materialQty.focus();
    });
  });

  refs.archiveForm.addEventListener('submit', handleArchiveSubmit);
  refs.archiveForm.addEventListener('input', () => setError(refs.archiveError, ''));
  refs.archiveDialog.addEventListener('close', () => {
    state.pendingArchiveId = null;
    refs.archivePassword.value = '';
    setError(refs.archiveError, '');
    refs.archiveSubmit.disabled = false;
    refs.archiveSubmit.textContent = 'Переместить в архив';
  });
  refs.archiveDialog.addEventListener('cancel', (event) => {
    if (busy.archive) event.preventDefault();
  });

  refs.settingsBtn.addEventListener('click', openSettings);
  refs.passwordForm.addEventListener('submit', handlePasswordSubmit);
  refs.passwordForm.addEventListener('input', () => setError(refs.passwordError, ''));
  refs.settingsDialog.addEventListener('close', closeSettingsAndReset);
  refs.mailConfigureBtn.addEventListener('click', handleMailConfigureClick);
  refs.mailForm.addEventListener('submit', handleMailSave);
  refs.mailForm.addEventListener('input', () => setError(refs.mailError, ''));
  refs.mailFrequency.addEventListener('change', updateMailFrequencyFields);
  refs.mailTestBtn.addEventListener('click', handleMailTest);
  updateMailFrequencyFields();

  refs.lockBtn.addEventListener('click', () => lockApp('Реестр заблокирован.'));
  refs.settingsLockBtn.addEventListener('click', () => lockApp('Реестр заблокирован.'));
  refs.settingsLockLink.addEventListener('click', () => lockApp('Реестр заблокирован.'));

  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = byId(button.dataset.closeDialog);
      closeDialog(dialog);
    });
  });

  refs.brandLink.addEventListener('click', (event) => {
    event.preventDefault();
    state.view = 'active';
    state.query = '';
    state.period = 'all';
    refs.searchInput.value = '';
    refs.periodSelect.value = 'all';
    renderAll();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((eventName) => {
    document.addEventListener(eventName, noteActivity, { passive: true, capture: true });
  });

  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('online', () => {
    if (mailConfigurationReady(state.mail)) {
      queueMailSync(500);
    }
  });

  window.addEventListener('beforeunload', () => {
    clearInactivityTimer();
  });
}

/* ---------- Startup ---------- */

async function init() {
  setTodayLabels();
  bindEvents();
  refs.materialDate.value = todayISO();

  if (!globalThis.crypto || !crypto.subtle) {
    showFatalAuth('Этот браузер не поддерживает современное шифрование. Откройте ПРИЁМКУ в актуальном Chrome, Edge, Firefox или Safari.');
    hideBootScreen();
    return;
  }

  try {
    const result = readAccount();

    if (result.status === 'none') {
      state.account = null;
      showAuth('setup');
    } else if (result.status === 'error') {
      showFatalAuth(result.message);
    } else {
      state.account = result.account;
      const resumed = await tryResumeSession(result.account);
      if (!resumed) {
        showAuth('login');
      }
    }
  } catch (error) {
    console.error(error);
    showFatalAuth('Не удалось открыть локальный реестр. Попробуйте перезагрузить страницу.');
  } finally {
    hideBootScreen();
    registerServiceWorker();
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(window.location.protocol)) {
    return;
  }

  const register = () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error);
    });
  };

  if (document.readyState === 'complete') {
    register();
  } else {
    window.addEventListener('load', register, { once: true });
  }
}

init();
