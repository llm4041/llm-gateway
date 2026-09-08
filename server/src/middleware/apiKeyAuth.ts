import type { FastifyRequest, FastifyReply } from 'fastify';
import { get } from '../db';
import type { GatewayKeyRow } from '../db/schema';
import { sha256 } from '../utils/crypto';
import type { KeyCtx } from '../core/relay';

type Bucket = { count: number; resetAt: number };
const rpmBuckets = new Map<number, Bucket>();

export type GatewayKeyContext = KeyCtx & { allowedModels: string[] };

export type KeyLookup =
  | { ok: true; ctx: GatewayKeyContext }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'ratelimited' };

/**
 * 仅做校验与速率限制，不发送任何 HTTP 响应。
 * 成功返回 ctx；失败返回原因，由调用方决定是 401 还是 429，或回退到管理员鉴权。
 */
export function lookupGatewayKey(raw: string): KeyLookup {
  if (!raw) return { ok: false, reason: 'missing' };
  const hash = sha256(raw);
  const row = get<GatewayKeyRow>('SELECT * FROM gateway_keys WHERE key_hash = ?', hash);
  if (!row || !row.enabled) return { ok: false, reason: 'invalid' };
  if (row.expires_at && row.expires_at < Date.now()) return { ok: false, reason: 'expired' };

  if (row.rpm_limit > 0) {
    const now = Date.now();
    const bucket = rpmBuckets.get(row.id) ?? { count: 0, resetAt: now + 60_000 };
    if (now > bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = now + 60_000;
    }
    bucket.count += 1;
    rpmBuckets.set(row.id, bucket);
    if (bucket.count > row.rpm_limit) return { ok: false, reason: 'ratelimited' };
  }

  return {
    ok: true,
    ctx: {
      keyId: row.id,
      keyName: row.name,
      allowedModels: JSON.parse(row.allowed_models || '[]'),
    },
  };
}

/** 网关标准鉴权：仅接受网关 Key。失败直接返回 401/429。 */
export function resolveGatewayKey(req: FastifyRequest, reply: FastifyReply): GatewayKeyContext | null {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const r = lookupGatewayKey(raw);
  if (r.ok) return r.ctx;
  if (r.reason === 'ratelimited') {
    void reply.status(429).send({ error: { message: `超出速率限制`, type: 'rate_limited' } });
    return null;
  }
  void reply.status(401).send({ error: { message: 'API Key 无效或已停用', type: 'invalid_key' } });
  return null;
}

export function clearRateLimit(keyId: number): void {
  rpmBuckets.delete(keyId);
}
