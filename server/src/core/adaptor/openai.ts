import {
  type Adaptor,
  type AdaptorContext,
  type ChatRequestBody,
  type ParsedChunk,
  type UpstreamRequest,
  type Usage,
  authHeaders,
  joinUrl,
  normalizeBaseUrl,
} from './types';

export { normalizeBaseUrl };

/** 探测用的最小输出长度：部分上游要求 max_tokens > 2（甚至更大），1 会被拒绝 */
export const PROBE_MAX_TOKENS = 16;
/** 上游仍嫌小时再试一次的值 */
export const PROBE_MAX_TOKENS_FALLBACK = 64;

/** 上游报错是否与 max_tokens 取值有关（需要换个值重试） */
export function isMaxTokensError(text: string): boolean {
  return /max_tokens/i.test(text || '');
}

function toUsage(raw: any): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const promptTokens = raw.prompt_tokens ?? raw.input_tokens;
  const completionTokens = raw.completion_tokens ?? raw.output_tokens;
  const totalTokens = raw.total_tokens ?? (promptTokens != null && completionTokens != null ? promptTokens + completionTokens : undefined);
  if (promptTokens == null && completionTokens == null && totalTokens == null) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

export const openaiAdaptor: Adaptor = {
  name: 'openai-compatible',

  buildChatRequest(ctx: AdaptorContext, body: ChatRequestBody): UpstreamRequest {
    const payload = { ...body, model: ctx.actualModel };
    return {
      url: joinUrl(ctx.baseUrl, 'chat/completions'),
      headers: authHeaders(ctx.apiKey),
      body: JSON.stringify(payload),
    };
  },

  buildHealthChatRequest(ctx: AdaptorContext, maxTokens: number = PROBE_MAX_TOKENS): UpstreamRequest {
    return {
      url: joinUrl(ctx.baseUrl, 'chat/completions'),
      headers: authHeaders(ctx.apiKey),
      body: JSON.stringify({
        model: ctx.actualModel,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: maxTokens,
        stream: false,
      }),
    };
  },

  buildModelsRequest(ctx): { url: string; headers: Record<string, string> } {
    return { url: joinUrl(ctx.baseUrl, 'models'), headers: authHeaders(ctx.apiKey) };
  },

  parseModelsResponse(json: unknown): string[] {
    const data = (json as any)?.data;
    if (!Array.isArray(data)) return [];
    return data
      .map((m: any) => (typeof m === 'string' ? m : m?.id || m?.name))
      .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
  },

  parseChatResponse(json: any) {
    const choice = json?.choices?.[0];
    const message = choice?.message ?? {};
    let text = '';
    if (typeof message?.content === 'string') text = message.content;
    else if (Array.isArray(message?.content)) {
      text = message.content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    return {
      text,
      usage: toUsage(json?.usage),
      finishReason: choice?.finish_reason ?? null,
    };
  },

  parseStreamLine(line: string): ParsedChunk | null {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return null;
    const payload = trimmed.slice(5).trim();
    if (!payload) return null;
    if (payload === '[DONE]') return { delta: '', done: true };

    let json: any;
    try {
      json = JSON.parse(payload);
    } catch {
      return null;
    }
    const choice = json?.choices?.[0];
    const deltaObj = choice?.delta ?? {};
    let delta = '';
    if (typeof deltaObj?.content === 'string') delta = deltaObj.content;
    else if (Array.isArray(deltaObj?.content)) {
      delta = deltaObj.content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    const reasoning =
      typeof deltaObj?.reasoning_content === 'string'
        ? deltaObj.reasoning_content
        : typeof deltaObj?.reasoning === 'string'
          ? deltaObj.reasoning
          : undefined;

    return {
      delta,
      reasoningDelta: reasoning,
      finishReason: choice?.finish_reason ?? null,
      usage: toUsage(json?.usage),
      done: false,
    };
  },
};

const registry: Record<string, Adaptor> = {
  'openai-compatible': openaiAdaptor,
  openai: openaiAdaptor,
  deepseek: openaiAdaptor,
  qwen: openaiAdaptor,
  moonshot: openaiAdaptor,
  siliconflow: openaiAdaptor,
  groq: openaiAdaptor,
  openrouter: openaiAdaptor,
  ollama: openaiAdaptor,
  vllm: openaiAdaptor,
  // 二期在此注册 anthropic / gemini 原生适配器
};

export function getAdaptor(provider: string): Adaptor {
  return registry[provider] || openaiAdaptor;
}
