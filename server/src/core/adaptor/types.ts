export type ChatRequestBody = {
  model: string;
  messages: unknown[];
  stream?: boolean;
  [key: string]: unknown;
};

export type UpstreamRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type Usage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

export type ParsedChunk = {
  /** 增量文本 */
  delta: string;
  /** 推理内容（reasoning_content / thinking），可选 */
  reasoningDelta?: string;
  finishReason?: string | null;
  usage?: Usage;
  done: boolean;
};

export type AdaptorContext = {
  baseUrl: string;
  apiKey: string;
  actualModel: string;
};

export interface Adaptor {
  name: string;
  buildChatRequest(ctx: AdaptorContext, body: ChatRequestBody): UpstreamRequest;
  buildModelsRequest(ctx: Pick<AdaptorContext, 'baseUrl' | 'apiKey'>): { url: string; headers: Record<string, string> };
  buildHealthChatRequest(ctx: AdaptorContext): UpstreamRequest;
  parseModelsResponse(json: unknown): string[];
  parseChatResponse(json: any): { text: string; usage?: Usage; finishReason?: string | null };
  parseStreamLine(line: string): ParsedChunk | null;
}

/** 规范化 Base URL：去掉末尾斜杠；未带 /vN 时自动补 /v1 */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw || '').trim().replace(/\/+$/, '');
  if (!url) return url;
  if (!/\/(v\d+)$/i.test(url)) url = `${url}/v1`;
  return url;
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}
