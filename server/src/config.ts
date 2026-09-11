import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths';
import { getSetting, setSetting, initDefaultSettings } from './db/settings';

/** 主加密密钥：优先环境变量，否则持久化到 data/.master_key（避免重启后无法解密已存的上游 Key） */
function resolveMasterKey(): string {
  const envKey = process.env.MASTER_KEY;
  if (envKey && envKey.length >= 16) return envKey;
  const keyFile = path.join(DATA_DIR, '.master_key');
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  return generated;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  masterKey: resolveMasterKey(),
  jwtSecret: process.env.JWT_SECRET || 'llm-gateway-dev-secret-change-me',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

export type SysSettings = {
  healthCheckIntervalSec: number;
  healthCheckTimeoutMs: number;
  healthCheckConcurrency: number;
  healthProbeMode: 'models' | 'chat';
  healthProbeModel: string;
  maxRetry: number;
  requestTimeoutMs: number;
  failThreshold: number;
  recoverThreshold: number;
  cooldownBaseSec: number;
  cooldownMaxSec: number;
  logRetentionDays: number;
  /** 报文明细保留天数，实际有效期再取 min(logDetailRetentionDays, logRetentionDays) */
  logDetailRetentionDays: number;
  autoDisable: number;
  /** 是否记录请求/响应报文到 request_log_details */
  logBodyEnabled: number;
  /** 单条报文最大字节数，超出截断（UTF-8 字节） */
  logBodyMaxBytes: number;
};

export const DEFAULT_SETTINGS: SysSettings = {
  healthCheckIntervalSec: 300,
  healthCheckTimeoutMs: 15000,
  healthCheckConcurrency: 20,
  healthProbeMode: 'models',
  healthProbeModel: '',
  maxRetry: 3,
  requestTimeoutMs: 120000,
  failThreshold: 3,
  recoverThreshold: 2,
  cooldownBaseSec: 300,
  cooldownMaxSec: 3600,
  logRetentionDays: 2,
  logDetailRetentionDays: 1,
  autoDisable: 1,
  logBodyEnabled: 1,
  logBodyMaxBytes: 32768,
};

export function loadSettings(): SysSettings {
  initDefaultSettings(DEFAULT_SETTINGS);
  const raw = getSetting('system');
  return { ...DEFAULT_SETTINGS, ...(raw || {}) } as SysSettings;
}

export function saveSettings(patch: Partial<SysSettings>): SysSettings {
  const next = { ...loadSettings(), ...patch };
  setSetting('system', next);
  return next;
}

export { getSetting, setSetting };
