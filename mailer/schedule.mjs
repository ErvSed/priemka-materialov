const DAY_MS = 86_400_000;

export const WEEKDAYS = {
  1: 'каждый понедельник',
  2: 'каждый вторник',
  3: 'каждую среду',
  4: 'каждый четверг',
  5: 'каждую пятницу',
  6: 'каждую субботу',
  7: 'каждое воскресенье'
};

const formatterCache = new Map();

function getFormatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      })
    );
  }
  return formatterCache.get(timeZone);
}

export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length > 80) return false;
  try {
    getFormatter(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function getZonedParts(date, timeZone) {
  const parts = Object.fromEntries(
    getFormatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function offsetMilliseconds(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock time in an IANA zone to a UTC Date.
 * The iterative offset correction also behaves sensibly around DST changes.
 */
export function zonedDateTimeToUtc(year, month, day, hour, minute, timeZone) {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let timestamp = localAsUtc;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const offset = offsetMilliseconds(new Date(timestamp), timeZone);
    const next = localAsUtc - offset;
    if (next === timestamp) break;
    timestamp = next;
  }

  return new Date(timestamp);
}

export function localDateISO(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function addCalendarDays(isoDate, days) {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

export function nextScheduledAt(config, from = new Date()) {
  const timeZone = config.timezone;
  const [hour, minute] = String(config.time).split(':').map(Number);
  const start = getZonedParts(from, timeZone);
  const startCalendar = Date.UTC(start.year, start.month - 1, start.day);
  const maxDays = config.frequency === 'monthly' ? 370 : config.frequency === 'weekly' ? 15 : 3;

  for (let offset = 0; offset <= maxDays; offset += 1) {
    const calendar = new Date(startCalendar + offset * DAY_MS);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    const weekday = calendar.getUTCDay() === 0 ? 7 : calendar.getUTCDay();

    if (config.frequency === 'weekly' && weekday !== config.weekday) continue;
    if (config.frequency === 'monthly' && day !== config.dayOfMonth) continue;

    const candidate = zonedDateTimeToUtc(year, month, day, hour, minute, timeZone);
    if (candidate.getTime() > from.getTime()) {
      return candidate;
    }
  }

  throw new Error('Не удалось рассчитать следующую отправку');
}

export function scheduleFingerprint(config) {
  return JSON.stringify({
    frequency: config.frequency,
    time: config.time,
    weekday: config.weekday,
    dayOfMonth: config.dayOfMonth,
    timezone: config.timezone
  });
}

export function describeSchedule(config) {
  const time = config.time;
  if (config.frequency === 'daily') {
    return `ежедневно в ${time}`;
  }
  if (config.frequency === 'weekly') {
    return `${WEEKDAYS[config.weekday] || 'еженедельно'} в ${time}`;
  }
  return `ежемесячно, ${config.dayOfMonth}-го числа, в ${time}`;
}

export function getRangeWindow(range, now, timeZone) {
  const today = localDateISO(now, timeZone);

  if (range === 'all') {
    return {
      from: null,
      to: today,
      label: 'за всё время',
      shortLabel: 'Всё время'
    };
  }

  if (range === 'today') {
    return {
      from: today,
      to: today,
      label: 'за сегодня',
      shortLabel: 'Сегодня'
    };
  }

  const days = Number(range);
  return {
    from: addCalendarDays(today, -(days - 1)),
    to: today,
    label: `за последние ${days} дней`,
    shortLabel: `Последние ${days} дней`
  };
}

export function formatDateTimeInZone(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}, ${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
}
