import { useEffect, useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { CopyOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from '../api/client';

type KeyRow = {
  id: number;
  name: string;
  keyPrefix: string;
  allowedModels: string[];
  rpmLimit: number;
  enabled: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  totalRequests: number;
};

/**
 * 明文密钥只在创建时返回一次（服务端仅存 hash）。
 * 本浏览器把创建/重新生成得到的明文缓存到 localStorage，
 * 之后列表里可直接复制；换浏览器或清缓存后只能「重新生成」。
 */
const PLAIN_KEY = 'gw_key_plains';

function loadPlains(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(PLAIN_KEY) || '{}');
  } catch {
    return {};
  }
}

function savePlain(id: number, plain: string): void {
  const p = loadPlains();
  p[String(id)] = plain;
  localStorage.setItem(PLAIN_KEY, JSON.stringify(p));
}

export default function Keys() {
  const [rows, setRows] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [allModels, setAllModels] = useState<string[]>([]);
  const [form] = Form.useForm();
  const { message } = App.useApp();

  const load = async () => {
    setLoading(true);
    try {
      setRows(await api.get<KeyRow[]>('/api/keys'));
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    api
      .get<Array<{ model: string }>>('/api/models/available')
      .then((d) => setAllModels(d.map((m) => m.model)))
      .catch(() => undefined);
  }, []);

  const submit = async () => {
    const v = await form.validateFields();
    try {
      const r = await api.post<{ id: number; key: string }>('/api/keys', {
        name: v.name,
        allowedModels: v.allowedModels || [],
        rpmLimit: v.rpmLimit || 0,
      });
      savePlain(r.id, r.key);
      setCreatedKey(r.key);
      message.success('创建成功');
      setOpen(false);
      form.resetFields();
      void load();
    } catch (e: any) {
      message.error(e.message);
    }
  };

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          网关密钥
        </Typography.Title>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              form.resetFields();
              setOpen(true);
            }}
          >
            新建密钥
          </Button>
        </Space>
      </div>

      <Typography.Paragraph type="secondary">
        客户端调用 <Typography.Text code>/v1/chat/completions</Typography.Text> 时需在 Header 带上{' '}
        <Typography.Text code>Authorization: Bearer &lt;密钥&gt;</Typography.Text>
      </Typography.Paragraph>

      <Card className="card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: '名称', dataIndex: 'name', width: 160 },
            {
              title: '密钥',
              dataIndex: 'keyPrefix',
              width: 220,
              render: (v: string, r: KeyRow) => {
                const plain = loadPlains()[String(r.id)];
                return (
                  <Space size={4}>
                    <span className="mono">{v}••••••••</span>
                    {plain ? (
                      <Button
                        size="small"
                        type="link"
                        icon={<CopyOutlined />}
                        onClick={() => {
                          navigator.clipboard?.writeText(plain);
                          message.success('已复制完整密钥');
                        }}
                      >
                        复制
                      </Button>
                    ) : (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        （本机无明文）
                      </Typography.Text>
                    )}
                  </Space>
                );
              },
            },
            {
              title: '允许模型',
              dataIndex: 'allowedModels',
              render: (m: string[]) =>
                (m || []).length ? (
                  <Space size={4} wrap>
                    {m.slice(0, 3).map((x) => (
                      <Tag key={x} bordered={false}>
                        {x}
                      </Tag>
                    ))}
                    {m.length > 3 && <Tag bordered={false}>+{m.length - 3}</Tag>}
                  </Space>
                ) : (
                  <Tag color="green" bordered={false}>
                    全部
                  </Tag>
                ),
            },
            {
              title: '限流',
              dataIndex: 'rpmLimit',
              width: 110,
              render: (v: number) => (v > 0 ? `${v} 次/分` : '不限'),
            },
            { title: '调用次数', dataIndex: 'totalRequests', width: 100, align: 'right' },
            {
              title: '最近使用',
              dataIndex: 'lastUsedAt',
              width: 170,
              render: (v: number | null) => (v ? new Date(v).toLocaleString('zh-CN') : '从未'),
            },
            {
              title: '状态',
              width: 90,
              render: (_: any, r: KeyRow) => (
                <Switch
                  size="small"
                  checked={!!r.enabled}
                  onChange={async (c) => {
                    await api.put(`/api/keys/${r.id}`, { enabled: c ? 1 : 0 });
                    void load();
                  }}
                />
              ),
            },
            {
              title: '操作',
              width: 150,
              render: (_: any, r: KeyRow) => (
                <Space size={0}>
                  <Popconfirm
                    title="重新生成明文密钥？"
                    description="旧密钥将立即失效，需更新到调用方。"
                    onConfirm={async () => {
                      try {
                        const res = await api.post<{ id: number; key: string }>(`/api/keys/${r.id}/regenerate`);
                        savePlain(r.id, res.key);
                        setCreatedKey(res.key);
                        message.success('已重新生成，旧密钥已失效');
                        void load();
                      } catch (e: any) {
                        message.error(e.message);
                      }
                    }}
                  >
                    <Button size="small" type="link">
                      重新生成
                    </Button>
                  </Popconfirm>
                  <Popconfirm
                    title="确认删除该密钥？"
                    onConfirm={async () => {
                      await api.del(`/api/keys/${r.id}`);
                      const p = loadPlains();
                      delete p[String(r.id)];
                      localStorage.setItem(PLAIN_KEY, JSON.stringify(p));
                      message.success('已删除');
                      void load();
                    }}
                  >
                    <Button size="small" type="link" danger>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        title="新建网关密钥"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={submit}
        okText="创建"
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ rpmLimit: 0, allowedModels: [] }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="如：本机 Claude Code" />
          </Form.Item>
          <Form.Item name="allowedModels" label="允许访问的模型" extra="留空表示不限制">
            <Select mode="tags" placeholder="留空 = 允许全部" options={allModels.map((m) => ({ value: m, label: m }))} />
          </Form.Item>
          <Form.Item name="rpmLimit" label="速率限制（次/分钟）" extra="0 表示不限">
            <InputNumber min={0} max={100000} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="密钥已创建"
        open={!!createdKey}
        onCancel={() => setCreatedKey(null)}
        footer={[
          <Button key="close" onClick={() => setCreatedKey(null)}>
            我已保存
          </Button>,
        ]}
      >
        <Typography.Paragraph type="warning">
          明文密钥<b>仅此一次</b>展示，关闭后无法再次查看，请立即复制保存。
        </Typography.Paragraph>
        <Input.TextArea readOnly value={createdKey || ''} rows={3} className="mono" />
        <Button
          style={{ marginTop: 12 }}
          icon={<CopyOutlined />}
          onClick={() => {
            navigator.clipboard?.writeText(createdKey || '');
            message.success('已复制');
          }}
        >
          复制
        </Button>
      </Modal>
    </div>
  );
}
