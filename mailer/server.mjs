import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { createMailer } from './mailer.mjs';
import { createStateStore } from './state-store.mjs';
import {
  HttpError,
  validateArchive,
  validateConfig,
  validateSnapshot,
  validateSyncPayload
} from './validation.mjs';
import {
  describeSchedule,
  formatDateTimeInZone,
  nextScheduledAt,
  scheduleFingerprint
} from './schedule.mjs';

const SERVICE_VERSION = '1.0.0';
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.MAIL_API_TOKEN || '';
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const TICK_MS = Math.max(5_000, Number(process.env.SCHEDULER_TICK_MS || 30_000));
const MAX_BODY_BYTES = 15 * 1024 * 1024;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://ervsed.github.io,http://127.0.0.1:8765,http://localhost:8765,http://127.0.0.1:8080,http://localhost:8080')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!API_TOKEN || API_TOKEN.length < 24) {
  console.error('MAIL_API_TOKEN не задан или короче 24 символов. Сервис не запущен.');
  process.exit(1);
}
if (API_TOKEN.includes('replace-with') || API_TOKEN.toLowerCase().includes('changeme')) {
  console.error('MAIL_API_TOKEN содержит значение-заглушку. Сгенерируйте новый случайный ключ.');
  process.exit(1);
}

const mailer = createMailer(process.env);
const store = createStateStore({ dataDir: DATA_DIR, token: API_TOKEN });

const emptyState = () => ({
  version: 1,
  config: null,
  snapshot: null,
  archive: null,
  syncedAt: null,
  nextRunAt: null,
  lastSentAt: null,
  lastError: null,
  sentCount: 0,
  scheduleFingerprint: null
});

let state = emptyState();
let tickInProgress = false;
let stateQueue = Promise.resolve();
let schedulerTimer = null;
let server = null;

function withStateLock(task) {
  const next = stateQueue.then(task, task);
  stateQueue = next.catch(() => {});
  return next;
}

function safeCompare(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function getRequestToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length);
}

function originAllowed(origin) {
  if (!origin) return true;
  return ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
}

function baseHeaders(origin) {
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  };
  if (origin && originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  return headers;
}

function sendJson(res, status, payload, origin = '') {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    ...baseHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length
  });
  res.end(body);
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Слишком большой запрос.');
    }
    chunks.push(chunk);
  }
  if (size === 0) {
    throw new HttpError(400, 'Пустой запрос.');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Тело запроса не является корректным JSON.');
  }
}

function buildStatus() {
  if (!state.config) {
    return {
      ok: true,
      enabled: false,
      configured: false,
      smtpConfigured: mailer.configured,
      nextRunAt: null,
      nextRunLocal: null,
      lastSentAt: null,
      lastSentLocal: null,
      lastError: null,
      syncedAt: null,
      recordCount: 0,
      archivedCount: 0,
      scheduleDescription: null,
      serverTime: new Date().toISOString()
    };
  }

  const timeZone = state.config.timezone;
  return {
    ok: true,
    enabled: Boolean(state.config.enabled),
    configured: Boolean(state.config.email),
    email: state.config.email,
    frequency: state.config.frequency,
    time: state.config.time,
    timezone: state.config.timezone,
    weekday: state.config.weekday,
    dayOfMonth: state.config.dayOfMonth,
    range: state.config.range,
    scheduleDescription: describeSchedule(state.config),
    nextRunAt: state.nextRunAt,
    nextRunLocal: state.nextRunAt ? formatDateTimeInZone(new Date(state.nextRunAt), timeZone) : null,
    lastSentAt: state.lastSentAt,
    lastSentLocal: state.lastSentAt ? formatDateTimeInZone(new Date(state.lastSentAt), timeZone) : null,
    lastError: state.lastError,
    syncedAt: state.syncedAt,
    syncedLocal: state.syncedAt ? formatDateTimeInZone(new Date(state.syncedAt), timeZone) : null,
    recordCount: state.snapshot?.records?.length || 0,
    archivedCount: state.snapshot?.archivedCount || 0,
    sentCount: state.sentCount,
    smtpConfigured: mailer.configured,
    serverTime: new Date().toISOString()
  };
}

function maskEmail(email) {
  const value = String(email || '');
  const [local, domain] = value.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

async function ensureNextRun(reason = 'startup') {
  if (!state.config?.enabled || !state.snapshot) {
    return false;
  }
  if (state.nextRunAt && Number.isFinite(Date.parse(state.nextRunAt))) {
    return false;
  }
  state.nextRunAt = nextScheduledAt(state.config, new Date()).toISOString();
  state.scheduleFingerprint = scheduleFingerprint(state.config);
  await store.save(state);
  console.log(`Next scheduled report (${reason}): ${state.nextRunAt}`);
  return true;
}

async function handleSync(body) {
  return withStateLock(async () => {
    if (!body || typeof body !== 'object') {
      throw new HttpError(400, 'Некорректный запрос.');
    }

    const previousEnabled = state.config?.enabled === true;
    const previousFingerprint = state.config ? state.scheduleFingerprint || scheduleFingerprint(state.config) : null;
    const { config, snapshot, archive } = validateSyncPayload(body, {
      requireSnapshot: Boolean(body.config?.enabled)
    });

    if (!config.enabled) {
      const hadData = Boolean(state.snapshot || state.archive);
      state.config = config;
      state.snapshot = null;
      state.archive = null;
      state.syncedAt = null;
      state.nextRunAt = null;
      state.scheduleFingerprint = null;
      if (hadData) state.lastError = null;
      await store.save(state);
      return buildStatus();
    }

    if (!snapshot) {
      throw new HttpError(400, 'Не передан снимок реестра для автоматической отправки.');
    }

    const fingerprint = scheduleFingerprint(config);
    const scheduleChanged = !previousEnabled || previousFingerprint !== fingerprint;
    const now = new Date();

    state.config = config;
    state.snapshot = snapshot;
    state.archive = archive;
    state.syncedAt = now.toISOString();
    state.lastError = null;
    state.scheduleFingerprint = fingerprint;

    if (scheduleChanged || !state.nextRunAt) {
      state.nextRunAt = nextScheduledAt(config, now).toISOString();
    }

    await store.save(state);
    return buildStatus();
  });
}

async function handleTest(body) {
  const { config, snapshot, archive } = validateSyncPayload(body, { requireSnapshot: true });
  if (!snapshot) {
    throw new HttpError(400, 'Не передан снимок реестра для тестового письма.');
  }

  const result = await mailer.sendReport({
    config,
    snapshot,
    archive,
    isTest: true
  });

  return {
    ok: true,
    messageId: result.messageId,
    accepted: result.accepted,
    report: result.reportSummary,
    smtpConfigured: mailer.configured
  };
}

async function sendScheduledReport() {
  if (!state.config?.enabled || !state.snapshot || !state.nextRunAt) {
    return;
  }
  const dueAt = Date.parse(state.nextRunAt);
  if (!Number.isFinite(dueAt) || Date.now() < dueAt) {
    return;
  }

  console.log(`Sending scheduled report to ${maskEmail(state.config.email)}`);
  try {
    const result = await mailer.sendReport({
      config: state.config,
      snapshot: state.snapshot,
      archive: state.archive,
      isTest: false
    });
    state.lastSentAt = new Date().toISOString();
    state.lastError = null;
    state.sentCount += 1;
    console.log(`Scheduled report sent: ${result.messageId}`);
  } catch (error) {
    state.lastError = error instanceof HttpError ? error.message : 'Ошибка отправки почты.';
    console.error('Scheduled report failed:', error.message || error);
  } finally {
    try {
      state.nextRunAt = nextScheduledAt(state.config, new Date(Date.now() + 60_000)).toISOString();
    } catch (error) {
      state.nextRunAt = null;
      state.lastError = 'Не удалось рассчитать следующую отправку.';
      console.error(error);
    }
    await store.save(state);
  }
}

async function schedulerTick() {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    await withStateLock(async () => {
      if (!state.config?.enabled || !state.snapshot) return;
      if (!state.nextRunAt || !Number.isFinite(Date.parse(state.nextRunAt))) {
        await ensureNextRun('scheduler');
        return;
      }
      await sendScheduledReport();
    });
  } catch (error) {
    console.error('Scheduler tick failed:', error);
  } finally {
    tickInProgress = false;
  }
}

const testRate = new Map();

function checkTestRate(ip) {
  const now = Date.now();
  const entry = testRate.get(ip) || { count: 0, resetAt: now + 60_000 };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + 60_000;
  }
  entry.count += 1;
  testRate.set(ip, entry);
  if (entry.count > 6) {
    throw new HttpError(429, 'Слишком много тестовых писем. Подождите минуту.');
  }
}

async function handleRequest(req, res) {
  const origin = req.headers.origin || '';
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const clientIp = req.socket.remoteAddress || 'unknown';

  if (origin && !originAllowed(origin)) {
    sendJson(res, 403, { ok: false, error: 'Origin не разрешён.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...baseHeaders(origin),
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '600'
    });
    res.end();
    return;
  }

  if (url.pathname === '/health' && req.method === 'GET') {
    sendJson(
      res,
      200,
      {
        ok: true,
        service: 'priemka-mailer',
        version: SERVICE_VERSION,
        smtpConfigured: mailer.configured,
        enabled: Boolean(state.config?.enabled),
        serverTime: new Date().toISOString()
      },
      origin
    );
    return;
  }

  const protectedPaths = new Set(['/api/sync', '/api/test', '/api/status']);
  if (protectedPaths.has(url.pathname)) {
    if (!safeCompare(getRequestToken(req), API_TOKEN)) {
      sendJson(res, 401, { ok: false, error: 'Неверный ключ доступа.' }, origin);
      return;
    }
  }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    sendJson(res, 200, buildStatus(), origin);
    return;
  }

  if (url.pathname === '/api/sync' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const status = await handleSync(body);
    sendJson(res, 200, status, origin);
    return;
  }

  if (url.pathname === '/api/test' && req.method === 'POST') {
    checkTestRate(clientIp);
    const body = await readJsonBody(req);
    const result = await handleTest(body);
    sendJson(res, 200, result, origin);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Метод не найден.' }, origin);
}

async function start() {
  try {
    const loaded = await store.load();
    state = { ...emptyState(), ...(loaded || {}) };
    if (state.config) {
      const validatedConfig = validateConfig(state.config);
      state.config = validatedConfig;
      if (state.snapshot) state.snapshot = validateSnapshot(state.snapshot);
      if (state.archive) state.archive = validateArchive(state.archive);
    }
  } catch (error) {
    console.error('Не удалось загрузить состояние:', error.message);
    process.exit(1);
  }

  try {
    if (state.config?.enabled && state.snapshot) {
      await ensureNextRun('startup');
    }
  } catch (error) {
    console.error('Не удалось рассчитать расписание при запуске:', error);
    state.lastError = 'Не удалось рассчитать расписание отправки.';
    await store.save(state).catch(() => {});
  }

  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message }, req.headers.origin || '');
        return;
      }
      console.error('Unhandled request error:', error);
      sendJson(
        res,
        500,
        { ok: false, error: 'Внутренняя ошибка почтового сервера.' },
        req.headers.origin || ''
      );
    });
  });

  server.listen(PORT, HOST, () => {
    console.log(`ПРИЁМКА mailer v${SERVICE_VERSION} слушает http://${HOST}:${PORT}`);
    console.log(`Данные: ${store.filePath}`);
    console.log(`SMTP: ${mailer.configured ? 'настроен' : 'НЕ НАСТРОЕН'}`);
    console.log(`Разрешённые Origin: ${ALLOWED_ORIGINS.join(', ')}`);
    schedulerTimer = setInterval(() => {
      schedulerTick().catch((error) => console.error('Scheduler error:', error));
    }, TICK_MS);
    schedulerTick().catch((error) => console.error('Initial scheduler error:', error));
  });
}

async function shutdown(signal) {
  console.log(`\n${signal}: завершаем работу.`);
  if (schedulerTimer) clearInterval(schedulerTimer);
  mailer.close();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    await stateQueue;
    await store.save(state);
  } catch (error) {
    console.error('Не удалось сохранить состояние при выходе:', error);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start().catch((error) => {
  console.error('Mailer failed to start:', error);
  process.exit(1);
});
