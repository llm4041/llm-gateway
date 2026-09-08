import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sqlite } from '../db';
import { requireAdmin } from '../middleware/adminAuth';

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/overview', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!requireAdmin(req, reply)) return;

    const today = startOfToday();
    const since = Date.now() - 24 * 3600 * 1000;

    const chanAgg = sqlite
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled,
           SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
           SUM(CASE WHEN status = 'failing' THEN 1 ELSE 0 END) AS failing,
           SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
           SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown
         FROM channels`,
      )
      .get() as Record<string, number>;

    const todayAgg = sqlite
      .prepare(
        `SELECT
           COUNT(*) AS requests,
           SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success,
           AVG(latency_ms) AS avgLatency,
           SUM(COALESCE(total_tokens, 0)) AS tokens
         FROM request_logs WHERE ts >= ?`,
      )
      .get(today) as Record<string, number | null>;

    const trend = sqlite
      .prepare(
        `SELECT (ts / 3600000) AS hour,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success
         FROM request_logs WHERE ts >= ?
         GROUP BY hour ORDER BY hour`,
      )
      .all(since) as Array<{ hour: number; requests: number; success: number }>;

    const byChannel = sqlite
      .prepare(
        `SELECT channel_id AS channelId,
                COALESCE(channel_name, '未知') AS channelName,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success,
                AVG(latency_ms) AS avgLatency
         FROM request_logs WHERE ts >= ? AND channel_id IS NOT NULL
         GROUP BY channel_id ORDER BY requests DESC LIMIT 10`,
      )
      .all(since) as Array<Record<string, number | string>>;

    // 按对外模型聚合（降级成功的 token 记在实际服务的模型名下）
    const byModel = sqlite
      .prepare(
        `SELECT public_model AS publicModel,
                COUNT(*) AS requests,
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS success,
                AVG(latency_ms) AS avgLatency,
                SUM(COALESCE(prompt_tokens, 0)) AS promptTokens,
                SUM(COALESCE(completion_tokens, 0)) AS completionTokens,
                SUM(COALESCE(total_tokens, 0)) AS totalTokens
         FROM request_logs WHERE ts >= ? AND public_model != ''
         GROUP BY public_model ORDER BY totalTokens DESC LIMIT 20`,
      )
      .all(since) as Array<Record<string, number | string>>;

    const recentErrors = sqlite
      .prepare(
        `SELECT id, ts, public_model AS publicModel, channel_name AS channelName, http_status AS httpStatus, error_msg AS errorMsg
         FROM request_logs WHERE ok = 0 ORDER BY id DESC LIMIT 8`,
      )
      .all();

    const requests = Number(todayAgg.requests || 0);
    const success = Number(todayAgg.success || 0);

    void reply.send({
      data: {
        channels: {
          total: chanAgg.total || 0,
          enabled: chanAgg.enabled || 0,
          healthy: chanAgg.healthy || 0,
          failing: chanAgg.failing || 0,
          disabled: chanAgg.disabled || 0,
          unknown: chanAgg.unknown || 0,
        },
        today: {
          requests,
          success,
          failed: requests - success,
          successRate: requests > 0 ? Number(((success / requests) * 100).toFixed(1)) : 100,
          avgLatency: Math.round(Number(todayAgg.avgLatency || 0)),
          tokens: Number(todayAgg.tokens || 0),
        },
        trend: trend.map((t) => ({
          hour: new Date(t.hour * 3600000).getHours(),
          requests: t.requests,
          success: t.success || 0,
        })),
        byChannel,
        byModel,
        recentErrors,
      },
    });
  });
}
