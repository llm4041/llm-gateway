import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Card, Col, Empty, Row, Space, Statistic, Table, Tag, Typography } from 'antd';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import ReactECharts from 'echarts-for-react';
import { api } from '../api/client';

type Overview = {
  channels: { total: number; enabled: number; healthy: number; failing: number; disabled: number; unknown: number };
  today: { requests: number; success: number; failed: number; successRate: number; avgLatency: number; tokens: number };
  trend: Array<{ hour: number; requests: number; success: number }>;
  byChannel: Array<{ channelId: number; channelName: string; requests: number; success: number; avgLatency: number }>;
  byModel: Array<{
    publicModel: string;
    requests: number;
    success: number;
    avgLatency: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  }>;
  recentErrors: Array<{ id: number; ts: number; publicModel: string; channelName: string; httpStatus: number; errorMsg: string }>;
};

export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const navigate = useNavigate();
  const { message } = App.useApp();

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.get<Overview>('/api/stats/overview'));
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

  const runHealth = async () => {
    setRunning(true);
    try {
      const res = await api.post<{ results: Array<{ ok: boolean; name: string }> }>('/api/health/run');
      const failed = res.results.filter((r) => !r.ok);
      message.success(`体检完成：${res.results.length - failed.length} 正常 / ${failed.length} 异常`);
      void load();
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setRunning(false);
    }
  };

  const hours = Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
  const reqMap = new Map(data?.trend.map((t) => [t.hour, t.requests]) || []);
  const okMap = new Map(data?.trend.map((t) => [t.hour, t.success]) || []);

  const chartOption = {
    grid: { left: 40, right: 16, top: 30, bottom: 30 },
    tooltip: { trigger: 'axis' },
    legend: { data: ['请求数', '成功数'], right: 0, top: 0 },
    xAxis: { type: 'category', data: hours, axisLine: { lineStyle: { color: '#e5e7eb' } } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: '#f1f2f6' } } },
    series: [
      {
        name: '请求数',
        type: 'line',
        smooth: true,
        data: hours.map((_, i) => reqMap.get(i) || 0),
        itemStyle: { color: '#4f46e5' },
        areaStyle: { color: 'rgba(79,70,229,.10)' },
      },
      {
        name: '成功数',
        type: 'line',
        smooth: true,
        data: hours.map((_, i) => okMap.get(i) || 0),
        itemStyle: { color: '#10b981' },
        areaStyle: { color: 'rgba(16,185,129,.10)' },
      },
    ],
  };

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          仪表盘
        </Typography.Title>
        <Space>
          <Button icon={<ThunderboltOutlined />} loading={running} onClick={runHealth}>
            立即体检
          </Button>
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>
            刷新
          </Button>
        </Space>
      </div>

      <Row gutter={[16, 16]}>
        {[
          { title: '今日请求', value: data?.today.requests ?? 0, suffix: '次' },
          { title: '成功率', value: data?.today.successRate ?? 100, suffix: '%', precision: 1 },
          { title: '平均延迟', value: data?.today.avgLatency ?? 0, suffix: 'ms' },
          { title: '今日 Token', value: data?.today.tokens ?? 0, suffix: '' },
        ].map((it) => (
          <Col span={6} key={it.title}>
            <Card className="card">
              <Statistic title={it.title} value={it.value} suffix={it.suffix} precision={(it as any).precision ?? 0} />
            </Card>
          </Col>
        ))}
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={16}>
          <Card className="card" title="近 24 小时请求趋势">
            <ReactECharts option={chartOption} style={{ height: 280 }} notMerge />
          </Card>
        </Col>
        <Col span={8}>
          <Card className="card" title="渠道健康概览">
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              {[
                { label: '健康', value: data?.channels.healthy ?? 0, color: 'success' },
                { label: '异常', value: data?.channels.failing ?? 0, color: 'error' },
                { label: '已停用', value: data?.channels.disabled ?? 0, color: 'default' },
                { label: '未检测', value: data?.channels.unknown ?? 0, color: 'warning' },
              ].map((it) => (
                <div key={it.label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Space>
                    <Tag color={it.color as any} bordered={false}>
                      {it.label}
                    </Tag>
                  </Space>
                  <Typography.Text strong>{it.value}</Typography.Text>
                </div>
              ))}
              <Button block onClick={() => navigate('/channels')}>
                前往渠道管理
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card className="card" title="模型调用排行（24h，按 Token 用量排序）">
            <Table
              size="small"
              rowKey="publicModel"
              pagination={false}
              dataSource={data?.byModel || []}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              columns={[
                { title: '模型', dataIndex: 'publicModel', ellipsis: true },
                { title: '请求', dataIndex: 'requests', width: 80 },
                {
                  title: '成功率',
                  width: 100,
                  render: (_: any, r: any) => `${r.requests ? Math.round((r.success / r.requests) * 100) : 100}%`,
                },
                {
                  title: '平均延迟',
                  dataIndex: 'avgLatency',
                  width: 100,
                  render: (v: number) => `${Math.round(v || 0)}ms`,
                },
                {
                  title: '输入 Token (↑)',
                  dataIndex: 'promptTokens',
                  width: 130,
                  align: 'right' as const,
                  render: (v: number) => Number(v || 0).toLocaleString(),
                },
                {
                  title: '输出 Token (↓)',
                  dataIndex: 'completionTokens',
                  width: 130,
                  align: 'right' as const,
                  render: (v: number) => Number(v || 0).toLocaleString(),
                },
                {
                  title: '总 Token (≈)',
                  dataIndex: 'totalTokens',
                  width: 130,
                  align: 'right' as const,
                  render: (v: number) => <Typography.Text strong>{Number(v || 0).toLocaleString()}</Typography.Text>,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={12}>
          <Card className="card" title="渠道调用排行（24h）">
            <Table
              size="small"
              rowKey="channelId"
              pagination={false}
              dataSource={data?.byChannel || []}
              locale={{ emptyText: <Empty description="暂无数据" /> }}
              columns={[
                { title: '渠道', dataIndex: 'channelName' },
                { title: '请求', dataIndex: 'requests', width: 80 },
                {
                  title: '成功率',
                  width: 100,
                  render: (_: any, r: any) => `${r.requests ? Math.round((r.success / r.requests) * 100) : 100}%`,
                },
                {
                  title: '平均延迟',
                  dataIndex: 'avgLatency',
                  width: 100,
                  render: (v: number) => `${Math.round(v || 0)}ms`,
                },
              ]}
            />
          </Card>
        </Col>
        <Col span={12}>
          <Card className="card" title="最近失败请求">
            <Table
              size="small"
              rowKey="id"
              pagination={false}
              dataSource={data?.recentErrors || []}
              locale={{ emptyText: <Empty description="暂无失败请求" /> }}
              columns={[
                { title: '时间', dataIndex: 'ts', width: 100, render: (v: number) => new Date(v).toLocaleTimeString('zh-CN') },
                { title: '模型', dataIndex: 'publicModel', width: 140, ellipsis: true },
                { title: '渠道', dataIndex: 'channelName', width: 120, ellipsis: true },
                {
                  title: '错误',
                  dataIndex: 'errorMsg',
                  ellipsis: true,
                  render: (v: string) => <Typography.Text type="danger" ellipsis={{ tooltip: v }}>{v || '-'}</Typography.Text>,
                },
              ]}
            />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
