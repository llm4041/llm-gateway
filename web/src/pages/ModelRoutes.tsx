import { useEffect, useState } from 'react';
import {
  App,
  Badge,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DeleteOutlined, HolderOutlined, ReloadOutlined, SaveOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api } from '../api/client';

type RouteChannel = {
  id: number;
  name: string;
  enabled: number;
  status: string;
  priority: number;
  weight: number;
  latencyMs: number | null;
};

type ModelRoute = {
  model: string;
  hasRoute: boolean;
  strategy: string;
  channelIds: number[];
  channels: RouteChannel[];
  availableCount: number;
  fallbacks: string[];
};

const STATUS: Record<string, { color: string; text: string }> = {
  healthy: { color: 'success', text: '健康' },
  failing: { color: 'error', text: '异常' },
  disabled: { color: 'default', text: '停用' },
  unknown: { color: 'warning', text: '未检测' },
};

function SortableList({
  items,
  onChange,
}: {
  items: RouteChannel[];
  onChange: (next: RouteChannel[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...items];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    onChange(next);
  };

  if (!items.length) {
    return (
      <Empty description="该模型暂无可用渠道，请先在渠道管理中配置" image={Empty.PRESENTED_IMAGE_SIMPLE} />
    );
  }

  if (items.length === 1) {
    return (
      <div>
        <div className="drag-item">
          <HolderOutlined style={{ color: '#9ca3af' }} />
          <span className="order">1</span>
          <Badge status={(STATUS[items[0].status] || STATUS.unknown).color as any} text={items[0].name} />
          <Tag bordered={false}>优先级 {items[0].priority}</Tag>
          <Tag bordered={false}>权重 {items[0].weight}</Tag>
          {items[0].latencyMs != null && <Tag bordered={false}>{items[0].latencyMs}ms</Tag>}
          {!items[0].enabled && <Tag color="orange">已停用</Tag>}
        </div>
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
          该模型当前只有 1 个渠道，无需排序。想让「先 A 渠道、失败再 B 渠道」：
          在渠道管理中再添加一个支持此模型（或用别名映射到同一对外模型名）的渠道，即可回到这里拖动排序。
        </Typography.Paragraph>
      </div>
    );
  }

  return (
    <div>
      {items.map((c, i) => {
        const st = STATUS[c.status] || STATUS.unknown;
        return (
          <div
            key={c.id}
            className={`drag-item ${dragIndex === i ? 'dragging' : ''}`}
            draggable
            onDragStart={(e) => {
              // Firefox 需要 dataTransfer 有数据才会触发后续 drag 事件
              e.dataTransfer.setData('text/plain', String(i));
              e.dataTransfer.effectAllowed = 'move';
              setDragIndex(i);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(i);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex != null) move(dragIndex, i);
              setDragIndex(null);
              setOverIndex(null);
            }}
            style={overIndex === i && dragIndex !== i ? { borderColor: '#4f46e5', borderStyle: 'dashed' } : undefined}
          >
            <HolderOutlined style={{ color: '#9ca3af' }} />
            <span className="order">{i + 1}</span>
            <Badge status={st.color as any} text={c.name} />
            <Tag bordered={false}>优先级 {c.priority}</Tag>
            <Tag bordered={false}>权重 {c.weight}</Tag>
            {c.latencyMs != null && <Tag bordered={false}>{c.latencyMs}ms</Tag>}
            {!c.enabled && <Tag color="orange">已停用</Tag>}
            <div style={{ flex: 1 }} />
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={() => onChange(items.filter((x) => x.id !== c.id))}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function ModelRoutes() {
  const [models, setModels] = useState<ModelRoute[]>([]);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Record<string, { channelIds: number[]; strategy: string }>>({});
  const [keyword, setKeyword] = useState('');
  const [dragModel, setDragModel] = useState<string | null>(null);
  const [overModel, setOverModel] = useState<string | null>(null);
  const [fallbacks, setFallbacks] = useState<Record<string, string[]>>({});
  const { message } = App.useApp();

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.get<ModelRoute[]>('/api/models/available');
      setModels(data);
      const d: Record<string, { channelIds: number[]; strategy: string }> = {};
      const fb: Record<string, string[]> = {};
      data.forEach((m) => {
        d[m.model] = { channelIds: m.channelIds, strategy: m.strategy };
        fb[m.model] = m.fallbacks || [];
      });
      setDraft(d);
      setFallbacks(fb);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const save = async (model: string) => {
    try {
      await api.post('/api/routes', {
        publicModel: model,
        channelIds: draft[model]?.channelIds || [],
        strategy: draft[model]?.strategy || 'priority',
        enabled: 1,
      });
      message.success(`「${model}」路由已保存`);
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const autoBuild = async () => {
    try {
      const r = await api.post<{ built: number }>('/api/routes/auto-build');
      message.success(`已按渠道优先级重建 ${r.built} 个模型路由`);
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  /** 保存模型降级链：该模型全部渠道失败后按顺序换降级模型重试 */
  const saveFallback = async (model: string, list: string[]) => {
    setFallbacks((prev) => ({ ...prev, [model]: list }));
    try {
      await api.put('/api/models/fallback', { model, fallbacks: list });
      message.success(list.length ? `「${model}」降级链已保存：${list.join(' → ')}` : `「${model}」降级已清除`);
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const filtered = models.filter((m) => m.model.toLowerCase().includes(keyword.toLowerCase()));

  /** 拖拽模型组排序：把 dragModel 移动到 overModel 的位置，持久化到 settings.model_order */
  const moveModel = async (dragKey: string, overKey: string) => {
    if (!dragKey || !overKey || dragKey === overKey) return;
    const next = [...models];
    const from = next.findIndex((m) => m.model === dragKey);
    const to = next.findIndex((m) => m.model === overKey);
    if (from < 0 || to < 0) return;
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setModels(next);
    try {
      await api.put('/api/models/order', { models: next.map((x) => x.model) });
      message.success('模型顺序已保存');
    } catch (e: any) {
      message.error(e.message);
    }
  };

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          模型路由
        </Typography.Title>
        <Space>
          <Input.Search placeholder="搜索模型" allowClear style={{ width: 220 }} onChange={(e) => setKeyword(e.target.value)} />
          <Tooltip title="按渠道的优先级字段，为所有模型生成默认顺序">
            <Button icon={<ThunderboltOutlined />} onClick={autoBuild}>
              一键重建
            </Button>
          </Tooltip>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        ① <b>拖动模型左侧的 ⠿ 手柄</b>可调整模型在列表与对话页下拉中的展示顺序（如把 z-ai/glm-5.3 拖到最前）。
        注意：实际调用用哪个模型由调用方决定（对话测试页选择 / 你的应用请求参数 model），模型顺序不影响路由。
        ② 展开某个模型后，可拖动组内渠道条目调整<b>该模型下多个渠道</b>的先后——越靠上越优先，调用失败时网关按此顺序依次尝试下一个渠道。
        ③ <b>失败降级</b>：该模型所有渠道都失败时，网关会按配置的降级顺序自动换下一个模型重试（首字节前对客户端透明）。
      </Typography.Paragraph>

      <Card className="card" styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <Empty description="暂无可用模型，请先在渠道管理中配置模型或拉取上游模型列表" style={{ padding: 40 }} />
        ) : (
          <Collapse
            accordion={false}
            items={filtered.map((m) => ({
              key: m.model,
              label: (
                <Space
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverModel(m.model);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    void moveModel(dragModel, m.model);
                    setDragModel(null);
                    setOverModel(null);
                  }}
                  style={{ cursor: 'default', ...(overModel === m.model && dragModel && dragModel !== m.model ? { outline: '2px dashed #4f46e5', outlineOffset: 4, borderRadius: 4 } : {}) }}
                >
                  <HolderOutlined
                    style={{ color: '#9ca3af', cursor: 'grab' }}
                    title="拖动调整模型顺序"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', m.model);
                      e.dataTransfer.effectAllowed = 'move';
                      setDragModel(m.model);
                    }}
                    onDragEnd={() => {
                      setDragModel(null);
                      setOverModel(null);
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                  <Typography.Text strong>{m.model}</Typography.Text>
                  {m.hasRoute ? (
                    <Tag color="blue" bordered={false}>
                      已配置
                    </Tag>
                  ) : (
                    <Tag bordered={false}>默认顺序</Tag>
                  )}
                  <Tag bordered={false}>{m.channels.length} 个渠道</Tag>
                  {(fallbacks[m.model] || []).length > 0 && (
                    <Tooltip title={`全部渠道失败后按序降级：${fallbacks[m.model].join(' → ')}`}>
                      <Tag color="purple" bordered={false}>
                        降级→{(fallbacks[m.model] || []).length} 个
                      </Tag>
                    </Tooltip>
                  )}
                </Space>
              ),
              children: (
                <div>
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Typography.Text type="secondary">负载均衡策略</Typography.Text>
                    <Select
                      size="small"
                      style={{ width: 160 }}
                      value={draft[m.model]?.strategy || 'priority'}
                      onChange={(v) => setDraft({ ...draft, [m.model]: { ...draft[m.model], strategy: v } })}
                      options={[
                        { value: 'priority', label: '优先级（严格按序）' },
                        { value: 'weighted', label: '加权随机' },
                        { value: 'round_robin', label: '轮询' },
                      ]}
                    />
                    <Button
                      size="small"
                      type="primary"
                      icon={<SaveOutlined />}
                      onClick={() => save(m.model)}
                    >
                      保存
                    </Button>
                  </Space>
                  <div style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary" style={{ marginRight: 8 }}>
                      失败降级
                    </Typography.Text>
                    <Select
                      mode="multiple"
                      size="small"
                      style={{ minWidth: 320, maxWidth: '100%' }}
                      placeholder="无（全部渠道失败即报错）"
                      value={fallbacks[m.model] || []}
                      onChange={(v) => void saveFallback(m.model, v)}
                      options={models
                        .filter((x) => x.model !== m.model)
                        .map((x) => ({ value: x.model, label: x.model }))}
                      maxTagCount="responsive"
                      placement="bottomLeft"
                    />
                    <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                      该模型所有渠道都失败时，按此顺序自动换模型重试
                    </Typography.Text>
                  </div>
                  <SortableList
                    items={(draft[m.model]?.channelIds || [])
                      .map((id) => m.channels.find((c) => c.id === id))
                      .filter(Boolean) as RouteChannel[]}
                    onChange={(next) =>
                      setDraft({
                        ...draft,
                        [m.model]: { ...draft[m.model], channelIds: next.map((c) => c.id) },
                      })
                    }
                  />
                </div>
              ),
            }))}
          />
        )}
      </Card>
    </div>
  );
}
