import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Input, Select, Space, Tag, Typography, App } from 'antd';
import { ClearOutlined, MessageOutlined, SendOutlined } from '@ant-design/icons';
import { api, getToken, clearToken } from '../api/client';

type Msg = {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  error?: boolean;
};

/** 会话本地持久化：切窗口/切页签/刷新后不丢 */
const CHAT_KEY = 'gw_chat_state';

function loadChatState(): { messages: Msg[]; model: string; latency: number | null } {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (!raw) return { messages: [], model: '', latency: null };
    const s = JSON.parse(raw);
    return {
      messages: Array.isArray(s.messages) ? s.messages : [],
      model: typeof s.model === 'string' ? s.model : '',
      latency: typeof s.latency === 'number' ? s.latency : null,
    };
  } catch {
    return { messages: [], model: '', latency: null };
  }
}

export default function Chat() {
  const saved = useRef(loadChatState()).current;
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState<string>(saved.model);
  const [messages, setMessages] = useState<Msg[]>(saved.messages);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [latency, setLatency] = useState<number | null>(saved.latency);
  const [err, setErr] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { message } = App.useApp();

  // 会话变化即持久化
  useEffect(() => {
    try {
      localStorage.setItem(CHAT_KEY, JSON.stringify({ messages, model, latency }));
    } catch {
      /* 存储满等异常忽略 */
    }
  }, [messages, model, latency]);

  const loadModels = async () => {
    try {
      const list = await api.get<string[]>('/api/models');
      setModels(list);
      if (list.length && !model) setModel(list[0]);
      if (!list.length) setErr('暂无可用模型：请先在「渠道管理」中添加并填写模型，或用「从上游获取模型」拉取。');
      else setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  useEffect(() => {
    void loadModels();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!model) {
      message.warning('请先选择一个模型');
      return;
    }
    setErr(null);
    const next: Msg[] = [
      ...messages,
      { role: 'user', content: text },
      { role: 'assistant', content: '' },
    ];
    setMessages(next);
    setInput('');
    setBusy(true);
    const t0 = performance.now();
    let firstToken = true;

    try {
      const token = getToken();
      const apiMessages = next.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          messages: apiMessages,
          stream: true,
          // OpenAI 兼容协议：流式下需显式要求在最后一个分片返回 usage（网关透传上游分片）
          stream_options: { include_usage: true },
        }),
      });

      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => '');
        let msg = txt || `HTTP ${res.status}`;
        let etype = '';
        try {
          const j = JSON.parse(txt);
          msg = j?.error?.message || msg;
          etype = j?.error?.type || '';
        } catch {
          /* keep raw */
        }
        // 仅网关自身的管理员会话失效才登出；上游透传的 401（如付费模型 PAID_MODEL_AUTH_REQUIRED）
        // 属于模型级错误，不应清掉登录态
        if (
          res.status === 401 &&
          ['unauthorized', 'invalid_key', 'expired_key', 'missing_key'].includes(etype)
        ) {
          clearToken();
          window.location.href = '/login';
          return;
        }
        setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: msg, error: true } : x)));
        setErr(msg);
        setBusy(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const json = JSON.parse(payload);
            const choice = json.choices?.[0];
            const delta = choice?.delta?.content || '';
            const reasoning =
              choice?.delta?.reasoning_content || choice?.delta?.reasoning || '';
            if (firstToken) {
              setLatency(Math.round(performance.now() - t0));
              firstToken = false;
            }
            // 上游分片为透传原样数据，usage 字段是 snake_case（兼容部分上游 camelCase）
            const u = json.usage;
            const usage = u
              ? {
                  promptTokens: u.prompt_tokens ?? u.promptTokens,
                  completionTokens: u.completion_tokens ?? u.completionTokens,
                  totalTokens: u.total_tokens ?? u.totalTokens,
                }
              : undefined;
            setMessages((m) =>
              m.map((x, i) => {
                if (i !== m.length - 1) return x;
                return {
                  ...x,
                  content: x.content + delta,
                  reasoning: (x.reasoning || '') + reasoning,
                  usage: usage ?? x.usage,
                };
              }),
            );
          } catch {
            /* ignore malformed line */
          }
        }
      }
      if (firstToken) setLatency(Math.round(performance.now() - t0));
    } catch (e: any) {
      const msg = e?.message || '请求失败';
      setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, content: msg, error: true } : x)));
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  const clearConv = () => {
    setMessages([]);
    setErr(null);
    setLatency(null);
  };

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          对话测试
        </Typography.Title>
        <Space>
          <Select
            style={{ width: 280 }}
            placeholder="选择模型"
            value={model || undefined}
            onChange={setModel}
            options={models.map((m) => ({ label: m, value: m }))}
            showSearch
          />
          <Button icon={<ClearOutlined />} onClick={clearConv} disabled={busy}>
            清空对话
          </Button>
          <Button icon={<MessageOutlined />} onClick={loadModels}>
            刷新模型
          </Button>
        </Space>
      </div>

      <Card className="card" styles={{ body: { padding: 0 } }}>
        <div
          ref={scrollRef}
          style={{ height: 'calc(100vh - 260px)', overflowY: 'auto', padding: 20 }}
        >
          {messages.length === 0 ? (
            <Empty
              style={{ marginTop: 80 }}
              description={
                model
                  ? `已选择模型「${model}」，在下方输入消息开始测试`
                  : '请先选择模型（若无可选模型，请先添加渠道并配置模型）'
              }
            />
          ) : (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              {messages.map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
                  }}
                >
                  <div
                    style={{
                      maxWidth: '82%',
                      padding: '10px 14px',
                      borderRadius: 10,
                      background: m.role === 'user' ? '#4f46e5' : '#f4f5f8',
                      color: m.role === 'user' ? '#fff' : undefined,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      border: m.error ? '1px solid #ff4d4f' : undefined,
                    }}
                  >
                    {m.reasoning && (
                      <div
                        style={{
                          color: m.role === 'user' ? 'rgba(255,255,255,0.8)' : '#8c8c8c',
                          fontSize: 12,
                          fontStyle: 'italic',
                          whiteSpace: 'pre-wrap',
                          marginBottom: 6,
                          borderBottom: '1px dashed rgba(128,128,128,0.3)',
                          paddingBottom: 6,
                        }}
                      >
                        {m.reasoning}
                      </div>
                    )}
                    {m.content || (busy && i === messages.length - 1 ? '▍' : '')}
                  </div>
                </div>
              ))}
            </Space>
          )}
        </div>

        {err && (
          <div style={{ padding: '0 20px 8px', color: '#ff4d4f', fontSize: 13 }}>{err}</div>
        )}

        <div
          style={{
            borderTop: '1px solid #eef0f4',
            padding: 16,
            display: 'flex',
            gap: 12,
            alignItems: 'flex-end',
          }}
        >
          <Input.TextArea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={model ? `向 ${model} 发送消息（Enter 发送，Shift+Enter 换行）` : '请先选择模型'}
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={busy || !model}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            type="primary"
            icon={<SendOutlined />}
            loading={busy}
            onClick={send}
            disabled={!model}
          >
            发送
          </Button>
        </div>

        <div style={{ padding: '0 16px 12px', color: '#999', fontSize: 12 }}>
          {latency != null && <Tag color="blue">首字延迟 {latency}ms</Tag>}
          {messages.length > 0 &&
            (() => {
              const last = messages[messages.length - 1].usage;
              if (!last) return null;
              return (
                <Tag color="default">
                  tokens: {last.promptTokens ?? '-'}↑ / {last.completionTokens ?? '-'}↓ /{' '}
                  {last.totalTokens ?? '-'}≈
                </Tag>
              );
            })()}
        </div>
      </Card>
    </div>
  );
}
