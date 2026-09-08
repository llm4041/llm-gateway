/** 表结构见 db/migrate.ts；这里只维护 TS 类型，避免引入 ORM 依赖 */

export type ChannelStatus = 'unknown' | 'healthy' | 'failing' | 'disabled';

export type ChannelRow = {
  id: number;
  name: string;
  provider: string;
  base_url: string;
  api_key_enc: string;
  models: string;
  model_mapping: string;
  priority: number;
  weight: number;
  enabled: number;
  health_check: number;
  disabled_reason: string | null;
  status: ChannelStatus;
  latency_ms: number | null;
  fail_streak: number;
  success_streak: number;
  last_checked_at: number | null;
  last_error: string | null;
  cooldown_until: number | null;
  total_requests: number;
  total_failures: number;
  total_tokens: number;
  created_at: number;
  updated_at: number;
};

export type ModelRouteRow = {
  id: number;
  public_model: string;
  channel_ids: string;
  strategy: 'priority' | 'weighted' | 'round_robin';
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type GatewayKeyRow = {
  id: number;
  name: string;
  key_hash: string;
  key_prefix: string;
  allowed_models: string;
  rpm_limit: number;
  enabled: number;
  expires_at: number | null;
  last_used_at: number | null;
  total_requests: number;
  created_at: number;
};

export type RequestLogInsert = {
  ts: number;
  request_id: string;
  key_id: number | null;
  key_name: string | null;
  public_model: string;
  channel_id: number | null;
  channel_name: string | null;
  actual_model: string | null;
  stream: number;
  http_status: number | null;
  ok: number;
  error_type: string | null;
  error_msg: string | null;
  latency_ms: number | null;
  first_token_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  estimated: number;
  retry_count: number;
  failover_chain: string;
  client_ip: string | null;
};

export type RequestLogRow = RequestLogInsert & { id: number };

export type AdminRow = {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  created_at: number;
};
