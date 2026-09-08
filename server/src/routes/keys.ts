import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { all, get, run } from '../db';
import type { GatewayKeyRow } from '../db/schema';
import { randomKey, sha256 } from '../utils/crypto';
import { requireAdmin } from '../middleware/adminAuth';
import { clearRateLimit } from '../middleware/apiKeyAuth';

function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  return !!requireAdmin(req, reply);
}

function toView(row: GatewayKeyRow) {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    allowedModels: JSON.parse(row.allowed_models || '[]'),
    rpmLimit: row.rpm_limit,
    enabled: row.enabled,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    totalRequests: row.total_requests,
    createdAt: row.created_at,
  };
}

export async function keyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/keys', async (req, reply) => {
    if (!guard(req, reply)) return;
    const rows = all<GatewayKeyRow>('SELECT * FROM gateway_keys ORDER BY id DESC');
    void reply.send({ data: rows.map(toView) });
  });

  app.post('/api/keys', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { name, allowedModels = [], rpmLimit = 0 } = (req.body || {}) as {
      name?: string;
      allowedModels?: string[];
      rpmLimit?: number;
    };
    if (!name) return void reply.status(400).send({ error: { message: '请填写名称' } });
    const plain = randomKey();
    const res = run(
      `INSERT INTO gateway_keys (name, key_hash, key_prefix, allowed_models, rpm_limit, enabled, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      name,
      sha256(plain),
      plain.slice(0, 12),
      JSON.stringify(allowedModels || []),
      Number(rpmLimit) || 0,
      1,
      Date.now(),
    );
    // 明文仅创建时返回一次
    void reply.send({ data: { id: res.lastInsertRowid, key: plain } });
  });

  app.put('/api/keys/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const { name, allowedModels, rpmLimit, enabled } = (req.body || {}) as {
      name?: string;
      allowedModels?: string[];
      rpmLimit?: number;
      enabled?: number;
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (name != null) push('name', name);
    if (allowedModels != null) push('allowed_models', JSON.stringify(allowedModels));
    if (rpmLimit != null) push('rpm_limit', Number(rpmLimit));
    if (enabled != null) push('enabled', enabled);
    if (!sets.length) return void reply.send({ data: { ok: true } });
    params.push(id);
    run(`UPDATE gateway_keys SET ${sets.join(', ')} WHERE id = ?`, ...params);
    clearRateLimit(id);
    void reply.send({ data: { ok: true } });
  });

  app.delete('/api/keys/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    run('DELETE FROM gateway_keys WHERE id = ?', id);
    clearRateLimit(id);
    void reply.send({ data: { ok: true } });
  });

  /** 重新生成明文（旧明文立即失效；DB 只存 hash，明文仅本次响应返回一次） */
  app.post('/api/keys/:id/regenerate', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = get<Pick<GatewayKeyRow, 'id'>>('SELECT id FROM gateway_keys WHERE id = ?', id);
    if (!row) return void reply.status(404).send({ error: { message: '密钥不存在' } });
    const plain = randomKey();
    run('UPDATE gateway_keys SET key_hash = ?, key_prefix = ? WHERE id = ?', sha256(plain), plain.slice(0, 12), id);
    clearRateLimit(id);
    void reply.send({ data: { id, key: plain } });
  });
}
