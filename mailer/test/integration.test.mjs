import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const ORIGIN = 'http://127.0.0.1:8765';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitFor(predicate, timeoutMs = 20_000, intervalMs = 200) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    async function poll() {
      try {
        if (await predicate()) {
          resolve();
          return;
        }
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Condition was not met in ${timeoutMs} ms`));
          return;
        }
        setTimeout(poll, intervalMs);
      } catch (error) {
        reject(error);
      }
    }
    poll();
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function makeSnapshot() {
  return {
    username: 'admin',
    generatedAt: new Date().toISOString(),
    archivedCount: 1,
    records: [
      {
        date: todayISO(),
        name: 'Тестовая плитка',
        unit: 'м²',
        qty: 12.5,
        note: 'Накладная № 1'
      },
      {
        date: '2020-01-01',
        name: 'Старая позиция',
        unit: 'шт',
        qty: 999,
        note: ''
      }
    ]
  };
}

function makeConfig(overrides = {}) {
  return {
    enabled: true,
    email: 'recipient@example.com',
    frequency: 'daily',
    time: '18:00',
    timezone: 'UTC',
    weekday: null,
    dayOfMonth: null,
    range: '7',
    attachArchive: true,
    ...overrides
  };
}

function makeArchive() {
  return {
    app: 'priemka',
    format: 'priemka-backup',
    version: 1,
    exportedAt: new Date().toISOString(),
    account: {
      app: 'priemka',
      schema: 1,
      username: 'admin',
      salt: 'c2FsdHNhbHRzYWx0',
      iterations: 310000,
      verifier: { iv: 'YWJjZGVmZ2hpamts', data: 'dmVyaWZpZXI=' },
      vault: { iv: 'YWJjZGVmZ2hpamts', data: 'dmF1bHQ=' }
    }
  };
}

async function request(baseUrl, pathname, { method = 'GET', body = null, token = TOKEN, origin = ORIGIN } = {}) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  return { response, data };
}

test('mailer sends test and scheduled reports, protects API and encrypts state', { timeout: 150_000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'priemka-mailer-test-'));
  const messages = [];
  const smtpPort = await freePort();
  const serverPort = await freePort();
  const smtp = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => {
        messages.push(Buffer.concat(chunks));
        callback(null, 'Message queued');
      });
      stream.on('error', callback);
    }
  });

  await new Promise((resolve, reject) => {
    smtp.listen(smtpPort, '127.0.0.1', (error) => (error ? reject(error) : resolve()));
  });

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(serverPort),
      HOST: '127.0.0.1',
      MAIL_API_TOKEN: TOKEN,
      ALLOWED_ORIGINS: ORIGIN,
      DATA_DIR: dataDir,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(smtpPort),
      SMTP_SECURE: 'false',
      SMTP_REQUIRE_TLS: 'false',
      SMTP_FROM: 'ПРИЁМКА <test@priemka.local>',
      SCHEDULER_TICK_MS: '5000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });

  const baseUrl = `http://127.0.0.1:${serverPort}`;

  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await new Promise((resolve) => smtp.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });

  await waitFor(async () => {
    try {
      const response = await fetch(`${baseUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }, 15_000);

  const health = await request(baseUrl, '/health', { token: '' });
  assert.equal(health.response.status, 200);
  assert.equal(health.data.smtpConfigured, true);

  const noAuth = await request(baseUrl, '/api/test', {
    method: 'POST',
    token: '',
    body: { config: makeConfig({ enabled: false }), snapshot: makeSnapshot(), archive: makeArchive() }
  });
  assert.equal(noAuth.response.status, 401);

  const badOrigin = await request(baseUrl, '/api/test', {
    method: 'POST',
    origin: 'https://evil.example',
    body: { config: makeConfig({ enabled: false }), snapshot: makeSnapshot(), archive: makeArchive() }
  });
  assert.equal(badOrigin.response.status, 403);

  const testSend = await request(baseUrl, '/api/test', {
    method: 'POST',
    body: { config: makeConfig({ enabled: false }), snapshot: makeSnapshot(), archive: makeArchive() }
  });
  assert.equal(testSend.response.status, 200, JSON.stringify(testSend.data));
  assert.equal(testSend.data.ok, true);

  await waitFor(() => messages.length === 1, 15_000);
  const testMessage = await simpleParser(messages[0]);
  assert.match(testMessage.subject, /^\[ТЕСТ\]/);
  assert.equal(testMessage.to.value[0].address, 'recipient@example.com');
  assert.match(testMessage.html, /Тестовая плитка/);
  assert.match(testMessage.text, /Тестовая плитка/);
  assert.doesNotMatch(testMessage.html, /Старая позиция/);
  assert.equal(testMessage.attachments.length, 2);
  assert.ok(testMessage.attachments.some((item) => item.filename.endsWith('.csv')));
  const archiveAttachment = testMessage.attachments.find((item) => item.filename.endsWith('.json'));
  assert.ok(archiveAttachment);
  assert.equal(JSON.parse(archiveAttachment.content.toString('utf8')).format, 'priemka-backup');

  // Schedule a report for the next UTC minute and let the real scheduler send it.
  const scheduledMinute = new Date(Date.now() + 70_000);
  const scheduleTime = `${String(scheduledMinute.getUTCHours()).padStart(2, '0')}:${String(scheduledMinute.getUTCMinutes()).padStart(2, '0')}`;
  const sync = await request(baseUrl, '/api/sync', {
    method: 'POST',
    body: {
      config: makeConfig({ enabled: true, time: scheduleTime }),
      snapshot: makeSnapshot(),
      archive: makeArchive()
    }
  });
  assert.equal(sync.response.status, 200, JSON.stringify(sync.data));
  assert.equal(sync.data.enabled, true);
  assert.ok(sync.data.nextRunAt);
  assert.equal(sync.data.recordCount, 2);

  const status = await request(baseUrl, '/api/status');
  assert.equal(status.response.status, 200);
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.email, 'recipient@example.com');

  const stateFile = await readFile(path.join(dataDir, 'state.bin'), 'utf8');
  assert.doesNotMatch(stateFile, /Тестовая плитка/);
  assert.doesNotMatch(stateFile, /recipient@example\.com/);

  const sendDeadline = new Date(`${scheduledMinute.toISOString().slice(0, 10)}T${scheduleTime}:00.000Z`).getTime() + 20_000;
  await waitFor(() => messages.length >= 2 || Date.now() > sendDeadline, Math.max(20_000, sendDeadline - Date.now()));
  assert.equal(messages.length, 2, 'Scheduled report should be delivered');

  const scheduledMessage = await simpleParser(messages[1]);
  assert.doesNotMatch(scheduledMessage.subject, /^\[ТЕСТ\]/);
  assert.match(scheduledMessage.html, /Тестовая плитка/);
  assert.equal(scheduledMessage.attachments.length, 2);

  const disable = await request(baseUrl, '/api/sync', {
    method: 'POST',
    body: { config: makeConfig({ enabled: false }) }
  });
  assert.equal(disable.response.status, 200);
  assert.equal(disable.data.enabled, false);

  const disabledStatus = await request(baseUrl, '/api/status');
  assert.equal(disabledStatus.data.enabled, false);
  assert.equal(disabledStatus.data.recordCount, 0);

  console.log('Mailer integration log:', logs.trim().split('\n').slice(-8).join(' | '));
});
