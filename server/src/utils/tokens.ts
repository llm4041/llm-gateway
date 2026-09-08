/** 上游未返回 usage 时的粗略估算：中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

export function estimateMessagesTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum: number, m: any) => {
    let content = '';
    if (typeof m?.content === 'string') content = m.content;
    else if (Array.isArray(m?.content)) {
      content = m.content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
    }
    return sum + estimateTokens(content) + 4;
  }, 0);
}
