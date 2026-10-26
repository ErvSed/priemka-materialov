import nodemailer from 'nodemailer';
import { buildReport } from './report.mjs';
import { HttpError } from './validation.mjs';

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function safeFilename(value) {
  return String(value).replaceAll(/[^0-9A-Za-z._-]/g, '-').replaceAll(/-+/g, '-').slice(0, 80);
}

export function createMailer(env) {
  const host = env.SMTP_HOST;
  const port = Number(env.SMTP_PORT || 587);
  const secure = parseBoolean(env.SMTP_SECURE, port === 465);
  const user = env.SMTP_USER || '';
  const password = env.SMTP_PASS || '';
  const from = env.SMTP_FROM || '';
  const replyTo = env.SMTP_REPLY_TO || '';
  const requireTls = parseBoolean(env.SMTP_REQUIRE_TLS, false);
  const configured = Boolean(host && from && Number.isFinite(port));
  let transporter = null;

  function getTransporter() {
    if (!configured) {
      throw new HttpError(
        503,
        'SMTP не настроен на почтовом сервере. Заполните SMTP_HOST и SMTP_FROM в окружении сервиса.'
      );
    }
    if (!transporter) {
      transporter = nodemailer.createTransport({
        host,
        port,
        secure,
        requireTLS: requireTls,
        auth: user ? { user, pass: password } : undefined,
        connectionTimeout: 20_000,
        greetingTimeout: 20_000,
        socketTimeout: 30_000,
        tls: {
          minVersion: 'TLSv1.2'
        }
      });
    }
    return transporter;
  }

  async function sendReport({ config, snapshot, archive, now = new Date(), isTest = false }) {
    const archiveAttached = Boolean(config.attachArchive && archive);
    const report = buildReport({ config, snapshot, now, isTest, archiveAttached });

    const attachments = [
      {
        filename: `priemka-otchet-${safeFilename(report.filenameDate)}.csv`,
        content: report.csv,
        contentType: 'text/csv; charset=utf-8'
      }
    ];

    if (archiveAttached) {
      const archiveBuffer = Buffer.from(JSON.stringify(archive, null, 2), 'utf8');
      if (archiveBuffer.byteLength > 12 * 1024 * 1024) {
        throw new HttpError(413, 'Резервная копия слишком большая для вложения.');
      }
      attachments.push({
        filename: `priemka-backup-${safeFilename(report.filenameDate)}.json`,
        content: archiveBuffer,
        contentType: 'application/json; charset=utf-8'
      });
    }

    try {
      const info = await getTransporter().sendMail({
        from,
        to: config.email,
        replyTo: replyTo || undefined,
        subject: report.subject,
        text: report.text,
        html: report.html,
        attachments
      });

      return {
        messageId: info.messageId,
        accepted: info.accepted || [],
        rejected: info.rejected || [],
        reportSummary: {
          count: report.count,
          period: report.periodLabel,
          subject: report.subject
        }
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      console.error('SMTP send failed:', error);
      throw new HttpError(
        502,
        'Почтовый сервер не принял письмо. Проверьте SMTP-настройки сервиса и попробуйте ещё раз.'
      );
    }
  }

  return {
    configured,
    sendReport,
    close: () => {
      if (transporter) transporter.close();
    }
  };
}
