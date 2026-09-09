import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { all, get, run } from '../db';
import type { ChannelRow } from '../db/schema';
import { decrypt, encrypt, maskKey } from '../utils/crypto';
import { getModelsOf, getMappingOf, resolveActualModel, getAdaptor, normalizeBaseUrl, parseJson, orderedPublicModels } from '../core/selector';
import { PROBE_MAX_TOKENS_FALLBACK, isMaxTokensError } from '../core/adaptor/openai';
import { probeChannel } from '../core/health';
import { forceEnable } from '../core/breaker';
import { fetchWithTimeout, classifyStatus } from '../utils/errors';
import { loadSettings } from '../config';
import { requireAdmin } from '../middleware/adminAuth';

const channelInput = z.object({
  name: z.string().min(1),
  provider: z.string().default('openai-compatible'),
  baseUrl: z.string().min(1),
  /** 单个 Key；支持换行/逗号分隔多个（多 Key 时自动拆成多条渠道） */
  apiKey: z.string().optional(),
  models: z.array(z.string()).default([]),
  modelMapping: z.record(z.string()).optional(),
  priority: z.number().int().default(10),
  weight: z.number().int().min(1).default(1),
  enabled: z.number().int().default(1),
  /** 1=参与定时健康探测（默认）；0=跳过定时探测（如收费模型），仍正常参与负载均衡 */
  healthCheck: z.number().int().min(0).max(1).optional(),
});

/** 数据库行 → 前端视图（驼峰 + Key 掩码） */
function toView(ch: ChannelRow) {
  const raw = decrypt(ch.api_key_enc);
  return {
    id: ch.id,
    name: ch.name,
    provider: ch.provider,
    baseUrl: ch.base_url,
    apiKey: maskKey(raw),
    hasKey: !!raw,
    models: getModelsOf(ch),
    modelMapping: parseJson<Record<string, string>>(ch.model_mapping, {}),
    priority: ch.priority,
    weight: ch.weight,
    enabled: ch.enabled,
    healthCheck: ch.health_check === 0 ? 0 : 1,
    disabledReason: ch.disabled_reason,
    status: ch.status,
    latencyMs: ch.latency_ms,
    failStreak: ch.fail_streak,
    lastError: ch.last_error,
    lastCheckedAt: ch.last_checked_at,
    cooldownUntil: ch.cooldown_until,
    totalRequests: ch.total_requests,
    totalFailures: ch.total_failures,
    totalTokens: ch.total_tokens,
    createdAt: ch.created_at,
    updatedAt: ch.updated_at,
    groupKey: ch.group_key,
    groupIndex: ch.group_index,
  };
}

/** 把输入框里的 Key 文本拆成数组（换行 / 逗号 / 分号分隔，自动去重去空） */
export function splitKeys(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[\r\n,;，；]+/)
    .map((k) => k.trim())
    .filter(Boolean);
  return Array.from(new Set(parts));
}

function newGroupKey(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  return !!requireAdmin(req, reply);
}

export type ModelProbeResult = {
  model: string;
  actualModel: string;
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
};

/** 单次模型可用性探测（真实 chat，最小输出长度）；纯测试，不影响渠道熔断统计 */
async function probeModel(
  ch: ChannelRow,
  publicModel: string,
  timeoutMs: number,
): Promise<ModelProbeResult> {
  const adaptor = getAdaptor(ch.provider);
  const baseUrl = normalizeBaseUrl(ch.base_url);
  const apiKey = decrypt(ch.api_key_enc);
  const actualModel = resolveActualModel(ch, publicModel);
  const started = Date.now();

  try {
    const req = adaptor.buildHealthChatRequest({ baseUrl, apiKey, actualModel });
    const res = await fetchWithTimeout(
      req.url,
      { method: 'POST', headers: req.headers, body: req.body },
      timeoutMs,
    );
    const text = await res.text();
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      const c = classifyStatus(res.status, text);
      // 上游对 max_tokens 有下限要求时（如要求 > 2），换更大的值重试一次
      if (isMaxTokensError(text)) {
        const retryReq = adaptor.buildHealthChatRequest({ baseUrl, apiKey, actualModel }, PROBE_MAX_TOKENS_FALLBACK);
        try {
          const res2 = await fetchWithTimeout(
            retryReq.url,
            { method: 'POST', headers: retryReq.headers, body: retryReq.body },
            timeoutMs,
          );
          const text2 = await res2.text();
          if (res2.ok && !/"error"/.test(text2.slice(0, 200))) {
            return {
              model: publicModel,
              actualModel,
              ok: true,
              latencyMs: Date.now() - started,
              httpStatus: res2.status,
              error: null,
            };
          }
          const c2 = classifyStatus(res2.status, text2);
          return {
            model: publicModel,
            actualModel,
            ok: false,
            latencyMs: Date.now() - started,
            httpStatus: res2.status,
            error: `${c2.message.slice(0, 400)}（已用 max_tokens=${PROBE_MAX_TOKENS_FALLBACK} 重试）`,
          };
        } catch {
          /* 重试失败则沿用首次错误 */
        }
      }
      return {
        model: publicModel,
        actualModel,
        ok: false,
        latencyMs,
        httpStatus: res.status,
        error: c.message.slice(0, 400),
      };
    }
    // 部分上游（如 OpenRouter）HTTP 200 但 body 里带 error
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      return {
        model: publicModel,
        actualModel,
        ok: false,
        latencyMs,
        httpStatus: res.status,
        error: `响应非 JSON: ${text.slice(0, 200)}`,
      };
    }
    if (json?.error) {
      const errMsg = typeof json.error === 'string' ? json.error : json.error?.message || JSON.stringify(json.error);
      return {
        model: publicModel,
        actualModel,
        ok: false,
        latencyMs,
        httpStatus: res.status,
        error: String(errMsg).slice(0, 400),
      };
    }
    if (!json?.choices?.length) {
      return {
        model: publicModel,
        actualModel,
        ok: false,
        latencyMs,
        httpStatus: res.status,
        error: '响应中没有 choices，模型可能不可用',
      };
    }
    return { model: publicModel, actualModel, ok: true, latencyMs, httpStatus: res.status, error: null };
  } catch (err) {
    return {
      model: publicModel,
      actualModel,
      ok: false,
      latencyMs: Date.now() - started,
      httpStatus: null,
      error: (err as Error)?.message || '探测失败',
    };
  }
}

/** 渠道内配置的全部对外模型名（models + 别名映射的 key），排除通配符 */
function allPublicModelsOf(ch: ChannelRow): string[] {
  const set = new Set<string>([...getModelsOf(ch), ...Object.keys(getMappingOf(ch))]);
  return [...set].filter((m) => m && m !== '*');
}

export async function channelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/channels', async (req, reply) => {
    if (!guard(req, reply)) return;
    const rows = all<ChannelRow>('SELECT * FROM channels ORDER BY priority ASC, id ASC');
    void reply.send({ data: rows.map(toView) });
  });

  app.get('/api/channels/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
    if (!row) return void reply.status(404).send({ error: { message: '渠道不存在' } });
    void reply.send({ data: toView(row) });
  });

  /** 聚合所有可用渠道暴露的模型（按用户自定义排序），供对话测试页下拉选择 */
  app.get('/api/models', async (req, reply) => {
    if (!guard(req, reply)) return;
    void reply.send({ data: orderedPublicModels() });
  });

  /**
   * 探测上游模型列表（用于新建渠道时下拉选择，无需先保存渠道）。
   * body: { baseUrl, apiKey?, provider? }
   */
  app.post('/api/channels/probe-models', async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body || {}) as { baseUrl?: string; apiKey?: string; provider?: string };
    const baseUrl = (body.baseUrl || '').trim();
    if (!baseUrl) return void reply.status(400).send({ error: { message: '请填写 Base URL' } });

    const provider = body.provider || 'openai-compatible';
    const adaptor = getAdaptor(provider);
    const upstream = adaptor.buildModelsRequest({
      baseUrl: normalizeBaseUrl(baseUrl),
      apiKey: body.apiKey || '',
    });
    try {
      const res = await fetchWithTimeout(upstream.url, { method: 'GET', headers: upstream.headers }, 20000);
      const text = await res.text();
      if (!res.ok) {
        return void reply.status(400).send({ error: { message: `上游返回 ${res.status}: ${text.slice(0, 300)}` } });
      }
      const models = adaptor.parseModelsResponse(JSON.parse(text));
      void reply.send({ data: { models } });
    } catch (err) {
      void reply.status(502).send({ error: { message: `探测失败: ${(err as Error).message}` } });
    }
  });

  app.post('/api/channels', async (req, reply) => {
    if (!guard(req, reply)) return;
    const parsed = channelInput.safeParse(req.body);
    if (!parsed.success) {
      return void reply.status(400).send({ error: { message: `参数错误: ${parsed.error.issues[0]?.message}` } });
    }
    const v = parsed.data;
    const now = Date.now();
    const keys = splitKeys(v.apiKey);

    // 多 Key：拆成多条渠道（名称自动加 -1/-2/-3），共享 group_key
    if (keys.length > 1) {
      const groupKey = newGroupKey();
      const ids: number[] = [];
      keys.forEach((key, i) => {
        const res = run(
          `INSERT INTO channels (name, provider, base_url, api_key_enc, models, model_mapping,
             priority, weight, enabled, health_check, disabled_reason, status, created_at, updated_at,
             group_key, group_index)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          `${v.name}-${i + 1}`,
          v.provider,
          v.baseUrl,
          encrypt(key),
          JSON.stringify(v.models || []),
          JSON.stringify(v.modelMapping || {}),
          v.priority,
          v.weight,
          v.enabled,
          v.healthCheck ?? 1,
          v.enabled ? null : 'manual',
          'unknown',
          now,
          now,
          groupKey,
          i + 1,
        );
        ids.push(Number(res.lastInsertRowid));
      });
      return void reply.send({ data: { ids, groupKey, count: ids.length } });
    }

    const res = run(
      `INSERT INTO channels (name, provider, base_url, api_key_enc, models, model_mapping,
         priority, weight, enabled, health_check, disabled_reason, status, created_at, updated_at,
         group_key, group_index)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      v.name,
      v.provider,
      v.baseUrl,
      encrypt(keys[0] || ''),
      JSON.stringify(v.models || []),
      JSON.stringify(v.modelMapping || {}),
      v.priority,
      v.weight,
      v.enabled,
      v.healthCheck ?? 1,
      v.enabled ? null : 'manual',
      'unknown',
      now,
      now,
      null,
      null,
    );
    void reply.send({ data: { id: res.lastInsertRowid, ids: [Number(res.lastInsertRowid)], count: 1 } });
  });

  app.put('/api/channels/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const parsed = channelInput.partial().safeParse(req.body);
    if (!parsed.success) {
      return void reply.status(400).send({ error: { message: `参数错误: ${parsed.error.issues[0]?.message}` } });
    }
    const v = parsed.data;
    const now = Date.now();
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };

    if (v.name != null) push('name', v.name);
    if (v.provider != null) push('provider', v.provider);
    if (v.baseUrl != null) push('base_url', v.baseUrl);
    if (v.apiKey != null) push('api_key_enc', encrypt(v.apiKey));
    if (v.models != null) push('models', JSON.stringify(v.models));
    if (v.modelMapping != null) push('model_mapping', JSON.stringify(v.modelMapping));
    if (v.priority != null) push('priority', v.priority);
    if (v.weight != null) push('weight', v.weight);
    if (v.healthCheck != null) push('health_check', v.healthCheck);
    if (v.enabled != null) {
      push('enabled', v.enabled);
      push('disabled_reason', v.enabled ? null : 'manual');
      if (v.enabled) {
        push('cooldown_until', null);
        push('fail_streak', 0);
      }
    }
    push('updated_at', now);
    params.push(id);
    run(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, ...params);
    void reply.send({ data: { ok: true } });
  });

  app.delete('/api/channels/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    run('DELETE FROM channels WHERE id = ?', id);
    void reply.send({ data: { ok: true } });
  });

  app.post('/api/channels/:id/toggle', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const { enabled } = (req.body || {}) as { enabled?: number };
    if (enabled) {
      forceEnable(id);
    } else {
      run(
        `UPDATE channels SET enabled = 0, disabled_reason = 'manual', status = 'disabled', updated_at = ? WHERE id = ?`,
        Date.now(),
        id,
      );
    }
    void reply.send({ data: { ok: true } });
  });

  /** 组级批量操作：多 Key 拆分出的渠道组（group_key）整体启停 / 改配置 / 删除 */

  app.post('/api/channels/group/toggle', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { groupKey, enabled } = (req.body || {}) as { groupKey?: string; enabled?: number };
    if (!groupKey) return void reply.status(400).send({ error: { message: '缺少 groupKey' } });
    const rows = all<ChannelRow>('SELECT id FROM channels WHERE group_key = ?', groupKey);
    if (enabled) {
      rows.forEach((r) => forceEnable(r.id));
    } else {
      run(
        `UPDATE channels SET enabled = 0, disabled_reason = 'manual', status = 'disabled', updated_at = ? WHERE group_key = ?`,
        Date.now(),
        groupKey,
      );
    }
    void reply.send({ data: { ok: true, count: rows.length } });
  });

  app.put('/api/channels/group', async (req, reply) => {
    if (!guard(req, reply)) return;
    const body = (req.body || {}) as {
      groupKey?: string;
      provider?: string;
      baseUrl?: string;
      models?: string[];
      modelMapping?: Record<string, string>;
      priority?: number;
      weight?: number;
      healthCheck?: number;
    };
    if (!body.groupKey) return void reply.status(400).send({ error: { message: '缺少 groupKey' } });
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };
    if (body.provider != null) push('provider', body.provider);
    if (body.baseUrl != null) push('base_url', body.baseUrl);
    if (body.models != null) push('models', JSON.stringify(body.models));
    if (body.modelMapping != null) push('model_mapping', JSON.stringify(body.modelMapping));
    if (body.priority != null) push('priority', body.priority);
    if (body.weight != null) push('weight', body.weight);
    if (body.healthCheck != null) push('health_check', body.healthCheck);
    if (!sets.length) return void reply.send({ data: { ok: true, count: 0 } });
    push('updated_at', Date.now());
    params.push(body.groupKey);
    const res = run(`UPDATE channels SET ${sets.join(', ')} WHERE group_key = ?`, ...params);
    void reply.send({ data: { ok: true, count: Number(res.changes ?? 0) } });
  });

  app.post('/api/channels/group/delete', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { groupKey } = (req.body || {}) as { groupKey?: string };
    if (!groupKey) return void reply.status(400).send({ error: { message: '缺少 groupKey' } });
    const res = run('DELETE FROM channels WHERE group_key = ?', groupKey);
    void reply.send({ data: { ok: true, count: Number(res.changes ?? 0) } });
  });

  app.post('/api/channels/:id/test', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
    if (!row) return void reply.status(404).send({ error: { message: '渠道不存在' } });
    const result = await probeChannel(row, loadSettings());
    void reply.send({ data: result });
  });

  /**
   * 批量测试渠道内模型是否可用（真实 1 token chat 调用，收费模型会产生极少量费用）。
   * body: { models?: string[]; concurrency?: number }
   * 未传 models 时：取渠道配置的全部模型；若为通配 * 或空，则先从上游拉取模型列表。
   */
  app.post('/api/channels/:id/test-models', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
    if (!row) return void reply.status(404).send({ error: { message: '渠道不存在' } });

    const body = (req.body || {}) as { models?: string[]; concurrency?: number };
    const s = loadSettings();
    const timeoutMs = Math.max(5000, Math.min(120000, s.healthCheckTimeoutMs || 15000));

    let models: string[] =
      Array.isArray(body.models) && body.models.length
        ? body.models.filter((m): m is string => typeof m === 'string' && !!m && m !== '*')
        : allPublicModelsOf(row);

    // 渠道未列具体模型（如通配 *）：先从上游拉取模型列表
    if (!models.length) {
      const adaptor = getAdaptor(row.provider);
      const upstream = adaptor.buildModelsRequest({
        baseUrl: normalizeBaseUrl(row.base_url),
        apiKey: decrypt(row.api_key_enc),
      });
      try {
        const res = await fetchWithTimeout(upstream.url, { method: 'GET', headers: upstream.headers }, 20000);
        const text = await res.text();
        if (!res.ok) {
          return void reply
            .status(400)
            .send({ error: { message: `上游返回 ${res.status}: ${text.slice(0, 300)}（无法获取模型列表）` } });
        }
        models = adaptor.parseModelsResponse(JSON.parse(text));
      } catch (err) {
        return void reply.status(502).send({ error: { message: `拉取模型列表失败: ${(err as Error).message}` } });
      }
    }

    if (!models.length) {
      return void reply.status(400).send({ error: { message: '该渠道没有可测试的模型' } });
    }
    // 安全阀：单次最多 300 个，避免大量真实调用
    const capped = models.length > 300;
    if (capped) models = models.slice(0, 300);

    const concurrency = Math.min(20, Math.max(1, Number(body.concurrency) || 5));
    const results: ModelProbeResult[] = new Array(models.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < models.length) {
        const i = cursor++;
        results[i] = await probeModel(row, models[i], timeoutMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, models.length) }, worker));

    const okCount = results.filter((r) => r.ok).length;
    void reply.send({
      data: {
        channelId: id,
        total: results.length,
        ok: okCount,
        failed: results.length - okCount,
        capped,
        results,
      },
    });
  });

  /** 拉取上游 /v1/models 自动填充模型列表 */
  app.post('/api/channels/:id/fetch-models', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = Number((req.params as { id: string }).id);
    const row = get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
    if (!row) return void reply.status(404).send({ error: { message: '渠道不存在' } });

    const adaptor = getAdaptor(row.provider);
    const upstream = adaptor.buildModelsRequest({
      baseUrl: normalizeBaseUrl(row.base_url),
      apiKey: decrypt(row.api_key_enc),
    });
    try {
      const res = await fetchWithTimeout(upstream.url, { method: 'GET', headers: upstream.headers }, 20000);
      const text = await res.text();
      if (!res.ok) {
        return void reply.status(400).send({ error: { message: `上游返回 ${res.status}: ${text.slice(0, 300)}` } });
      }
      const models = adaptor.parseModelsResponse(JSON.parse(text));
      run('UPDATE channels SET models = ?, updated_at = ? WHERE id = ?', JSON.stringify(models), Date.now(), id);
      void reply.send({ data: { models } });
    } catch (err) {
      void reply.status(502).send({ error: { message: `拉取失败: ${(err as Error).message}` } });
    }
  });

  /**
   * 批量导入，每行（逗号分隔，至少 3 列）：
   *   名称, BaseURL, APIKey, [模型(空格分隔)], [优先级], [权重], [厂商类型]
   */
  app.post('/api/channels/batch', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { text } = (req.body || {}) as { text?: string };
    if (!text) return void reply.status(400).send({ error: { message: '缺少 text 字段' } });

    const now = Date.now();
    let created = 0;
    const errors: string[] = [];
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    lines.forEach((line, idx) => {
      const parts = line.split(',').map((p) => p.trim());
      if (parts.length < 3) {
        errors.push(`第 ${idx + 1} 行字段不足: ${line.slice(0, 60)}`);
        return;
      }
      const [name, baseUrl, apiKey, modelPart = '', priorityStr = '', weightStr = '', provider = ''] = parts;
      const models = modelPart.split(/[;；\s]+/).map((m) => m.trim()).filter(Boolean);
      run(
        `INSERT INTO channels (name, provider, base_url, api_key_enc, models, model_mapping,
           priority, weight, enabled, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        name || `渠道-${idx + 1}`,
        provider || 'openai-compatible',
        baseUrl,
        encrypt(apiKey || ''),
        JSON.stringify(models),
        '{}',
        Number(priorityStr) || 10,
        Number(weightStr) || 1,
        1,
        'unknown',
        now,
        now,
      );
      created++;
    });

    void reply.send({ data: { created, errors } });
  });
}
