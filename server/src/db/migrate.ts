import { all, exec } from './index';

const DDL = `
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL,
  api_key_enc TEXT NOT NULL DEFAULT '',
  models TEXT NOT NULL DEFAULT '[]',
  model_mapping TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 10,
  weight INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  latency_ms INTEGER,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  success_streak INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  last_error TEXT,
  cooldown_until INTEGER,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_failures INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS model_routes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_model TEXT NOT NULL,
  channel_ids TEXT NOT NULL DEFAULT '[]',
  strategy TEXT NOT NULL DEFAULT 'priority',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_routes_model ON model_routes(public_model);

CREATE TABLE IF NOT EXISTS gateway_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  allowed_models TEXT NOT NULL DEFAULT '[]',
  rpm_limit INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  last_used_at INTEGER,
  total_requests INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_keys_hash ON gateway_keys(key_hash);

CREATE TABLE IF NOT EXISTS request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  key_id INTEGER,
  key_name TEXT,
  public_model TEXT NOT NULL,
  channel_id INTEGER,
  channel_name TEXT,
  actual_model TEXT,
  stream INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  ok INTEGER NOT NULL DEFAULT 0,
  error_type TEXT,
  error_msg TEXT,
  latency_ms INTEGER,
  first_token_ms INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  failover_chain TEXT NOT NULL DEFAULT '[]',
  client_ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON request_logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs(public_model);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function migrate(): void {
  exec(DDL);
  // 旧库增量迁移：channels.health_check（1=参与定时健康探测，0=跳过，如收费模型）
  const cols = all<{ name: string }>('PRAGMA table_info(channels)');
  if (!cols.some((c) => c.name === 'health_check')) {
    exec("ALTER TABLE channels ADD COLUMN health_check INTEGER NOT NULL DEFAULT 1");
  }
  // 多 Key 拆分：同组渠道共享 group_key，group_index 为组内序号
  if (!cols.some((c) => c.name === 'group_key')) {
    exec('ALTER TABLE channels ADD COLUMN group_key TEXT');
  }
  if (!cols.some((c) => c.name === 'group_index')) {
    exec('ALTER TABLE channels ADD COLUMN group_index INTEGER');
  }
}
