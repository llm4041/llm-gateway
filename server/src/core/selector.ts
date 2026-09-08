import { all } from '../db';
import type { ChannelRow } from '../db/schema';
import { getSetting, setSetting } from '../db/settings';
import { getAdaptor, normalizeBaseUrl } from './adaptor/openai';

export { normalizeBaseUrl };

export type ChannelCandidate = {
  channel: ChannelRow;
  actualModel: string;
  baseUrl: string;
};

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : (v as T);
  } catch {
    return fallback;
  }
}

export function getModelsOf(ch: ChannelRow): string[] {
  return parseJson<string[]>(ch.models, []);
}

export function getMappingOf(ch: ChannelRow): Record<string, string> {
  return parseJson<Record<string, string>>(ch.model_mapping, {});
}

export function supportsModel(ch: ChannelRow, publicModel: string): boolean {
  const models = getModelsOf(ch);
  if (Object.prototype.hasOwnProperty.call(getMappingOf(ch), publicModel)) return true;
  if (models.includes('*')) return true;
  return models.includes(publicModel);
}

export function resolveActualModel(ch: ChannelRow, publicModel: string): string {
  return getMappingOf(ch)[publicModel] || publicModel;
}

function isAvailableNow(ch: ChannelRow, now: number): boolean {
  if (!ch.enabled) return false;
  if (ch.cooldown_until && ch.cooldown_until > now) return false;
  return true;
}

function weightedShuffle<T extends { weight: number }>(items: T[]): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (pool.length) {
    const total = pool.reduce((s, i) => s + Math.max(1, i.weight), 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < pool.length; i++) {
      r -= Math.max(1, pool[i].weight);
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

const rrCursor = new Map<string, number>();

/**
 * 按路由表选出候选渠道队列（有序）。
 * - 有路由：priority=严格按拖拽顺序；weighted=按权重随机排序；round_robin=按路由顺序轮转起点
 * - 无路由：按渠道 priority 升序，同优先级内按权重随机
 */
export function selectChannels(publicModel: string): {
  candidates: ChannelCandidate[];
  routeId: number | null;
  strategy: string;
} {
  const now = Date.now();
  const allChannels = all<ChannelRow>('SELECT * FROM channels ORDER BY priority ASC, id ASC');
  const usable = allChannels.filter((ch) => isAvailableNow(ch, now) && supportsModel(ch, publicModel));

  const route = all<{
    id: number;
    public_model: string;
    channel_ids: string;
    strategy: string;
    enabled: number;
  }>('SELECT * FROM model_routes').find((r) => r.public_model === publicModel && r.enabled === 1);

  const toCandidate = (ch: ChannelRow): ChannelCandidate => ({
    channel: ch,
    actualModel: resolveActualModel(ch, publicModel),
    baseUrl: normalizeBaseUrl(ch.base_url),
  });

  if (route) {
    const orderIds = parseJson<number[]>(route.channel_ids, []);
    const byId = new Map(usable.map((c) => [c.id, c]));
    let ordered = orderIds.map((id) => byId.get(id)).filter((c): c is ChannelRow => !!c);
    // 路由中配置了但当前不可用的渠道跳过；未列出的可用渠道追加到末尾兜底
    const extra = usable.filter((c) => !orderIds.includes(c.id));
    const strategy = route.strategy || 'priority';

    if (strategy === 'weighted') {
      return {
        candidates: weightedShuffle([...ordered, ...extra]).map(toCandidate),
        routeId: route.id,
        strategy,
      };
    }
    if (strategy === 'round_robin' && ordered.length) {
      const key = `route:${route.id}`;
      const cursor = (rrCursor.get(key) || 0) % ordered.length;
      rrCursor.set(key, cursor + 1);
      ordered = [...ordered.slice(cursor), ...ordered.slice(0, cursor)];
    }
    return { candidates: [...ordered, ...extra].map(toCandidate), routeId: route.id, strategy };
  }

  const groups = new Map<number, ChannelRow[]>();
  for (const ch of usable) {
    const list = groups.get(ch.priority) || [];
    list.push(ch);
    groups.set(ch.priority, list);
  }
  const sorted: ChannelRow[] = [];
  for (const p of [...groups.keys()].sort((a, b) => a - b)) {
    sorted.push(...weightedShuffle(groups.get(p)!));
  }
  return { candidates: sorted.map(toCandidate), routeId: null, strategy: 'priority' };
}

/** 聚合所有可用渠道暴露的模型，供 /v1/models 与前端选择使用 */
export function listAvailableModels(): { publicModels: string[]; byChannel: Record<number, string[]> } {
  const now = Date.now();
  const rows = all<ChannelRow>('SELECT * FROM channels').filter((ch) => isAvailableNow(ch, now));
  const set = new Set<string>();
  const byChannel: Record<number, string[]> = {};
  for (const ch of rows) {
    const models = getModelsOf(ch);
    byChannel[ch.id] = models;
    for (const m of models) if (m && m !== '*') set.add(m);
    for (const m of Object.keys(getMappingOf(ch))) set.add(m);
  }
  return { publicModels: [...set].sort(), byChannel };
}

/** 读取用户自定义的模型展示顺序（settings 表 model_order，JSON 数组） */
export function getModelOrder(): string[] {
  const v = getSetting('model_order');
  return Array.isArray(v) ? v.filter((m) => typeof m === 'string') : [];
}

/** 保存模型展示顺序 */
export function saveModelOrder(models: string[]): void {
  setSetting('model_order', models.filter((m) => typeof m === 'string' && m));
}

/** 读取模型降级配置：{ 模型A: [失败后依次尝试的模型B, 模型C...] } */
export function getFallbackMap(): Record<string, string[]> {
  const v = getSetting('model_fallbacks');
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, string[]> = {};
    for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
      if (Array.isArray(arr)) out[k] = arr.filter((m): m is string => typeof m === 'string');
    }
    return out;
  }
  return {};
}

export function getFallbackModels(model: string): string[] {
  return getFallbackMap()[model] || [];
}

/** 保存某模型的降级链（空数组表示删除该模型的降级配置） */
export function saveFallbackModels(model: string, fallbacks: string[]): void {
  if (!model) return;
  const map = getFallbackMap();
  const list = fallbacks.filter((m) => typeof m === 'string' && m && m !== model);
  if (list.length) map[model] = list;
  else delete map[model];
  setSetting('model_fallbacks', map);
}

/**
 * 按用户自定义顺序输出模型列表：
 * 自定义顺序里存在的排前面（保持用户顺序），其余按字母序追加，保证不丢模型。
 */
export function orderedPublicModels(): string[] {
  const { publicModels } = listAvailableModels();
  const order = getModelOrder();
  if (!order.length) return publicModels;
  const available = new Set(publicModels);
  const head = order.filter((m) => available.has(m));
  const rest = publicModels.filter((m) => !order.includes(m));
  return [...head, ...rest];
}

export { getAdaptor };
