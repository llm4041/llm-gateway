import { useEffect, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  ApiOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { api } from '../api/client';

type Channel = {
  id: number;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  hasKey: boolean;
  models: string[];
  modelMapping: Record<string, string>;
  priority: number;
  weight: number;
  enabled: number;
  healthCheck: number;
  disabledReason: string | null;
  status: string;
  latencyMs: number | null;
  failStreak: number;
  lastError: string | null;
  lastCheckedAt: number | null;
  cooldownUntil: number | null;
  totalRequests: number;
  totalFailures: number;
  totalTokens: number;
  groupKey: string | null;
  groupIndex: number | null;
};

/** 列表行：可能是单个渠道，也可能是「多 Key 拆分出来」的渠道组（含 children） */
type Row = Channel & {
  rowKey: string;
  isGroup?: boolean;
  members?: Channel[];
  children?: Row[];
};

const PROVIDERS = [
  { value: 'openai-compatible', label: 'OpenAI 兼容（通用）' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: '通义千问' },
  { value: 'moonshot', label: 'Moonshot / Kimi' },
  { value: 'siliconflow', label: '硅基流动' },
  { value: 'groq', label: 'Groq' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama（本地）' },
  { value: 'vllm', label: 'vLLM（本地）' },
];

type ModelProbe = {
  model: string;
  actualModel: string;
  ok: boolean;
  latencyMs: number;
  httpStatus: number | null;
  error: string | null;
};

const STATUS_MAP: Record<string, { color: string; text: string }> = {
  healthy: { color: 'success', text: '健康' },
  failing: { color: 'error', text: '异常' },
  disabled: { color: 'default', text: '已停用' },
  unknown: { color: 'warning', text: '未检测' },
};

export default function Channels() {
  const [rows, setRows] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<Channel | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchText, setBatchText] = useState('');
  const [keyword, setKeyword] = useState('');
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [probing, setProbing] = useState(false);
  // 多 Key 拆分出的渠道组：列表默认折叠显示
  const [groupView, setGroupView] = useState(true);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);

  // 模型批量测试
  const [testRow, setTestRow] = useState<Channel | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [testSelected, setTestSelected] = useState<string[]>([]);
  const [testResults, setTestResults] = useState<ModelProbe[]>([]);
  const [testRunning, setTestRunning] = useState(false);
  const [testSummary, setTestSummary] = useState<{ total: number; ok: number; failed: number; capped: boolean } | null>(
    null,
  );
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [testManual, setTestManual] = useState('');

  // 「全选」候选：渠道配置的模型 + 别名 key + 已手动输入的模型名
  const testAllModels = Array.from(
    new Set<string>([
      ...(testRow?.models || []),
      ...Object.keys(testRow?.modelMapping || {}),
      ...testSelected,
    ]),
  ).filter((m) => m && m !== '*');

  const toggleTestModel = (m: string, checked: boolean) => {
    setTestSelected((prev) => (checked ? (prev.includes(m) ? prev : [...prev, m]) : prev.filter((x) => x !== m)));
  };
  const addTestModel = (v: string) => {
    const name = v.trim();
    if (!name) return;
    setTestSelected((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setTestManual('');
  };
  const removeTestModel = (m: string) => {
    setTestSelected((prev) => prev.filter((x) => x !== m));
  };

  const [form] = Form.useForm();
  const { message } = App.useApp();

  const load = async () => {
    setLoading(true);
    try {
      setRows(await api.get<Channel[]>('/api/channels'));
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setEditing(null);
    setEditingGroup(null);
    form.resetFields();
    setModelOptions([]);
    form.setFieldsValue({
      provider: 'openai-compatible',
      priority: 10,
      weight: 1,
      enabled: 1,
      models: [],
    });
    setDrawerOpen(true);
  };

  const openEdit = (row: Channel) => {
    setEditing(row);
    setEditingGroup(null);
    setModelOptions(row.models || []);
    form.setFieldsValue({
      ...row,
      models: row.models || [],
      healthCheck: row.healthCheck !== 0,
      modelMappingText: Object.entries(row.modelMapping || {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    });
    setDrawerOpen(true);
  };

  const submit = async () => {
    const v = await form.validateFields();
    const modelMapping: Record<string, string> = {};
    (v.modelMappingText || '')
      .split(/\r?\n/)
      .map((l: string) => l.trim())
      .filter(Boolean)
      .forEach((line: string) => {
        const [k, val] = line.split('=').map((s) => s.trim());
        if (k && val) modelMapping[k] = val;
      });

    const payload = {
      name: v.name,
      provider: v.provider,
      baseUrl: v.baseUrl,
      apiKey: v.apiKey === undefined || v.apiKey === null || v.apiKey === '' ? undefined : v.apiKey,
      models: v.models || [],
      modelMapping,
      priority: v.priority,
      weight: v.weight,
      enabled: v.enabled ? 1 : 0,
      healthCheck: v.healthCheck === false ? 0 : 1,
    };

    try {
      if (editingGroup) {
        const r = await api.put<{ count: number }>('/api/channels/group', {
          groupKey: editingGroup,
          provider: payload.provider,
          baseUrl: payload.baseUrl,
          models: payload.models,
          modelMapping,
          priority: payload.priority,
          weight: payload.weight,
          healthCheck: payload.healthCheck,
        });
        message.success(`已同步 ${r.count} 条渠道配置`);
      } else if (editing) {
        await api.put(`/api/channels/${editing.id}`, payload);
        message.success('保存成功');
      } else {
        const r = await api.post<{ count: number }>('/api/channels', { ...payload, apiKey: v.apiKey || '' });
        message.success(r.count > 1 ? `已创建 ${r.count} 条渠道（名称自动加序号 -1 ~ -${r.count}）` : '保存成功');
      }
      setDrawerOpen(false);
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  /** 编辑整个渠道组的共享配置（不含名称与 Key） */
  const openEditGroup = (row: Row) => {
    const members = row.members || [];
    if (!members.length) return;
    setEditing(null);
    setEditingGroup(row.groupKey || null);
    setModelOptions(members[0].models || []);
    form.setFieldsValue({
      provider: members[0].provider,
      baseUrl: members[0].baseUrl,
      models: members[0].models || [],
      priority: members[0].priority,
      weight: members[0].weight,
      healthCheck: members[0].healthCheck !== 0,
      modelMappingText: Object.entries(members[0].modelMapping || {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
    });
    setDrawerOpen(true);
  };

  const toggleGroup = async (row: Row, enabled: boolean) => {
    if (!row.groupKey) return;
    try {
      const r = await api.post<{ count: number }>('/api/channels/group/toggle', {
        groupKey: row.groupKey,
        enabled: enabled ? 1 : 0,
      });
      message.success(`已${enabled ? '启用' : '停用'} ${r.count} 条渠道`);
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const toggle = async (row: Channel, enabled: boolean) => {
    try {
      await api.post(`/api/channels/${row.id}/toggle`, { enabled: enabled ? 1 : 0 });
      message.success(enabled ? '已启用' : '已停用');
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const test = async (row: Channel) => {
    const hide = message.loading(`正在测试「${row.name}」...`, 0);
    try {
      const r = await api.post<{ ok: boolean; latencyMs: number; error?: string; models?: string[] }>(
        `/api/channels/${row.id}/test`,
      );
      hide();
      if (r.ok) {
        message.success(`「${row.name}」正常，延迟 ${r.latencyMs}ms${r.models ? `，发现 ${r.models.length} 个模型` : ''}`);
      } else {
        message.error(`「${row.name}」失败：${r.error}`);
      }
      void load();
    } catch (e: any) {
      hide();
      message.error(e.message);
    }
  };

  const fetchModels = async (row: Channel) => {
    try {
      const r = await api.post<{ models: string[] }>(`/api/channels/${row.id}/fetch-models`);
      setModelOptions((prev) => Array.from(new Set([...prev, ...r.models])));
      message.success(`已拉取 ${r.models.length} 个模型`);
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  /** 打开模型测试：优先用渠道配置的模型；通配/为空时先从上游拉取模型列表 */
  const openModelTest = async (row: Channel) => {
    setTestRow(row);
    setTestResults([]);
    setTestSummary(null);
    setOnlyFailed(false);
    const owned = Array.from(
      new Set<string>([...(row.models || []), ...Object.keys(row.modelMapping || {})]),
    ).filter((m) => m && m !== '*');
    setTestSelected(owned);
    setTestOpen(true);

    if (!owned.length) {
      try {
        const r = await api.post<{ models: string[] }>(`/api/channels/${row.id}/fetch-models`);
        setTestSelected(r.models || []);
        if (r.models?.length) message.success(`已从上游拉取 ${r.models.length} 个模型`);
        else message.warning('上游未返回模型列表，请手动输入模型名测试');
      } catch (e: any) {
        message.error(e.message);
      }
    }
  };

  const runModelTest = async () => {
    if (!testRow) return;
    if (!testSelected.length) {
      message.warning('请至少选择一个模型');
      return;
    }
    setTestRunning(true);
    setTestResults([]);
    setTestSummary(null);
    try {
      const r = await api.post<{
        total: number;
        ok: number;
        failed: number;
        capped: boolean;
        results: ModelProbe[];
      }>(`/api/channels/${testRow.id}/test-models`, { models: testSelected });
      setTestResults(r.results || []);
      setTestSummary({ total: r.total, ok: r.ok, failed: r.failed, capped: !!r.capped });
      message.success(`测试完成：${r.ok}/${r.total} 个模型可用${r.capped ? '（超过 300 个已截断）' : ''}`);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setTestRunning(false);
    }
  };

  /** 新建/编辑抽屉内：按填写的 BaseURL+Key 探测上游模型，填充下拉选项 */
  const probeModels = async () => {
    const v = form.getFieldsValue(['baseUrl', 'apiKey', 'provider']);
    if (!v.baseUrl) {
      message.warning('请先填写 Base URL');
      return;
    }
    setProbing(true);
    try {
      const firstKey = (v.apiKey || '')
        .split(/[\r\n,;，；]+/)
        .map((s: string) => s.trim())
        .filter(Boolean)[0] || '';
      const r = await api.post<{ models: string[] }>('/api/channels/probe-models', {
        baseUrl: v.baseUrl,
        apiKey: firstKey,
        provider: v.provider || 'openai-compatible',
      });
      setModelOptions(r.models);
      if (r.models.length) message.success(`已获取 ${r.models.length} 个模型，请在下方选择`);
      else message.warning('上游未返回模型列表（可能该接口需要 Key，或路径非标准 /v1/models）');
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setProbing(false);
    }
  };

  const batchImport = async () => {
    try {
      const r = await api.post<{ created: number; errors: string[] }>('/api/channels/batch', { text: batchText });
      message.success(`导入成功 ${r.created} 条${r.errors.length ? `，${r.errors.length} 行失败` : ''}`);
      setBatchOpen(false);
      setBatchText('');
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  const filtered = rows.filter(
    (r) =>
      !keyword ||
      r.name.toLowerCase().includes(keyword.toLowerCase()) ||
      r.baseUrl.toLowerCase().includes(keyword.toLowerCase()) ||
      (r.models || []).some((m) => m.toLowerCase().includes(keyword.toLowerCase())),
  );

  /** 按 group_key 折叠：组内成员作为 children，组行展示汇总 */
  const displayRows: Row[] = (() => {
    if (!groupView) return filtered.map((c) => ({ ...c, rowKey: String(c.id) }));
    const groups = new Map<string, Channel[]>();
    const singles: Channel[] = [];
    filtered.forEach((c) => {
      if (c.groupKey) {
        const list = groups.get(c.groupKey) || [];
        list.push(c);
        groups.set(c.groupKey, list);
      } else {
        singles.push(c);
      }
    });
    const out: Row[] = singles.map((c) => ({ ...c, rowKey: String(c.id) }));
    groups.forEach((members, gk) => {
      const sorted = [...members].sort((a, b) => (a.groupIndex ?? 0) - (b.groupIndex ?? 0));
      const first = sorted[0];
      const baseName = first.name.replace(new RegExp(`-${first.groupIndex ?? 1}$`), '') || first.name;
      out.push({
        ...first,
        rowKey: `group:${gk}`,
        isGroup: true,
        members: sorted,
        name: baseName,
        totalRequests: sorted.reduce((s, m) => s + m.totalRequests, 0),
        totalFailures: sorted.reduce((s, m) => s + m.totalFailures, 0),
        totalTokens: sorted.reduce((s, m) => s + m.totalTokens, 0),
        children: sorted.map((m) => ({ ...m, rowKey: String(m.id) })),
      });
    });
    return out;
  })();

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          渠道管理
        </Typography.Title>
        <Space>
          <Input.Search
            placeholder="搜索名称 / 地址 / 模型"
            allowClear
            style={{ width: 240 }}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Tooltip title="多 Key 拆分出的渠道会归为一组，折叠后只显示一行汇总">
            <Space size={4}>
              <Switch size="small" checked={groupView} onChange={setGroupView} />
              <Typography.Text type="secondary">按组折叠</Typography.Text>
            </Space>
          </Tooltip>
          <Button icon={<DownloadOutlined />} onClick={() => setBatchOpen(true)}>
            批量导入
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增渠道
          </Button>
        </Space>
      </div>

      <Card className="card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="rowKey"
          loading={loading}
          dataSource={displayRows}
          scroll={{ x: 1400 }}
          pagination={{ pageSize: 10, showSizeChanger: true, showTotal: (t) => `共 ${t} 个渠道` }}
          columns={[
            {
              title: '状态',
              dataIndex: 'status',
              width: 92,
              fixed: 'left',
              render: (s: string, r: Row) => {
                if (r.isGroup) {
                  const ms = r.members || [];
                  const ok = ms.filter((m) => m.enabled && !(m.cooldownUntil && m.cooldownUntil > Date.now())).length;
                  return (
                    <Tooltip title={`${ok} 条可用 / 共 ${ms.length} 条（展开可单独管理）`}>
                      <Tag color={ok ? 'success' : 'error'} bordered={false}>
                        {ok}/{ms.length} 可用
                      </Tag>
                    </Tooltip>
                  );
                }
                const m = STATUS_MAP[s] || STATUS_MAP.unknown;
                const tip = r.lastError ? `最近错误：${r.lastError}` : '';
                return (
                  <Tooltip title={tip}>
                    <Badge status={m.color as any} text={m.text} />
                    {r.disabledReason === 'auto' && (
                      <Tag color="orange" bordered={false} style={{ marginLeft: 4, fontSize: 10 }}>
                        自动
                      </Tag>
                    )}
                  </Tooltip>
                );
              },
            },
            {
              title: '名称',
              dataIndex: 'name',
              width: 160,
              fixed: 'left',
              ellipsis: true,
              render: (v: string, r: Row) =>
                r.isGroup ? (
                  <Space size={4}>
                    <span>{v}</span>
                    <Tag color="blue" bordered={false} style={{ fontSize: 10 }}>
                      {(r.members || []).length} Key
                    </Tag>
                  </Space>
                ) : (
                  v
                ),
            },
            {
              title: 'Base URL',
              dataIndex: 'baseUrl',
              width: 240,
              render: (v: string) => (
                <Typography.Text className="mono" ellipsis={{ tooltip: v }}>
                  {v}
                </Typography.Text>
              ),
            },
            {
              title: 'Key',
              dataIndex: 'apiKey',
              width: 130,
              render: (v: string, r: Row) => {
                if (r.isGroup) return <Tag color="blue">{(r.members || []).length} 个</Tag>;
                return r.hasKey ? <span className="mono">{v}</span> : <Tag>未设置</Tag>;
              },
            },
            {
              title: '模型',
              dataIndex: 'models',
              width: 220,
              render: (models: string[]) => (
                <Space size={4} wrap>
                  {(models || []).slice(0, 2).map((m) => (
                    <Tag key={m} bordered={false}>
                      {m}
                    </Tag>
                  ))}
                  {(models || []).length > 2 && (
                    <Tooltip title={(models || []).join(', ')}>
                      <Tag bordered={false}>+{models.length - 2}</Tag>
                    </Tooltip>
                  )}
                  {!models?.length && <Tag color="orange">未配置</Tag>}
                </Space>
              ),
            },
            { title: '优先级', dataIndex: 'priority', width: 80, align: 'center' },
            { title: '权重', dataIndex: 'weight', width: 70, align: 'center' },
            {
              title: '延迟',
              dataIndex: 'latencyMs',
              width: 90,
              align: 'right',
              render: (v: number | null, r: Row) => {
                if (r.isGroup) {
                  const list = (r.members || []).map((m) => m.latencyMs).filter((x): x is number => x != null);
                  if (!list.length) return '-';
                  return `${Math.round(list.reduce((s, x) => s + x, 0) / list.length)}ms`;
                }
                return v == null ? '-' : `${v}ms`;
              },
            },
            {
              title: '连续失败',
              dataIndex: 'failStreak',
              width: 90,
              align: 'center',
              render: (v: number, r: Row) => {
                if (r.isGroup) {
                  const sum = (r.members || []).reduce((s, m) => s + m.failStreak, 0);
                  return sum > 0 ? <Tag color="red">{sum}</Tag> : <span>0</span>;
                }
                return v > 0 ? <Tag color="red">{v}</Tag> : <span>0</span>;
              },
            },
            {
              title: '请求 / 失败',
              width: 110,
              align: 'right',
              render: (_: any, r: Row) => `${r.totalRequests} / ${r.totalFailures}`,
            },
            {
              title: '最近检测',
              dataIndex: 'lastCheckedAt',
              width: 150,
              render: (v: number | null, r: Channel) => (
                <Space size={4}>
                  <span>{v ? new Date(v).toLocaleString('zh-CN') : '从未'}</span>
                  {r.healthCheck === 0 && (
                    <Tooltip title="已关闭定时健康探测（不自动产生调用），仍正常参与负载均衡">
                      <Tag color="purple" bordered={false} style={{ fontSize: 10 }}>
                        免探测
                      </Tag>
                    </Tooltip>
                  )}
                </Space>
              ),
            },
            {
              title: '操作',
              width: 310,
              fixed: 'right',
              render: (_: any, r: Row) =>
                r.isGroup ? (
                  <Space size={4}>
                    <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditGroup(r)}>
                      改配置
                    </Button>
                    <Tooltip title="整组启用 / 停用">
                      <Switch
                        size="small"
                        checked={(r.members || []).some((m) => m.enabled)}
                        onChange={(c) => toggleGroup(r, c)}
                      />
                    </Tooltip>
                    <Popconfirm
                      title={`确认删除该组 ${(r.members || []).length} 条渠道？`}
                      onConfirm={async () => {
                        try {
                          const res = await api.post<{ count: number }>('/api/channels/group/delete', {
                            groupKey: r.groupKey,
                          });
                          message.success(`已删除 ${res.count} 条渠道`);
                          void load();
                        } catch (e: any) {
                          message.error(e.message);
                        }
                      }}
                    >
                      <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ) : (
                  <Space size={4}>
                    <Button size="small" type="link" icon={<ThunderboltOutlined />} onClick={() => test(r)}>
                      测试
                    </Button>
                    <Button size="small" type="link" icon={<ExperimentOutlined />} onClick={() => openModelTest(r)}>
                      模型测试
                    </Button>
                    <Button size="small" type="link" onClick={() => fetchModels(r)}>
                      拉模型
                    </Button>
                    <Switch size="small" checked={!!r.enabled} onChange={(c) => toggle(r, c)} />
                    <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(r)} />
                    <Popconfirm
                      title="确认删除该渠道？"
                      onConfirm={async () => {
                        try {
                          await api.del(`/api/channels/${r.id}`);
                          message.success('已删除');
                          void load();
                        } catch (e: any) {
                          message.error(e.message);
                        }
                      }}
                    >
                      <Button size="small" type="link" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </Space>
                ),
            },
          ]}
        />
      </Card>

      <Drawer
        title={editingGroup ? '编辑渠道组配置' : editing ? '编辑渠道' : '新增渠道'}
        width={520}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        extra={
          <Button type="primary" onClick={submit}>
            保存
          </Button>
        }
      >
        <Form form={form} layout="vertical">
          {editingGroup ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="组内所有渠道共享这里的配置（名称与 Key 各不相同，不在此修改）"
            />
          ) : (
            <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: '请输入名称' }]}>
              <Input placeholder="如：DeepSeek-主用" />
            </Form.Item>
          )}
          <Form.Item name="provider" label="厂商类型" rules={[{ required: true }]}>
            <Select options={PROVIDERS} />
          </Form.Item>
          <Form.Item
            name="baseUrl"
            label="Base URL"
            rules={[{ required: true, message: '请输入 Base URL' }]}
            extra="例如 https://api.deepseek.com/v1 ；不含 /vN 时会自动补 /v1"
          >
            <Input placeholder="https://api.deepseek.com/v1" />
          </Form.Item>
          {!editingGroup && (
            <Form.Item
              name="apiKey"
              label="API Key"
              extra={
                editing
                  ? '留空表示不修改已保存的 Key（列表中只显示掩码）'
                  : '支持填多个：一行一个，会自动拆成多条渠道（名称自动加 -1 / -2 / -3），请求在它们之间轮询'
              }
            >
              {editing ? (
                <Input.Password placeholder="sk-xxx" autoComplete="new-password" />
              ) : (
                <Input.TextArea rows={3} placeholder={'sk-xxx\nsk-yyy（可选，换行分隔多个 Key）'} />
              )}
            </Form.Item>
          )}
          <Form.Item
            name="models"
            label="支持的模型"
            extra={
              <Space size={4}>
                <Button size="small" type="link" loading={probing} onClick={probeModels} style={{ paddingLeft: 0 }}>
                  从上游获取模型
                </Button>
                <span style={{ color: '#999' }}>选择或输入后回车；填 * 表示通配所有模型</span>
              </Space>
            }
          >
            <Select
              mode="tags"
              placeholder={modelOptions.length ? '点选上方获取的模型，或手动输入' : '如 deepseek-chat'}
              options={modelOptions.map((m) => ({ label: m, value: m }))}
              tokenSeparators={[',', ' ', '，']}
              showSearch
            />
          </Form.Item>
          <Form.Item name="modelMappingText" label="模型别名映射" extra="每行一条，格式：对外名称=上游实际模型名">
            <Input.TextArea rows={3} placeholder={'gpt-4o=deepseek-v3\ngpt-4o-mini=deepseek-chat'} />
          </Form.Item>
          <Space size={16} wrap>
            <Form.Item name="priority" label="优先级（越小越优先）" style={{ marginBottom: 0 }}>
              <InputNumber min={0} max={9999} />
            </Form.Item>
            <Form.Item name="weight" label="权重" style={{ marginBottom: 0 }}>
              <InputNumber min={1} max={9999} />
            </Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked" style={{ marginBottom: 0 }}>
              <Switch />
            </Form.Item>
            <Form.Item
              name="healthCheck"
              label="定时健康探测"
              valuePropName="checked"
              tooltip="关闭后定时任务不再探测此渠道（不产生调用费用），渠道仍正常参与负载均衡与故障切换；可随时用「测试」按钮手动检测。收费模型建议关闭。"
              style={{ marginBottom: 0 }}
            >
              <Switch defaultChecked />
            </Form.Item>
          </Space>
        </Form>
      </Drawer>

      <Modal
        title="批量导入渠道"
        open={batchOpen}
        onCancel={() => setBatchOpen(false)}
        onOk={batchImport}
        width={680}
        okText="导入"
      >
        <Typography.Paragraph type="secondary">
          每行一条，用英文逗号分隔，至少 3 列：
          <Typography.Text code> 名称, BaseURL, APIKey, [模型(空格分隔)], [优先级], [权重], [厂商类型]</Typography.Text>
        </Typography.Paragraph>
        <Input.TextArea
          rows={10}
          value={batchText}
          onChange={(e) => setBatchText(e.target.value)}
          placeholder={'DeepSeek-主用, https://api.deepseek.com/v1, sk-xxx, deepseek-chat deepseek-reasoner, 10, 1\n硅基流动, https://api.siliconflow.cn/v1, sk-yyy, Qwen2.5-72B-Instruct, 20, 1'}
        />
      </Modal>

      <Modal
        title={`模型测试${testRow ? ` - ${testRow.name}` : ''}`}
        open={testOpen}
        onCancel={() => setTestOpen(false)}
        width={860}
        footer={[
          <Button key="close" onClick={() => setTestOpen(false)}>
            关闭
          </Button>,
          <Button
            key="run"
            type="primary"
            icon={<ExperimentOutlined />}
            loading={testRunning}
            onClick={runModelTest}
          >
            开始测试（{testSelected.length}）
          </Button>,
        ]}
        destroyOnClose
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="测试会对每个模型发起 1 次真实对话调用（max_tokens=16，上游有下限要求时自动换 64 重试）"
          description="免费模型无费用；收费模型会产生极少量 token 消耗，且个别厂商可能按请求计费，请酌情选择。测试结果不影响渠道熔断状态。"
        />

        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text>选择模型</Typography.Text>
            <Button size="small" onClick={() => setTestSelected(testAllModels)} disabled={testRunning}>
              全选
            </Button>
            <Button size="small" onClick={() => setTestSelected([])} disabled={testRunning}>
              清空
            </Button>
            {testSummary && (
              <Space size={4}>
                <Tag color="default">共 {testSummary.total}</Tag>
                <Tag color="success">可用 {testSummary.ok}</Tag>
                <Tag color={testSummary.failed ? 'error' : 'default'}>失败 {testSummary.failed}</Tag>
              </Space>
            )}
          </Space>

          <div
            style={{
              maxHeight: 260,
              overflowY: 'auto',
              border: '1px solid #f0f0f0',
              borderRadius: 8,
              padding: '4px 12px',
            }}
          >
            {testAllModels.length === 0 ? (
              <Typography.Text type="secondary">
                暂无模型，可在编辑渠道时从上游获取，或在下方手动输入模型名添加。
              </Typography.Text>
            ) : (
              testAllModels.map((m, idx) => (
                <div
                  key={m}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '7px 0',
                    borderBottom: idx < testAllModels.length - 1 ? '1px dashed #f0f0f0' : 'none',
                  }}
                >
                  <Checkbox
                    checked={testSelected.includes(m)}
                    disabled={testRunning}
                    onChange={(e) => toggleTestModel(m, e.target.checked)}
                  >
                    <Typography.Text style={{ wordBreak: 'break-all' }}>{m}</Typography.Text>
                  </Checkbox>
                  <Button
                    size="small"
                    type="text"
                    danger
                    icon={<DeleteOutlined />}
                    disabled={testRunning}
                    onClick={() => removeTestModel(m)}
                  />
                </div>
              ))
            )}
          </div>

          <Space.Compact style={{ width: '100%' }}>
            <Input
              placeholder="手动输入模型名后回车添加（不影响渠道已配置的模型）"
              value={testManual}
              disabled={testRunning}
              onChange={(e) => setTestManual(e.target.value)}
              onPressEnter={(e) => addTestModel((e.target as HTMLInputElement).value)}
            />
            <Button type="default" disabled={testRunning} onClick={() => addTestModel(testManual)}>
              添加
            </Button>
          </Space.Compact>

          {testResults.length > 0 && (
            <>
              <Space>
                <Switch
                  size="small"
                  checked={onlyFailed}
                  onChange={setOnlyFailed}
                  disabled={testRunning}
                />
                <Typography.Text type="secondary">只看失败</Typography.Text>
              </Space>
              <Table
                rowKey="model"
                size="small"
                dataSource={onlyFailed ? testResults.filter((r) => !r.ok) : testResults}
                pagination={{ pageSize: 10, size: 'small' }}
                scroll={{ x: 640 }}
                columns={[
                  { title: '模型', dataIndex: 'model', width: 260, ellipsis: true },
                  {
                    title: '上游实际名',
                    dataIndex: 'actualModel',
                    width: 220,
                    ellipsis: true,
                    render: (v: string, r: ModelProbe) =>
                      v === r.model ? <Typography.Text type="secondary">同左</Typography.Text> : v,
                  },
                  {
                    title: '结果',
                    dataIndex: 'ok',
                    width: 90,
                    render: (v: boolean) =>
                      v ? <Tag color="success">可用</Tag> : <Tag color="error">不可用</Tag>,
                  },
                  {
                    title: '延迟',
                    dataIndex: 'latencyMs',
                    width: 90,
                    align: 'right',
                    render: (v: number) => `${v}ms`,
                  },
                  {
                    title: '说明',
                    dataIndex: 'error',
                    render: (v: string | null, r: ModelProbe) =>
                      v ? (
                        <Typography.Text type="danger" ellipsis={{ tooltip: v }}>
                          {v}
                        </Typography.Text>
                      ) : r.httpStatus ? (
                        `HTTP ${r.httpStatus}`
                      ) : (
                        '-'
                      ),
                  },
                ]}
              />
            </>
          )}
        </Space>
      </Modal>
    </div>
  );
}
