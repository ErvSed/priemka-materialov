import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const STATE_VERSION = 1;
const SALT = Buffer.from('priemka-mailer-state-v1', 'utf8');

function deriveStateKey(token) {
  return scryptSync(token, SALT, 32);
}

export function createStateStore({ dataDir, token }) {
  if (!token) throw new Error('Не задан MAIL_API_TOKEN');
  const filePath = path.join(dataDir, 'state.bin');
  const key = deriveStateKey(token);
  let writeChain = Promise.resolve();

  async function load() {
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      throw new Error('Файл состояния повреждён: это не JSON.');
    }

    if (envelope.v !== STATE_VERSION || envelope.alg !== 'aes-256-gcm') {
      throw new Error('Файл состояния имеет неподдерживаемый формат.');
    }

    try {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final()
      ]);
      return JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw new Error(
        'Не удалось расшифровать файл состояния. Вероятно, MAIL_API_TOKEN был изменён. Верните прежний токен или удалите data/state.bin, чтобы начать заново.'
      );
    }
  }

  async function writeNow(state) {
    const plaintext = Buffer.from(JSON.stringify(state), 'utf8');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = {
      v: STATE_VERSION,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64')
    };

    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600 });
    await rename(temporary, filePath);
    await chmod(filePath, 0o600).catch(() => {});
  }

  function save(state) {
    writeChain = writeChain.catch(() => {}).then(() => writeNow(state));
    return writeChain;
  }

  return {
    load,
    save,
    filePath
  };
}
