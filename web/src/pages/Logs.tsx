import { useEffect, useState } from 'react';
import { Alert, App, Button, Card, DatePicker, Drawer, Empty, Input, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../api/client';

type LogRow = {
  id: number;
  ts: number;
  requestId: string;
  keyName: string | null;
  publicModel: string;
  channelName: string | null;
  actualModel: string | null;
  stream: number;
  httpStatus: number | null;
  ok: number;
  errorType: string | null;
  errorMsg: string | null;
  latencyMs: number | null;
  firstTokenMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  estimated: number;
  retryCount: number;
  failoverChain: Array<{ channelId: number; channelName: string; error: string; at: number }>;
  detail: {
    requestBody: string | null;
    responseBody: string | null;
    reqTruncated: boolean;
    resTruncated: boolean;
  } | null;
};

/** JSON 报文美化，非 JSON（如流式拼接文本）原样输出 */
function prettyBody(text: string | null): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function BodyBlock({ label, text, truncated }: { label: string; text: string | null; truncated?: boolean }) {
  const { message } = App.useApp();
  const empty = !text;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text || '');
      message.success('已复制');
    } catch {
      message.warning('浏览器拒绝了剪贴板访问，请手动选择复制');
    }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Text strong>{label}</Typography.Text>
        <Button size="small" type="link" icon={<CopyOutlined />} disabled={empty} onClick={copy}>
          复制
        </Button>
      </div>
      {truncated ? (
        <Alert type="warning" showIcon message="内容超出系统设置的上限，已被截断" style={{ marginBottom: 8 }} />
      ) : null}
      {empty ? (
        <Typography.Paragraph type="secondary" style={{ margin: 0 }}>
          未记录该报文。可能是记录明细前产生的日志，或已在系统设置中关闭该功能。
        </Typography.Paragraph>
      ) : (
        <pre
          className="mono"
          style={{
            background: '#fafafa',
            padding: 12,
            borderRadius: 8,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            maxHeight: 420,
            overflow: 'auto',
            margin: 0,
          }}
        >
          {prettyBody(text)}
        </pre>
      )}
    </div>
  );
}

export default function Logs() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState<string>('all');
  const [model, setModel] = useState<string>('');
  const [detail, setDetail] = useState<LogRow | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const { message } = App.useApp();

  const openDetail = async (row: LogRow) => {
    setDetail(row);
    setDetailLoading(true);
    try {
      setDetail(await api.get<LogRow>(`/api/logs/${row.id}`));
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setDetailLoading(false);
    }
  };

  const load = async (p = page, ps = pageSize) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(p), pageSize: String(ps) });
      if (ok !== 'all') params.append('ok', ok);
      if (model) params.append('model', model);
      const r = await api.get<{ items: LogRow[]; total: number }>(`/api/logs?${params.toString()}`);
      setRows(r.items || []);
      setTotal(r.total || 0);
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, model]);

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          请求日志
        </Typography.Title>
        <Space>
          <Input.Search placeholder="按模型筛选" allowClear style={{ width: 200 }} onSearch={(v) => setModel(v)} />
          <Select
            value={ok}
            style={{ width: 120 }}
            onChange={setOk}
            options={[
              { value: 'all', label: '全部' },
              { value: '1', label: '成功' },
              { value: '0', label: '失败' },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={() => load(1)}>
            刷新
          </Button>
          <Popconfirm
            title="确认清空全部日志？"
            onConfirm={async () => {
              await api.del('/api/logs');
              message.success('已清空');
              void load(1);
            }}
          >
            <Button danger>清空</Button>
          </Popconfirm>
        </Space>
      </div>

      <Card className="card" styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          loading={loading}
          dataSource={rows}
          scroll={{ x: 1200 }}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            pageSizeOptions: [10, 20, 50, 100, 200],
            showTotal: (t, range) => `${range[0]}-${range[1]} / 共 ${t} 条`,
            onChange: (p, ps) => {
              // 切换每页条数时回到第一页，避免停在一个已越界的页码上
              const sizeChanged = ps !== pageSize;
              const nextPage = sizeChanged ? 1 : p;
              setPage(nextPage);
              setPageSize(ps);
              void load(nextPage, ps);
            },
          }}
          locale={{ emptyText: <Empty description="暂无请求日志" /> }}
          columns={[
            {
              title: '时间',
              dataIndex: 'ts',
              width: 170,
              render: (v: number) => dayjs(v).format('YYYY-MM-DD HH:mm:ss'),
            },
            {
              title: '结果',
              dataIndex: 'ok',
              width: 76,
              render: (v: number) => (v ? <Tag color="success">成功</Tag> : <Tag color="error">失败</Tag>),
            },
            { title: '模型', dataIndex: 'publicModel', width: 160, ellipsis: true },
            { title: '命中渠道', dataIndex: 'channelName', width: 140, ellipsis: true },
            {
              title: '切换次数',
              dataIndex: 'retryCount',
              width: 90,
              align: 'center',
              render: (v: number) => (v > 0 ? <Tag color="orange">{v}</Tag> : <span>0</span>),
            },
            {
              title: '延迟',
              dataIndex: 'latencyMs',
              width: 90,
              align: 'right',
              render: (v: number | null) => (v == null ? '-' : `${v}ms`),
            },
            {
              title: '首字延迟',
              dataIndex: 'firstTokenMs',
              width: 100,
              align: 'right',
              render: (v: number | null) => (v == null ? '-' : `${v}ms`),
            },
            {
              title: 'Tokens',
              width: 120,
              align: 'right',
              render: (_: any, r: LogRow) => (
                <span>
                  {r.totalTokens ?? '-'}
                  {r.estimated ? <Tag color="default" style={{ marginLeft: 4, fontSize: 10 }}>估算</Tag> : null}
                </span>
              ),
            },
            {
              title: '流式',
              dataIndex: 'stream',
              width: 70,
              render: (v: number) => (v ? <Tag bordered={false}>流式</Tag> : <Tag bordered={false}>同步</Tag>),
            },
            {
              title: '错误',
              dataIndex: 'errorMsg',
              ellipsis: true,
              render: (v: string | null) =>
                v ? (
                  <Typography.Text type="danger" ellipsis={{ tooltip: v }}>
                    {v}
                  </Typography.Text>
                ) : (
                  '-'
                ),
            },
            {
              title: '操作',
              width: 80,
              fixed: 'right',
              render: (_: any, r: LogRow) => (
                <Button size="small" type="link" onClick={() => openDetail(r)}>
                  详情
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Drawer title="请求详情" width={760} open={!!detail} onClose={() => setDetail(null)}>
        {detail && (
          <Tabs
            defaultActiveKey="overview"
            items={[
              {
                key: 'overview',
                label: '概览',
                children: (
                  <Spin spinning={detailLoading}>
                    <Space direction="vertical" style={{ width: '100%' }} size={12}>
                      <Typography.Text type="secondary">请求 ID：{detail.requestId}</Typography.Text>
                      <div>
                        <Typography.Text strong>故障切换链路</Typography.Text>
                        {detail.failoverChain?.length ? (
                          <div style={{ marginTop: 8 }}>
                            {detail.failoverChain.map((f, i) => (
                              <div key={i} style={{ marginBottom: 8, padding: 8, background: '#fafafa', borderRadius: 6 }}>
                                <Tag color="orange">第 {i + 1} 次</Tag>
                                <Typography.Text strong>{f.channelName}</Typography.Text>
                                <div className="mono" style={{ color: '#b91c1c', marginTop: 4 }}>
                                  {f.error}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
                            首次调用即成功，无切换
                          </Typography.Paragraph>
                        )}
                      </div>
                      <pre className="mono" style={{ background: '#fafafa', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap' }}>
                        {JSON.stringify(
                          {
                            ts: new Date(detail.ts).toLocaleString('zh-CN'),
                            key: detail.keyName,
                            publicModel: detail.publicModel,
                            actualModel: detail.actualModel,
                            channel: detail.channelName,
                            httpStatus: detail.httpStatus,
                            errorType: detail.errorType,
                            errorMsg: detail.errorMsg,
                            latencyMs: detail.latencyMs,
                            firstTokenMs: detail.firstTokenMs,
                            tokens: {
                              prompt: detail.promptTokens,
                              completion: detail.completionTokens,
                              total: detail.totalTokens,
                              estimated: !!detail.estimated,
                            },
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </Space>
                  </Spin>
                ),
              },
              {
                key: 'request',
                label: '请求报文',
                children: (
                  <BodyBlock label="发送给上游的请求体" text={detail.detail?.requestBody ?? null} truncated={detail.detail?.reqTruncated} />
                ),
              },
              {
                key: 'response',
                label: '响应报文',
                children: (
                  <BodyBlock label={detail.stream ? '流式拼接后的回复内容' : '上游返回的原始响应'} text={detail.detail?.responseBody ?? null} truncated={detail.detail?.resTruncated} />
                ),
              },
            ]}
          />
        )}
      </Drawer>
    </div>
  );
}
