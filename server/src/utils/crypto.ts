import crypto from 'node:crypto';
import { config } from '../config';

const ALG = 'aes-256-gcm';

function masterKeyBuf(): Buffer {
  return crypto.createHash('sha256').update(config.masterKey).digest();
}

/** 上游 API Key 加密落库 */
export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, masterKeyBuf(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

export function decrypt(payload: string): string {
  if (!payload) return '';
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  try {
    const decipher = crypto.createDecipheriv(ALG, masterKeyBuf(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return '';
  }
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomKey(): string {
  return `sk-gw-${crypto.randomBytes(24).toString('base64url')}`;
}

/** 列表页只展示掩码，避免 Key 泄露 */
export function maskKey(raw: string): string {
  if (!raw) return '';
  if (raw.length <= 8) return '****';
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function newSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}
