import { isValidTimeZone } from './schedule.mjs';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const MAX_RECORDS = 10_000;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function isValidEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value);
}

export function isValidDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidIsoTimestamp(value) {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function requireString(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw new HttpError(400, `Поле «${field}» заполнено неверно.`);
  }
  const text = value.trim();
  if (!text) {
    throw new HttpError(400, `Поле «${field}» не заполнено.`);
  }
  if (text.length > maxLength) {
    throw new HttpError(400, `Поле «${field}» слишком длинное.`);
  }
  return text;
}

export function validateConfig(input) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'Некорректные настройки почты.');
  }

  const email = requireString(input.email, 'Email получателя', 254);
  if (!isValidEmail(email)) {
    throw new HttpError(400, 'Укажите корректный email получателя.');
  }

  if (!['daily', 'weekly', 'monthly'].includes(input.frequency)) {
    throw new HttpError(400, 'Некорректная частота отправки.');
  }

  const time = requireString(input.time, 'Время отправки', 5);
  if (!TIME_RE.test(time)) {
    throw new HttpError(400, 'Укажите время отправки в формате ЧЧ:ММ.');
  }

  const timezone = requireString(input.timezone, 'Часовой пояс', 80);
  if (!isValidTimeZone(timezone)) {
    throw new HttpError(400, 'Укажите корректный часовой пояс IANA.');
  }

  let weekday = null;
  if (input.frequency === 'weekly') {
    weekday = Number(input.weekday);
    if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
      throw new HttpError(400, 'Выберите день недели для отправки.');
    }
  }

  let dayOfMonth = null;
  if (input.frequency === 'monthly') {
    dayOfMonth = Number(input.dayOfMonth);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      throw new HttpError(400, 'Выберите день месяца с 1 по 28.');
    }
  }

  if (!['today', '7', '30', 'all'].includes(String(input.range))) {
    throw new HttpError(400, 'Некорректный период данных для отчёта.');
  }

  if (typeof input.enabled !== 'boolean') {
    throw new HttpError(400, 'Некорректный флаг автоматической отправки.');
  }

  return {
    enabled: input.enabled,
    email,
    frequency: input.frequency,
    time,
    timezone,
    weekday,
    dayOfMonth,
    range: String(input.range),
    attachArchive: input.attachArchive !== false
  };
}

function validateRecord(input, index) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, `Запись №${index + 1} имеет некорректный формат.`);
  }

  if (!isValidDate(input.date)) {
    throw new HttpError(400, `Запись №${index + 1}: некорректная дата.`);
  }

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const unit = typeof input.unit === 'string' ? input.unit.trim() : '';
  const note = typeof input.note === 'string' ? input.note : '';
  const qty = Number(input.qty);

  if (!name || name.length > 200) {
    throw new HttpError(400, `Запись №${index + 1}: некорректное наименование.`);
  }
  if (!unit || unit.length > 20) {
    throw new HttpError(400, `Запись №${index + 1}: некорректная единица измерения.`);
  }
  if (note.length > 500) {
    throw new HttpError(400, `Запись №${index + 1}: слишком длинное примечание.`);
  }
  if (!Number.isFinite(qty) || qty <= 0 || qty > 999_999_999.999) {
    throw new HttpError(400, `Запись №${index + 1}: некорректное количество.`);
  }

  return {
    date: input.date,
    name,
    unit,
    qty: Math.round(qty * 1000) / 1000,
    note
  };
}

export function validateSnapshot(input) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'Не передан снимок реестра.');
  }
  if (!Array.isArray(input.records)) {
    throw new HttpError(400, 'Список материалов передан неверно.');
  }
  if (input.records.length > MAX_RECORDS) {
    throw new HttpError(400, 'В реестре слишком много записей для синхронизации.');
  }
  if (!isValidIsoTimestamp(input.generatedAt)) {
    throw new HttpError(400, 'Некорректное время снимка реестра.');
  }

  const archivedCount = Number(input.archivedCount);
  if (!Number.isInteger(archivedCount) || archivedCount < 0 || archivedCount > 1_000_000) {
    throw new HttpError(400, 'Некорректное количество записей в архиве.');
  }

  return {
    username: typeof input.username === 'string' ? input.username.slice(0, 64) : '',
    generatedAt: input.generatedAt,
    archivedCount,
    records: input.records.map(validateRecord)
  };
}

export function validateArchive(input) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'Не передана зашифрованная резервная копия реестра.');
  }
  if (input.format !== 'priemka-backup' || input.version !== 1) {
    throw new HttpError(400, 'Некорректный формат резервной копии.');
  }
  const account = input.account;
  if (!account || typeof account !== 'object' || account.app !== 'priemka' || account.schema !== 1) {
    throw new HttpError(400, 'Повреждённые данные резервной копии.');
  }
  if (!account.vault || typeof account.vault.iv !== 'string' || typeof account.vault.data !== 'string') {
    throw new HttpError(400, 'В резервной копии отсутствуют зашифрованные данные.');
  }

  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input), 'utf8');
  } catch {
    throw new HttpError(400, 'Не удалось обработать резервную копию.');
  }
  if (bytes > MAX_ARCHIVE_BYTES) {
    throw new HttpError(413, 'Резервная копия слишком большая для отправки по почте.');
  }

  return input;
}

export function validateSyncPayload(body, { requireSnapshot = false } = {}) {
  if (!body || typeof body !== 'object') {
    throw new HttpError(400, 'Некорректный запрос.');
  }

  const config = validateConfig(body.config);
  let snapshot = null;
  let archive = null;

  if (requireSnapshot || config.enabled) {
    snapshot = validateSnapshot(body.snapshot);
    if (config.attachArchive) {
      archive = validateArchive(body.archive);
    }
  }

  return { config, snapshot, archive };
}
