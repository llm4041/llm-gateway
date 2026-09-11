/**
 * 排查「编辑渠道后 Key 变成掩码」导致失效的渠道（只读，不修改任何数据）。
 *
 * 用法：
 *   node scripts/check-broken-keys.mjs
 *   DB_PATH=/path/to/gateway.db node scripts/check-broken-keys.mjs
 *   DATA_DIR=/path/to/data node scripts/check-broken-keys.mjs
 *
 * 判定：解密后的 Key 形如 "前4位****后4位"（即列表里展示的掩码串），
 * 说明编辑时掩码被当成真实 Key 保存了，需要重新填写真实 Key。
 */
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(HERE, '..');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'gateway.db');

/** 与 server/src/utils/crypto.ts 保持一致 */
const ALG = 'aes-256-gcm';
function masterKeyBuf(masterKey) {
  return crypto.createHash('sha256').update(masterKey).digest();
}
function decrypt(payload, masterKey) {
  if (!payload) return '';
  const [ivB64, tagB64, dataB64] = payload.split('.');
  if (!ivB64 || !tagB64 || !dataB64) return '';
  try {
    const decipher = crypto.createDecipheriv(ALG, masterKeyBuf(masterKey), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}
function isMaskedKey(raw) {
  if (!raw) return false;
  // 与 server/src/routes/channels.ts 的 isMaskedKey 保持一致
  return /^\S{0,8}\*{4}\S{0,8}$/.test(raw.trim());
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`找不到数据库：${DB_PATH}`);
  console.error('可用 DB_PATH=/path/to/gateway.db 指定，或先在有数据的机器上执行。');
  process.exit(1);
}

let masterKey = process.env.MASTER_KEY || '';
if (!masterKey) {
  const keyFile = path.join(DATA_DIR, '.master_key');
  if (fs.existsSync(keyFile)) masterKey = fs.readFileSync(keyFile, 'utf8').trim();
}
if (!masterKey) {
  console.error('找不到主密钥：请设置 MASTER_KEY，或确保 data/.master_key 存在');
  process.exit(1);
}

const db = new DatabaseSync(DB_PATH);
const rows = db
  .prepare('SELECT id, name, base_url, api_key_enc, enabled, status, updated_at FROM channels ORDER BY id')
  .all();

const broken = [];
const healthy = [];
const empty = [];

for (const r of rows) {
  const plain = decrypt(r.api_key_enc, masterKey);
  const entry = {
    id: r.id,
    name: r.name,
    baseUrl: r.base_url,
    value: plain,
    enabled: r.enabled,
    status: r.status,
    updatedAt: r.updated_at ? new Date(r.updated_at).toLocaleString('zh-CN') : '-',
  };
  if (!plain) empty.push(entry);
  else if (isMaskedKey(plain)) broken.push(entry);
  else healthy.push(entry);
}

console.log(`数据库：${DB_PATH}`);
console.log(`渠道总数：${rows.length}\n`);

if (broken.length) {
  console.log(`⚠️  以下 ${broken.length} 个渠道的 Key 已被掩码覆盖，必须重新填写真实 Key：`);
  for (const b of broken) {
    const st = `${b.enabled ? '启用' : '停用'} / ${b.status}`;
    console.log(`  #${b.id}  ${b.name}  |  ${b.value}  |  ${st}  |  ${b.updatedAt}`);
  }
} else {
  console.log('✅ 没有发现被掩码覆盖的 Key。');
}

if (empty.length) {
  console.log(`\n另有 ${empty.length} 个渠道未设置 Key（可忽略）：${empty.map((e) => `#${e.id} ${e.name}`).join('、')}`);
}

console.log(`\n正常渠道 ${healthy.length} 个。`);
if (broken.length) {
  console.log('\n修复方式：渠道管理 → 编辑对应渠道 → 在 API Key 里填入真实 Key → 保存。');
  console.log('（代码侧已修复：编辑时不再回填掩码，后端也会拒绝掩码值的写入）');
}
db.close();
