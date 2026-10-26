import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  getRangeWindow,
  localDateISO,
  nextScheduledAt,
  scheduleFingerprint
} from '../schedule.mjs';
import { buildReport } from '../report.mjs';
import { createStateStore } from '../state-store.mjs';
import {
  HttpError,
  validateArchive,
  validateConfig,
  validateSnapshot
} from '../validation.mjs';

const baseConfig = {
  enabled: true,
  email: 'reports@example.com',
  frequency: 'daily',
  time: '18:00',
  timezone: 'Europe/Moscow',
  weekday: null,
  dayOfMonth: null,
  range: '7',
  attachArchive: true
};

const archive = {
  app: 'priemka',
  format: 'priemka-backup',
  version: 1,
  exportedAt: '2026-10-26T10:00:00.000Z',
  account: {
    app: 'priemka',
    schema: 1,
    username: 'admin',
    vault: { iv: 'AAAA', data: 'BBBB' }
  }
};

const snapshot = {
  username: 'admin',
  generatedAt: '2026-10-26T12:00:00.000Z',
  archivedCount: 1,
  records: [
    {
      date: '2026-10-26',
      name: 'Гипсокартон <script>alert(1)</script>',
      unit: 'лист',
      qty: 24,
      note: 'Накладная № 148'
    },
    {
      date: '2026-10-24',
      name: 'Профиль ПН-2',
      unit: 'шт',
      qty: 36,
      note: ''
    },
    {
      date: '2026-09-01',
      name: 'Старый материал',
      unit: 'кг',
      qty: 1,
      note: ''
    }
  ]
};

test('local date is calculated in the configured timezone', () => {
  assert.equal(localDateISO(new Date('2026-10-26T22:30:00Z'), 'Europe/Moscow'), '2026-10-27');
  assert.equal(localDateISO(new Date('2026-10-26T20:30:00Z'), 'Europe/Moscow'), '2026-10-26');
});

test('daily schedule is calculated in the configured timezone', () => {
  const next = nextScheduledAt(baseConfig, new Date('2026-10-26T10:00:00Z'));
  assert.equal(next.toISOString(), '2026-10-26T15:00:00.000Z');
});

test('weekly schedule finds the next configured weekday', () => {
  const next = nextScheduledAt(
    { ...baseConfig, frequency: 'weekly', weekday: 5 },
    new Date('2026-10-26T10:00:00Z')
  );
  assert.equal(next.toISOString(), '2026-10-30T15:00:00.000Z');
});

test('monthly schedule moves to the next month when the day has passed', () => {
  const next = nextScheduledAt(
    { ...baseConfig, frequency: 'monthly', dayOfMonth: 5 },
    new Date('2026-10-26T10:00:00Z')
  );
  assert.equal(next.toISOString(), '2026-11-05T15:00:00.000Z');
});

test('a passed time moves to the next day', () => {
  const next = nextScheduledAt(baseConfig, new Date('2026-10-26T16:00:00Z'));
  assert.equal(next.toISOString(), '2026-10-27T15:00:00.000Z');
});

test('schedule fingerprint ignores the email recipient', () => {
  assert.equal(
    scheduleFingerprint(baseConfig),
    scheduleFingerprint({ ...baseConfig, email: 'other@example.com' })
  );
});

test('range windows are inclusive and calendar-based', () => {
  const seven = getRangeWindow('7', new Date('2026-10-26T12:00:00Z'), 'Europe/Moscow');
  assert.equal(seven.from, '2026-10-20');
  assert.equal(seven.to, '2026-10-26');

  const today = getRangeWindow('today', new Date('2026-10-26T12:00:00Z'), 'Europe/Moscow');
  assert.equal(today.from, '2026-10-26');
  assert.equal(today.to, '2026-10-26');

  const all = getRangeWindow('all', new Date('2026-10-26T12:00:00Z'), 'Europe/Moscow');
  assert.equal(all.from, null);
});

test('email report filters by period, totals units and escapes HTML', () => {
  const report = buildReport({
    config: baseConfig,
    snapshot,
    now: new Date('2026-10-26T12:00:00Z'),
    isTest: false,
    archiveAttached: true
  });

  assert.equal(report.count, 2);
  assert.match(report.subject, /ПРИЁМКА/);
  assert.match(report.subject, /последние 7 дней/);
  assert.match(report.html, /Гипсокартон &lt;script&gt;/);
  assert.doesNotMatch(report.html, /<script>alert/);
  assert.match(report.html, /24/);
  assert.match(report.html, /зашифрованная резервная копия/i);
  assert.match(report.csv.toString('utf8'), /Гипсокартон/);
  assert.ok(report.csv.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.deepEqual(report.totals, [['шт', 36], ['лист', 24]]);
});

test('email report includes a test banner', () => {
  const report = buildReport({
    config: baseConfig,
    snapshot,
    now: new Date('2026-10-26T12:00:00Z'),
    isTest: true,
    archiveAttached: false
  });
  assert.match(report.subject, /^\[ТЕСТ\]/);
  assert.match(report.html, /Тестовое письмо/);
});

test('mail config validation accepts a complete config', () => {
  const config = validateConfig(baseConfig);
  assert.equal(config.email, 'reports@example.com');
  assert.equal(config.enabled, true);
  assert.equal(config.weekday, null);
});

test('mail config validation rejects invalid values', () => {
  assert.throws(() => validateConfig({ ...baseConfig, time: '25:10' }), HttpError);
  assert.throws(() => validateConfig({ ...baseConfig, email: 'bad@' }), HttpError);
  assert.throws(
    () => validateConfig({ ...baseConfig, frequency: 'weekly', weekday: null }),
    HttpError
  );
  assert.throws(
    () => validateConfig({ ...baseConfig, frequency: 'monthly', dayOfMonth: 31 }),
    HttpError
  );
});

test('snapshot validation rejects invalid quantities', () => {
  assert.throws(
    () => validateSnapshot({ ...snapshot, records: [{ ...snapshot.records[0], qty: 0 }] }),
    HttpError
  );
  assert.throws(() => validateSnapshot({ ...snapshot, generatedAt: 'not-a-date' }), HttpError);
});

test('archive validation accepts an encrypted backup envelope', () => {
  assert.equal(validateArchive(archive).format, 'priemka-backup');
  assert.throws(() => validateArchive({ ...archive, format: 'wrong' }), HttpError);
});

test('state store encrypts data at rest and rejects a wrong token', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'priemka-state-test-'));
  try {
    const token = 'unit-test-token-0123456789abcdef';
    const store = createStateStore({ dataDir, token });
    const state = {
      version: 1,
      config: { enabled: true, email: 'secret@example.com' },
      snapshot: { records: [{ name: 'Секретный материал' }] }
    };

    await store.save(state);
    const onDisk = await readFile(path.join(dataDir, 'state.bin'), 'utf8');
    assert.doesNotMatch(onDisk, /Секретный материал/);
    assert.doesNotMatch(onDisk, /secret@example\.com/);

    const loaded = await store.load();
    assert.deepEqual(loaded, state);

    const wrongTokenStore = createStateStore({ dataDir, token: 'another-token-0123456789abcdef' });
    await assert.rejects(() => wrongTokenStore.load(), /расшифровать/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
