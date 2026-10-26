import {
  describeSchedule,
  formatDateTimeInZone,
  getRangeWindow,
  localDateISO
} from './schedule.mjs';

const UNIT_ORDER = ['шт', 'м', 'м²', 'м³', 'кг', 'т', 'компл.', 'упак.', 'рул.', 'меш.', 'л', 'лист'];
const qtyFormatter = new Intl.NumberFormat('ru-RU', {
  maximumFractionDigits: 3,
  minimumFractionDigits: 0
});
const csvQtyFormatter = new Intl.NumberFormat('ru-RU', {
  useGrouping: false,
  maximumFractionDigits: 3,
  minimumFractionDigits: 0
});

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pluralRu(count, one, few, many) {
  const value = Math.abs(Number(count)) % 100;
  const last = value % 10;
  if (value > 10 && value < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

function recordsWord(count) {
  return pluralRu(count, 'запись', 'записи', 'записей');
}

function unitsWord(count) {
  return pluralRu(count, 'единица', 'единицы', 'единиц');
}

export function formatQuantity(value) {
  return qtyFormatter.format(Number(value) || 0);
}

export function formatDateRu(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return '—';
  }
  const [year, month, day] = isoDate.split('-');
  return `${day}.${month}.${year}`;
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replaceAll('"', '""')}"`;
}

function buildCsv(records) {
  const rows = [
    ['Дата поступления', 'Наименование', 'Единица', 'Количество', 'Примечание']
  ];

  records.forEach((record) => {
    rows.push([
      formatDateRu(record.date),
      record.name,
      record.unit,
      csvQtyFormatter.format(record.qty),
      record.note || ''
    ]);
  });

  return Buffer.from(
    '\uFEFF' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n'),
    'utf8'
  );
}

function totalByUnits(records) {
  const totals = new Map();
  records.forEach((record) => {
    totals.set(record.unit, Math.round(((totals.get(record.unit) || 0) + record.qty) * 1000) / 1000);
  });

  return [...totals.entries()].sort((left, right) => {
    const leftIndex = UNIT_ORDER.indexOf(left[0]);
    const rightIndex = UNIT_ORDER.indexOf(right[0]);
    if (leftIndex !== -1 || rightIndex !== -1) {
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }
    return left[0].localeCompare(right[0], 'ru');
  });
}

function periodText(window) {
  if (!window.from) {
    return `по ${formatDateRu(window.to)}`;
  }
  if (window.from === window.to) {
    return formatDateRu(window.to);
  }
  return `${formatDateRu(window.from)} — ${formatDateRu(window.to)}`;
}

export function buildReport({ config, snapshot, now = new Date(), isTest = false, archiveAttached = false }) {
  const timeZone = config.timezone;
  const window = getRangeWindow(config.range, now, timeZone);
  const localToday = localDateISO(now, timeZone);
  const generatedAt = formatDateTimeInZone(now, timeZone);
  const syncedAt = snapshot.generatedAt
    ? formatDateTimeInZone(new Date(snapshot.generatedAt), timeZone)
    : '—';

  const records = snapshot.records
    .filter((record) => {
      if (!window.from) return true;
      return record.date >= window.from && record.date <= window.to;
    })
    .sort((left, right) => {
      const date = right.date.localeCompare(left.date);
      if (date !== 0) return date;
      return left.name.localeCompare(right.name, 'ru');
    });

  const totals = totalByUnits(records);
  const totalUnits = totals.length;
  const maxTableRows = 250;
  const visibleRows = records.slice(0, maxTableRows);
  const hiddenRows = records.length - visibleRows.length;
  const historyRows = snapshot.archivedCount
    ? `В архиве реестра: ${snapshot.archivedCount} ${recordsWord(snapshot.archivedCount)}.`
    : 'Архив реестра пуст.';

  const subject = `${isTest ? '[ТЕСТ] ' : ''}ПРИЁМКА · материалы ${window.label} · ${formatDateRu(localToday)}`;

  const tableRows = visibleRows.map((record) => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #e4ded2;font-size:13px;color:#26362d;white-space:nowrap;vertical-align:top;">${escapeHtml(formatDateRu(record.date))}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e4ded2;font-size:13px;color:#16241d;vertical-align:top;">
        <strong style="font-weight:700;">${escapeHtml(record.name)}</strong>
        ${record.note ? `<br><span style="font-size:11px;color:#6d766f;">${escapeHtml(record.note)}</span>` : ''}
      </td>
      <td style="padding:10px 8px;border-bottom:1px solid #e4ded2;font-size:12px;color:#6d766f;white-space:nowrap;vertical-align:top;">${escapeHtml(record.unit)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #e4ded2;font-size:13px;color:#16241d;text-align:right;white-space:nowrap;font-weight:700;vertical-align:top;">${escapeHtml(formatQuantity(record.qty))}</td>
    </tr>`).join('');

  const totalsHtml = totals.length
    ? totals.map(([unit, total]) => `<span style="display:inline-block;margin:0 5px 5px 0;padding:4px 8px;border:1px solid #d8d0c1;border-radius:5px;background:#f7f3ea;color:#47534b;font-size:11px;"><strong style="color:#16241d;">${escapeHtml(formatQuantity(total))}</strong> ${escapeHtml(unit)}</span>`).join('')
    : '<span style="color:#6d766f;font-size:12px;">Нет данных за выбранный период</span>';

  const html = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1ede4;font-family:Arial,Helvetica,sans-serif;color:#16241d;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1ede4;padding:24px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;background:#fbf9f4;border:1px solid #ded7c9;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background:#16241d;padding:24px 28px;color:#f6f1e4;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="vertical-align:top;">
                    <div style="font-size:10px;letter-spacing:3px;color:#e85d2a;font-weight:bold;">ПРИЁМКА</div>
                    <div style="margin-top:14px;font-size:27px;line-height:1.12;font-weight:bold;color:#f6f1e4;">Материалы ${escapeHtml(window.label)}</div>
                    <div style="margin-top:8px;font-size:12px;color:#b5bcb6;">${escapeHtml(periodText(window))} · ${escapeHtml(config.timezone)}</div>
                  </td>
                  <td align="right" style="vertical-align:top;font-size:10px;line-height:1.6;color:#89958d;white-space:nowrap;">
                    ${escapeHtml(snapshot.username || '')}<br>${escapeHtml(formatDateRu(localToday))}
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          ${isTest ? `<tr><td style="padding:12px 28px;background:#f8e8d6;color:#8c481f;font-size:12px;"><strong>Тестовое письмо.</strong> Проверка настроек почтового сервиса ПРИЁМКИ.</td></tr>` : ''}
          <tr>
            <td style="padding:22px 28px 8px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="33%" style="padding:0 8px 0 0;vertical-align:top;">
                    <div style="font-size:9px;letter-spacing:1.5px;color:#6d766f;text-transform:uppercase;">В отчёте</div>
                    <div style="margin-top:4px;font-size:24px;font-weight:bold;color:#16241d;">${records.length}</div>
                    <div style="font-size:11px;color:#6d766f;">${recordsWord(records.length)}</div>
                  </td>
                  <td width="33%" style="padding:0 8px;vertical-align:top;border-left:1px solid #ded7c9;">
                    <div style="font-size:9px;letter-spacing:1.5px;color:#6d766f;text-transform:uppercase;">Единицы</div>
                    <div style="margin-top:4px;font-size:24px;font-weight:bold;color:#16241d;">${totalUnits}</div>
                    <div style="font-size:11px;color:#6d766f;">${unitsWord(totalUnits)}</div>
                  </td>
                  <td width="33%" style="padding:0 0 0 8px;vertical-align:top;border-left:1px solid #ded7c9;">
                    <div style="font-size:9px;letter-spacing:1.5px;color:#6d766f;text-transform:uppercase;">Данные на</div>
                    <div style="margin-top:7px;font-size:12px;font-weight:bold;color:#16241d;line-height:1.45;">${escapeHtml(syncedAt)}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 0;">
              <div style="font-size:9px;letter-spacing:1.5px;color:#6d766f;text-transform:uppercase;margin-bottom:7px;">Итого</div>
              ${totalsHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 0;">
              ${records.length === 0
                ? '<div style="padding:22px;border:1px dashed #d8d0c1;border-radius:8px;text-align:center;color:#6d766f;font-size:13px;">За выбранный период поступлений нет.</div>'
                : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                    <thead>
                      <tr>
                        <th align="left" style="padding:0 8px 8px;font-size:9px;letter-spacing:1px;color:#6d766f;text-transform:uppercase;border-bottom:1px solid #c9c1b1;">Дата</th>
                        <th align="left" style="padding:0 8px 8px;font-size:9px;letter-spacing:1px;color:#6d766f;text-transform:uppercase;border-bottom:1px solid #c9c1b1;">Материал</th>
                        <th align="left" style="padding:0 8px 8px;font-size:9px;letter-spacing:1px;color:#6d766f;text-transform:uppercase;border-bottom:1px solid #c9c1b1;">Ед.</th>
                        <th align="right" style="padding:0 8px 8px;font-size:9px;letter-spacing:1px;color:#6d766f;text-transform:uppercase;border-bottom:1px solid #c9c1b1;">Кол-во</th>
                      </tr>
                    </thead>
                    <tbody>${tableRows}</tbody>
                  </table>
                  ${hiddenRows > 0 ? `<div style="margin-top:10px;font-size:11px;color:#6d766f;">Ещё ${hiddenRows} ${recordsWord(hiddenRows)} — в CSV-вложении.</div>` : ''}`
              }
            </td>
          </tr>
          <tr>
            <td style="padding:20px 28px 26px;">
              <div style="padding-top:14px;border-top:1px solid #ded7c9;font-size:11px;line-height:1.6;color:#6d766f;">
                ${archiveAttached ? 'Зашифрованная резервная копия реестра прикреплена к письму. Пароль в письмо не входит.' : ''}
                ${archiveAttached ? '<br>' : ''}
                ${escapeHtml(historyRows)}<br>
                Период данных: ${escapeHtml(periodText(window))}. Письмо сформировано ${escapeHtml(generatedAt)}.
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px;background:#f7f3ea;border-top:1px solid #ded7c9;font-size:10px;color:#929a93;">
              ПРИЁМКА · автоматический отчёт · <span style="color:#6d766f;">${escapeHtml(describeSchedule(config))}</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const textLines = [
    'ПРИЁМКА — материалы на объекте',
    `Период: ${window.label} (${periodText(window)})`,
    isTest ? 'ТЕСТОВОЕ ПИСЬМО' : '',
    '',
    `Записей: ${records.length}`,
    `Единиц измерения: ${totalUnits}`,
    `Итого: ${totals.map(([unit, total]) => `${formatQuantity(total)} ${unit}`).join(', ') || 'нет данных'}`,
    '',
    ...visibleRows.map((record) => `${formatDateRu(record.date)} · ${record.name} · ${formatQuantity(record.qty)} ${record.unit}${record.note ? ` · ${record.note}` : ''}`),
    hiddenRows > 0 ? `... ещё ${hiddenRows} ${recordsWord(hiddenRows)} в CSV` : '',
    '',
    historyRows,
    archiveAttached ? 'Зашифрованная резервная копия реестра — во вложении. Пароль в письмо не входит.' : '',
    `Сформировано: ${generatedAt} (${config.timezone}).`,
    `Расписание: ${describeSchedule(config)}.`
  ].filter((line) => line !== '');

  return {
    subject,
    html,
    text: textLines.join('\n'),
    csv: buildCsv(records),
    filenameDate: localToday,
    records,
    count: records.length,
    totals,
    periodLabel: window.label,
    periodText: periodText(window),
    syncedAt,
    generatedAt
  };
}
