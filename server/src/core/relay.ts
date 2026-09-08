import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { run } from '../db';
import type { RequestLogInsert } from '../db/schema';
import { selectChannels, getFallbackModels, type ChannelCandidate } from './selector';
import { getAdaptor } from './adaptor/openai';
import { decrypt } from '../utils/crypto';
import { classifyStatus, fetchWithTimeout, GatewayError, type ErrorType } from '../utils/errors';
import { estimateMessagesTokens, estimateTokens } from '../utils/tokens';
import { bumpRequestStats, recordFailure, recordSuccess } from './breaker';
import { loadSettings } from '../config';
import { logger } from '../utils/logger';

export type KeyCtx = { keyId: number | null; keyName: string };
type FailoverItem = { channelId: number; channelName: string; error: string; at: number };

export type ChatBody = {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
};

function writeLog(entry: Partial<RequestLogInsert>): void {
  try {
    run(
      `INSERT INTO request_logs (
         ts, request_id, key_id, key_name, public_model, channel_id, channel_name, actual_model,
         stream, http_status, ok, error_type, error_msg, latency_ms, first_token_ms,
         prompt_tokens, completion_tokens, total_tokens, estimated, retry_count, failover_chain, client_ip
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      entry.ts ?? Date.now(),
      entry.request_id ?? '',
      entry.key_id ?? null,
      entry.key_name ?? null,
      entry.public_model ?? '',
      entry.channel_id ?? null,
      entry.channel_name ?? null,
      entry.actual_model ?? null,
      entry.stream ?? 0,
      entry.http_status ?? null,
      entry.ok ?? 0,
      entry.error_type ?? null,
      entry.error_msg ?? null,
      entry.latency_ms ?? null,
      entry.first_token_ms ?? null,
      entry.prompt_tokens ?? null,
      entry.completion_tokens ?? null,
      entry.total_tokens ?? null,
      entry.estimated ?? 0,
      entry.retry_count ?? 0,
      entry.failover_chain ?? '[]',
      entry.client_ip ?? null,
    );
  } catch (e) {
    logger.error('[relay] 写日志失败', e);
  }
}

function baseLog(args: {
  requestId: string;
  key: KeyCtx;
  model: string;
  clientIp: string;
  cand: ChannelCandidate | null;
  routeId: number | null;
  strategy: string;
  stream: boolean;
}) {
  const { requestId, key, model, clientIp, cand, stream } = args;
  return {
    ts: Date.now(),
    request_id: requestId,
    key_id: key.keyId,
    key_name: key.keyName,
    public_model: model,
    channel_id: cand?.channel.id ?? null,
    channel_name: cand?.channel.name ?? null,
    actual_model: cand?.actualModel ?? null,
    stream: stream ? 1 : 0,
    failover_chain: JSON.stringify([] as FailoverItem[]),
    client_ip: clientIp,
  } as Partial<RequestLogInsert>;
}

/** 非流式：一次性请求上游，收集 usage */
async function attemptNonStream(cand: ChannelCandidate, body: ChatBody, timeoutMs: number) {
  const adaptor = getAdaptor(cand.channel.provider);
  const apiKey = decrypt(cand.channel.api_key_enc);
  const req = adaptor.buildChatRequest(
    { baseUrl: cand.baseUrl, apiKey, actualModel: cand.actualModel },
    body as any,
  );
  const started = Date.now();
  const res = await fetchWithTimeout(
    req.url,
    { method: 'POST', headers: req.headers, body: req.body },
    timeoutMs,
  );
  const text = await res.text();
  if (!res.ok) {
    const c = classifyStatus(res.status, text);
    throw new GatewayError(res.status, c.message, c.type, c.retryable, text.slice(0, 2000));
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new GatewayError(502, `上游返回非 JSON: ${text.slice(0, 200)}`, 'server_error', true, text);
  }
  const parsed = adaptor.parseChatResponse(json);
  const promptTokens = parsed.usage?.promptTokens ?? estimateMessagesTokens(body.messages);
  const completionTokens = parsed.usage?.completionTokens ?? estimateTokens(parsed.text);
  const estimated = parsed.usage ? 0 : 1;
  return {
    json,
    latencyMs: Date.now() - started,
    promptTokens,
    completionTokens,
    totalTokens: parsed.usage?.totalTokens ?? promptTokens + completionTokens,
    estimated,
  };
}

/** 流式：先取首字节（此时失败可透明切换），再接管转发 */
async function attemptStream(
  cand: ChannelCandidate,
  body: ChatBody,
  reply: FastifyReply,
  timeoutMs: number,
): Promise<{ firstTokenMs: number; promise: Promise<{ promptTokens: number; completionTokens: number; estimated: number; completed: boolean }> }> {
  const adaptor = getAdaptor(cand.channel.provider);
  const apiKey = decrypt(cand.channel.api_key_enc);
  const req = adaptor.buildChatRequest(
    { baseUrl: cand.baseUrl, apiKey, actualModel: cand.actualModel },
    body as any,
  );
  const started = Date.now();

  const res = await fetchWithTimeout(
    req.url,
    { method: 'POST', headers: req.headers, body: req.body },
    timeoutMs,
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const c = classifyStatus(res.status, text);
    throw new GatewayError(res.status, c.message, c.type, c.retryable, text.slice(0, 2000));
  }
  if (!res.body) throw new GatewayError(502, '上游未返回响应体', 'network', true);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let first: { done: boolean; value?: Uint8Array };
  try {
    first = await reader.read();
  } catch (err) {
    const c = classifyStatus(502, (err as Error)?.message || '');
    throw new GatewayError(502, `流式首字节读取失败: ${(err as Error)?.message}`, 'network', true);
  }
  if (first.done && !first.value) {
    throw new GatewayError(502, '上游返回空流', 'server_error', true);
  }
  const firstTokenMs = Date.now() - started;

  const pt = new PassThrough();
  reply.header('Content-Type', 'text/event-stream; charset=utf-8');
  reply.header('Cache-Control', 'no-cache, no-transform');
  reply.header('Connection', 'keep-alive');
  reply.header('X-Accel-Buffering', 'no');
  reply.header('X-Gateway-Channel', String(cand.channel.id));
  reply.header('X-Gateway-Channel-Name', encodeURIComponent(cand.channel.name));
  reply.header('X-Gateway-Model', cand.actualModel);
  void reply.send(pt);

  // 首字节之后开始转发，中途失败不再静默切换（避免输出重复/内容损坏）
  let buffer = '';
  let promptTokens = 0;
  let completionTokens = 0;
  let sawUsage = false;
  let completed = false;
  let accText = '';

  const consumeChunk = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const parsed = adaptor.parseStreamLine(line);
      if (!parsed) continue;
      if (parsed.done) completed = true;
      if (parsed.delta) accText += parsed.delta;
      if (parsed.usage) {
        sawUsage = true;
        promptTokens = parsed.usage.promptTokens ?? promptTokens;
        completionTokens = parsed.usage.completionTokens ?? completionTokens;
      }
    }
  };

  const promise = (async () => {
    try {
      consumeChunk(first.value!);
      pt.write(first.value!);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeChunk(value);
        pt.write(value);
      }
      consumeChunk(new Uint8Array());
      pt.end();
      const estimated = sawUsage ? 0 : 1;
      if (!sawUsage) {
        promptTokens = estimateMessagesTokens(body.messages);
        completionTokens = estimateTokens(accText);
      }
      return { promptTokens, completionTokens, estimated, completed };
    } catch (err) {
      logger.warn(`[relay] 渠道「${cand.channel.name}」流式传输中断: ${(err as Error)?.message}`);
      pt.destroy(err as Error);
      const estimated = 1;
      return {
        promptTokens: estimateMessagesTokens(body.messages),
        completionTokens: estimateTokens(accText),
        estimated,
        completed: false,
      };
    }
  })();

  return { firstTokenMs, promise };
}

type RelayCtx = {
  s: ReturnType<typeof loadSettings>;
  requestId: string;
  key: KeyCtx;
  clientIp: string;
  stream: boolean;
  originalModel: string;
  /** 跨模型累积的失败链（含降级前各模型的渠道失败记录） */
  chain: FailoverItem[];
};

/**
 * 对单个模型执行完整的渠道尝试链（含渠道间故障切换），成功则响应已发出并返回；
 * 全部失败则抛出最后一个 GatewayError（已写失败日志）。
 */
async function tryRelayModel(
  model: string,
  body: ChatBody,
  reply: FastifyReply,
  ctx: RelayCtx,
): Promise<void> {
  const { s, requestId, key, clientIp, stream, chain } = ctx;
  const { candidates, routeId, strategy } = selectChannels(model);

  if (candidates.length === 0) {
    const msg = `没有可用于模型「${model}」的渠道（可能全部停用、冷却中或未配置该模型）`;
    writeLog({
      ...baseLog({ requestId, key, model, clientIp, cand: null, routeId, strategy, stream }),
      ok: 0,
      http_status: 503,
      error_type: 'no_channel' as ErrorType,
      error_msg: msg,
      latency_ms: 0,
      retry_count: chain.length,
      failover_chain: JSON.stringify(chain),
    });
    throw new GatewayError(503, msg, 'no_channel', false);
  }

  const maxAttempts = Math.min(candidates.length, Math.max(1, s.maxRetry) + 1);
  const chainStart = chain.length;
  let lastErr: GatewayError | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const cand = candidates[attempt];
    try {
      if (stream) {
        const { firstTokenMs, promise } = await attemptStream(cand, body, reply, s.requestTimeoutMs);
        const result = await promise;
        const latencyMs = firstTokenMs;
        recordSuccess(cand.channel, latencyMs, s);
        bumpRequestStats(cand.channel, result.completed, result.promptTokens + result.completionTokens);
        writeLog({
          ...baseLog({ requestId, key, model, clientIp, cand, routeId, strategy, stream }),
          ok: result.completed ? 1 : 0,
          http_status: 200,
          error_type: result.completed ? null : ('stream_aborted' as ErrorType),
          error_msg: result.completed ? null : '上游流式响应未正常结束（未收到 [DONE]）',
          latency_ms: latencyMs,
          first_token_ms: firstTokenMs,
          prompt_tokens: result.promptTokens,
          completion_tokens: result.completionTokens,
          total_tokens: result.promptTokens + result.completionTokens,
          estimated: result.estimated,
          retry_count: attempt,
          failover_chain: JSON.stringify(chain),
        });
        if (!result.completed) recordFailure(cand.channel, '流式响应中断', 'stream_aborted', s);
        return;
      }

      const r = await attemptNonStream(cand, body, s.requestTimeoutMs);
      recordSuccess(cand.channel, r.latencyMs, s);
      bumpRequestStats(cand.channel, true, r.totalTokens);
      if (model !== ctx.originalModel) reply.header('X-Gateway-Fallback', encodeURIComponent(ctx.originalModel));
      reply.header('X-Gateway-Channel', String(cand.channel.id));
      reply.header('X-Gateway-Channel-Name', encodeURIComponent(cand.channel.name));
      reply.header('X-Gateway-Model', cand.actualModel);
      writeLog({
        ...baseLog({ requestId, key, model, clientIp, cand, routeId, strategy, stream }),
        ok: 1,
        http_status: 200,
        latency_ms: r.latencyMs,
        prompt_tokens: r.promptTokens,
        completion_tokens: r.completionTokens,
        total_tokens: r.totalTokens,
        estimated: r.estimated,
        retry_count: attempt,
        failover_chain: JSON.stringify(chain),
      });
      void reply.send(r.json);
      return;
    } catch (err) {
      const e =
        err instanceof GatewayError
          ? err
          : new GatewayError(502, (err as Error)?.message || '转发失败', 'unknown', true);
      lastErr = e;
      chain.push({
        channelId: cand.channel.id,
        channelName: cand.channel.name,
        error: e.message.slice(0, 300),
        at: Date.now(),
      });
      // 非可重试错误（400/404 等请求本身问题）不计入熔断，避免误伤渠道；
      // 401/403 属于模型级鉴权失败（如聚合渠道的付费模型单独鉴权），
      // 也不计入渠道熔断——否则测几次付费模型就会把整个渠道误停用，key 真失效时日志持续可见可手动停用
      if (e.retryable) {
        bumpRequestStats(cand.channel, false, 0);
        if (e.type !== 'auth') {
          recordFailure(cand.channel, e.message, e.type, s);
        }
      }
      if (!e.retryable) break;
      logger.warn(`[relay] 渠道「${cand.channel.name}」失败(第 ${attempt + 1} 次)：${e.message.slice(0, 160)}`);
    }
  }

  // 该模型整链失败，写失败日志后抛出，由外层决定是否降级到下一个模型
  writeLog({
    ...baseLog({
      requestId,
      key,
      model,
      clientIp,
      cand: candidates[Math.min(chain.length - chainStart, candidates.length - 1)] ?? null,
      routeId,
      strategy,
      stream,
    }),
    ok: 0,
    http_status: lastErr?.status ?? 502,
    error_type: lastErr?.type ?? ('unknown' as ErrorType),
    error_msg: (lastErr?.message || '转发失败').slice(0, 1000),
    retry_count: chain.length - chainStart,
    failover_chain: JSON.stringify(chain),
  });
  throw lastErr ?? new GatewayError(502, '转发失败');
}

export async function relayChat(
  body: ChatBody,
  reply: FastifyReply,
  key: KeyCtx,
  clientIp: string,
): Promise<void> {
  const s = loadSettings();
  const requestId = randomUUID();
  const stream = body.stream === true;
  const ctx: RelayCtx = {
    s,
    requestId,
    key,
    clientIp,
    stream,
    originalModel: body.model,
    chain: [],
  };

  // 模型级降级链：原模型在前，配置的降级模型依次跟上（visited 防环）
  const tried = [body.model, ...getFallbackModels(body.model)];
  const visited = new Set<string>();
  let lastErr: GatewayError | null = null;

  for (const model of tried) {
    if (visited.has(model)) continue;
    visited.add(model);
    try {
      await tryRelayModel(model, body, reply, ctx);
      return;
    } catch (err) {
      lastErr =
        err instanceof GatewayError
          ? err
          : new GatewayError(502, (err as Error)?.message || '转发失败', 'unknown', true);
      if (model !== body.model) {
        logger.warn(
          `[relay] 模型「${body.model}」降级到「${model}」后仍失败: ${lastErr.message.slice(0, 160)}`,
        );
      }
    }
  }

  throw lastErr ?? new GatewayError(502, '转发失败');
}
