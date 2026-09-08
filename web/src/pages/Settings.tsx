import { useEffect, useState } from 'react';
import { App, Button, Card, Col, Divider, Form, InputNumber, Row, Select, Space, Switch, Typography } from 'antd';
import { api } from '../api/client';

type Settings = {
  healthCheckIntervalSec: number;
  healthCheckTimeoutMs: number;
  healthCheckConcurrency: number;
  healthProbeMode: 'models' | 'chat';
  healthProbeModel: string;
  maxRetry: number;
  requestTimeoutMs: number;
  failThreshold: number;
  recoverThreshold: number;
  cooldownBaseSec: number;
  cooldownMaxSec: number;
  logRetentionDays: number;
  autoDisable: number;
};

export default function Settings() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const { message } = App.useApp();

  useEffect(() => {
    setLoading(true);
    api
      .get<Settings>('/api/settings')
      .then((d) => form.setFieldsValue(d))
      .catch((e) => message.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await api.put('/api/settings', v);
      message.success('设置已保存，调度器已按新配置重启');
    } catch (e: any) {
      message.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const num = (name: string, label: string, extra: string, min = 1, max = 999999) => (
    <Col span={8} key={name}>
      <Form.Item name={name} label={label} extra={extra}>
        <InputNumber min={min} max={max} style={{ width: '100%' }} />
      </Form.Item>
    </Col>
  );

  return (
    <div>
      <div className="page-title">
        <Typography.Title level={4} style={{ margin: 0 }}>
          系统设置
        </Typography.Title>
        <Button type="primary" loading={saving} onClick={save}>
          保存设置
        </Button>
      </div>

      <Form form={form} layout="vertical" disabled={loading}>
        <Card className="card" title="健康检查" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            {num('healthCheckIntervalSec', '检查间隔（秒）', '定时体检的执行频率', 30)}
            {num('healthCheckTimeoutMs', '探测超时（毫秒）', '单次探测超过该时间视为失败', 1000, 600000)}
            {num('healthCheckConcurrency', '并发探测数', '同时对多少个渠道发起体检', 1, 200)}
            <Col span={8}>
              <Form.Item name="healthProbeMode" label="探测方式" extra="models=只查模型列表不花钱；chat=真实请求 1 个 token">
                <Select
                  options={[
                    { value: 'models', label: '轻量：GET /v1/models' },
                    { value: 'chat', label: '真实：最小 chat 请求' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="healthProbeModel" label="真实探测使用的模型" extra="仅在探测方式为 chat 时生效，留空则取该渠道第一个模型">
                <Select
                  allowClear
                  showSearch
                  mode="tags"
                  tokenSeparators={[',']}
                  placeholder="留空 = 自动取第一个模型"
                />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card className="card" title="熔断与恢复" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            {num('failThreshold', '连续失败阈值', '达到该次数后自动停用渠道', 1, 100)}
            {num('recoverThreshold', '连续成功恢复阈值', '停用的渠道连续成功多少次后自动启用', 1, 100)}
            {num('cooldownBaseSec', '冷却基础时长（秒）', '首次自动停用的冷却时间', 10)}
            {num('cooldownMaxSec', '冷却最大时长（秒）', '指数退避的上限', 10)}
            <Col span={8}>
              <Form.Item name="autoDisable" label="启用自动停用" valuePropName="checked" extra="关闭后仅记录异常，不自动停用渠道">
                <Switch checkedChildren="开" unCheckedChildren="关" />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card className="card" title="转发" style={{ marginBottom: 16 }}>
          <Row gutter={16}>
            {num('maxRetry', '最大切换次数', '一次请求最多尝试多少个渠道', 0, 20)}
            {num('requestTimeoutMs', '请求超时（毫秒）', '转发到上游的超时时间', 1000, 900000)}
            {num('logRetentionDays', '日志保留天数', '超期日志会被自动清理', 1, 365)}
          </Row>
        </Card>
      </Form>

      <Divider />
      <Space>
        <Button
          danger
          onClick={async () => {
            await api.post('/api/logs/cleanup');
            message.success('已按保留策略清理日志');
          }}
        >
          立即清理过期日志
        </Button>
      </Space>
    </div>
  );
}
