import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sqlite } from '../db';
import type { RequestLogRow } from '../db/schema';
import { requireAdmin } from '../middleware/adminAuth';

function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  return !!requireAdmin(req, reply);
}

/** snake_case -> camelCase（前端表格列 dataIndex 均为 camelCase） */
function toView(row: RequestLogRow) {
  return {
    id: row.id,
    ts: row.ts,
    requestId: row.request_id,
    keyId: row.key_id,
    keyName: row.key_name,
    publicModel: row.public_model,
    channelId: row.channel_id,
    channelName: row.channel_name,
    actualModel: row.actual_model,
    stream: row.stream,
    httpStatus: row.http_status,
    ok: row.ok,
    errorType: row.error_type,
    errorMsg: row.error_msg,
    latencyMs: row.latency_ms,
    firstTokenMs: row.first_token_ms,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    estimated: row.estimated,
    retryCount: row.retry_count,
    clientIp: row.client_ip,
    failoverChain: JSON.parse(row.failover_chain || '[]') as Array<{
      channelId: number;
      channelName: string;
      error: string;
      at: number;
    }>,
  };
}

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/logs', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = (req.query || {}) as {
      page?: string;
      pageSize?: string;
      model?: string;
      channelId?: string;
      ok?: string;
      from?: string;
      to?: string;
    };
    const page = Math.max(1, Number(q.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20));

    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (q.model) {
      conds.push('public_model = ?');
      params.push(q.model);
    }
    if (q.channelId) {
      conds.push('channel_id = ?');
      params.push(Number(q.channelId));
    }
    if (q.ok && q.ok !== 'all') {
      conds.push('ok = ?');
      params.push(q.ok === '1' ? 1 : 0);
    }
    if (q.from) {
      conds.push('ts >= ?');
      params.push(Number(q.from));
    }
    if (q.to) {
      conds.push('ts <= ?');
      params.push(Number(q.to));
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = sqlite
      .prepare(`SELECT * FROM request_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize) as RequestLogRow[];

    const totalRow = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM request_logs ${where}`)
      .get(...params) as { c: number };

    // data 内再包一层 { items, total }：client.ts 会解一次 data，前端取 r.items / r.total
    void reply.send({ data: { items: rows.map(toView), total: Number(totalRow?.c || 0), page, pageSize } });
  });

  app.get('/api/logs/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = sqlite.prepare('SELECT * FROM request_logs WHERE id = ?').get(id) as RequestLogRow | undefined;
    if (!row) return void reply.status(404).send({ error: { message: '日志不存在' } });
    void reply.send({ data: toView(row) });
  });

  app.delete('/api/logs', async (req, reply) => {
    if (!guard(req, reply)) return;
    sqlite.prepare('DELETE FROM request_logs').run();
    void reply.send({ data: { ok: true } });
  });
}
