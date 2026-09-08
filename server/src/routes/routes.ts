import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db';
import type { ChannelRow, ModelRouteRow } from '../db/schema';
import { listAvailableModels, getModelsOf, parseJson, orderedPublicModels, saveModelOrder, getFallbackMap, saveFallbackModels } from '../core/selector';
import { requireAdmin } from '../middleware/adminAuth';

const routeInput = z.object({
  publicModel: z.string().min(1),
  channelIds: z.array(z.number().int()).default([]),
  strategy: z.enum(['priority', 'weighted', 'round_robin']).default('priority'),
  enabled: z.number().int().default(1),
});

function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  return !!requireAdmin(req, reply);
}

export async function modelRouteRoutes(app: FastifyInstance): Promise<void> {
  /** 所有可用模型 + 每个模型当前命中的渠道顺序 */
  app.get('/api/models/available', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { publicModels, byChannel } = listAvailableModels();
    const chanRows = all<ChannelRow>('SELECT * FROM channels ORDER BY priority ASC, id ASC');
    const routes = all<ModelRouteRow>('SELECT * FROM model_routes');
    const routeMap = new Map(routes.map((r) => [r.public_model, r]));

    // 展示顺序：用户自定义排序优先，其余按字母序追加
    const orderedList = orderedPublicModels().filter((m) => publicModels.includes(m));
    const index = new Map<string, number>(orderedList.map((m, i) => [m, i]));
    const fallbackMap = getFallbackMap();

    const data = publicModels.map((model) => {
      const route = routeMap.get(model);
      const fromRoute = route ? parseJson<number[]>(route.channel_ids, []) : [];
      const auto = chanRows.filter((c) => getModelsOf(c).includes(model) || getModelsOf(c).includes('*'));
      const orderedIds = fromRoute.length ? fromRoute : auto.map((c) => c.id);
      const channels = orderedIds
        .map((id) => chanRows.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({
          id: c!.id,
          name: c!.name,
          enabled: c!.enabled,
          status: c!.status,
          priority: c!.priority,
          weight: c!.weight,
          latencyMs: c!.latency_ms,
        }));

      return {
        model,
        hasRoute: !!route && route.enabled === 1,
        strategy: route?.strategy || 'priority',
        channelIds: orderedIds,
        channels,
        availableCount: auto.filter((c) => c.enabled).length,
        fallbacks: fallbackMap[model] || [],
      };
    });

    data.sort((a, b) => (index.get(a.model) ?? 9999) - (index.get(b.model) ?? 9999));

    void reply.send({ data, byChannel });
  });

  /** 保存模型展示顺序（拖拽排序持久化） */
  app.put('/api/models/order', async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body || {}) as { models?: unknown };
    if (!Array.isArray(body.models)) {
      return void reply.status(400).send({ error: { message: '参数错误: models 必须为数组' } });
    }
    saveModelOrder(body.models.filter((m): m is string => typeof m === 'string'));
    void reply.send({ data: { ok: true } });
  });

  /** 保存模型降级链：某模型全部渠道失败后，按顺序换降级模型重试 */
  app.put('/api/models/fallback', async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body || {}) as { model?: unknown; fallbacks?: unknown };
    if (typeof body.model !== 'string' || !body.model) {
      return void reply.status(400).send({ error: { message: '参数错误: model 必须为非空字符串' } });
    }
    if (!Array.isArray(body.fallbacks)) {
      return void reply.status(400).send({ error: { message: '参数错误: fallbacks 必须为数组' } });
    }
    saveFallbackModels(body.model, body.fallbacks.filter((m): m is string => typeof m === 'string'));
    void reply.send({ data: { ok: true } });
  });

  app.get('/api/routes', async (req, reply) => {
    if (!guard(req, reply)) return;
    const rows = all<ModelRouteRow>('SELECT * FROM model_routes ORDER BY id DESC');
    void reply.send({ data: rows.map((r) => ({ ...r, channelIds: parseJson<number[]>(r.channel_ids, []) })) });
  });

  app.post('/api/routes', async (req, reply) => {
    if (!guard(req, reply)) return;
    const parsed = routeInput.safeParse(req.body);
    if (!parsed.success) {
      return void reply.status(400).send({ error: { message: `参数错误: ${parsed.error.issues[0]?.message}` } });
    }
    const v = parsed.data;
    const now = Date.now();
    const existing = get<ModelRouteRow>('SELECT * FROM model_routes WHERE public_model = ?', v.publicModel);
    if (existing) {
      run(
        'UPDATE model_routes SET channel_ids = ?, strategy = ?, enabled = ?, updated_at = ? WHERE id = ?',
        JSON.stringify(v.channelIds),
        v.strategy,
        v.enabled,
        now,
        existing.id,
      );
      return void reply.send({ data: { id: existing.id } });
    }
    const res = run(
      `INSERT INTO model_routes (public_model, channel_ids, strategy, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
      v.publicModel,
      JSON.stringify(v.channelIds),
      v.strategy,
      v.enabled,
      now,
      now,
    );
    void reply.send({ data: { id: res.lastInsertRowid } });
  });

  app.delete('/api/routes/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    run('DELETE FROM model_routes WHERE id = ?', id);
    void reply.send({ data: { ok: true } });
  });

  /** 按渠道当前优先级，为所有模型重建路由 */
  app.post('/api/routes/auto-build', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { publicModels } = listAvailableModels();
    const chanRows = all<ChannelRow>('SELECT * FROM channels ORDER BY priority ASC, id ASC');
    const now = Date.now();
    let built = 0;

    for (const model of publicModels) {
      const ids = chanRows
        .filter((c) => getModelsOf(c).includes(model) || getModelsOf(c).includes('*'))
        .map((c) => c.id);
      if (!ids.length) continue;
      const existing = get<ModelRouteRow>('SELECT * FROM model_routes WHERE public_model = ?', model);
      if (existing) {
        run('UPDATE model_routes SET channel_ids = ?, updated_at = ? WHERE id = ?', JSON.stringify(ids), now, existing.id);
      } else {
        run(
          `INSERT INTO model_routes (public_model, channel_ids, strategy, enabled, created_at, updated_at)
           VALUES (?,?,?,?,?,?)`,
          model,
          JSON.stringify(ids),
          'priority',
          1,
          now,
          now,
        );
      }
      built++;
    }
    void reply.send({ data: { built } });
  });
}
