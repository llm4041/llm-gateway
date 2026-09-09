import type { ChannelRow } from '../db/schema';
import { decrypt } from '../utils/crypto';
import { classifyStatus, fetchWithTimeout, GatewayError } from '../utils/errors';
import { getAdaptor, normalizeBaseUrl, PROBE_MAX_TOKENS_FALLBACK, isMaxTokensError } from './adaptor/openai';
import { getModelsOf } from './selector';
import { recordFailure, recordSuccess } from './breaker';
import type { SysSettings } from '../config';

export type ProbeResult = {
  channelId: number;
  name: string;
  ok: boolean;
  latencyMs: number;
  mode: 'models' | 'chat';
  error?: string;
  models?: string[];
};

function pickProbeModel(ch: ChannelRow, s: SysSettings): string {
  if (s.healthProbeModel) return s.healthProbeModel;
  const models = getModelsOf(ch).filter((m) => m && m !== '*');
  return models[0] || 'gpt-3.5-turbo';
}

/** 对单个渠道做一次健康探测（轻量 /models 或真实 chat 极短输出） */
export async function probeChannel(ch: ChannelRow, s: SysSettings): Promise<ProbeResult> {
  const adaptor = getAdaptor(ch.provider);
  const baseUrl = normalizeBaseUrl(ch.base_url);
  const apiKey = decrypt(ch.api_key_enc);
  const started = Date.now();

  try {
    if (s.healthProbeMode === 'chat') {
      const model = pickProbeModel(ch, s);
      const req = adaptor.buildHealthChatRequest({ baseUrl, apiKey, actualModel: model });
      const res = await fetchWithTimeout(
        req.url,
        { method: 'POST', headers: req.headers, body: req.body },
        s.healthCheckTimeoutMs,
      );
      const text = await res.text();
      if (!res.ok) {
        // 上游要求更大的 max_tokens 时换值重试一次
        if (isMaxTokensError(text)) {
          const req2 = adaptor.buildHealthChatRequest(
            { baseUrl, apiKey, actualModel: model },
            PROBE_MAX_TOKENS_FALLBACK,
          );
          const res2 = await fetchWithTimeout(
            req2.url,
            { method: 'POST', headers: req2.headers, body: req2.body },
            s.healthCheckTimeoutMs,
          );
          const text2 = await res2.text();
          if (res2.ok) {
            JSON.parse(text2);
            recordSuccess(ch, Date.now() - started, s);
            return { channelId: ch.id, name: ch.name, ok: true, latencyMs: Date.now() - started, mode: 'chat' };
          }
          const c2 = classifyStatus(res2.status, text2);
          throw new GatewayError(res2.status, c2.message, c2.type, c2.retryable, text2);
        }
        const c = classifyStatus(res.status, text);
        throw new GatewayError(res.status, c.message, c.type, c.retryable, text);
      }
      JSON.parse(text); // 能解析即视为格式正常
    } else {
      const req = adaptor.buildModelsRequest({ baseUrl, apiKey });
      const res = await fetchWithTimeout(req.url, { method: 'GET', headers: req.headers }, s.healthCheckTimeoutMs);
      const text = await res.text();
      if (!res.ok) {
        const c = classifyStatus(res.status, text);
        throw new GatewayError(res.status, c.message, c.type, c.retryable, text);
      }
      const json = JSON.parse(text);
      const models = adaptor.parseModelsResponse(json);
      recordSuccess(ch, Date.now() - started, s);
      return { channelId: ch.id, name: ch.name, ok: true, latencyMs: Date.now() - started, mode: 'models', models };
    }
    recordSuccess(ch, Date.now() - started, s);
    return { channelId: ch.id, name: ch.name, ok: true, latencyMs: Date.now() - started, mode: s.healthProbeMode };
  } catch (err) {
    const e = err instanceof GatewayError ? err : new GatewayError(502, (err as Error)?.message || '探测失败');
    recordFailure(ch, e.message, e.type, s);
    return {
      channelId: ch.id,
      name: ch.name,
      ok: false,
      latencyMs: Date.now() - started,
      mode: s.healthProbeMode,
      error: e.message,
    };
  }
}
