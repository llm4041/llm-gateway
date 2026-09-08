import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Card, Form, Input, Typography } from 'antd';
import { ThunderboltFilled, LockOutlined, UserOutlined } from '@ant-design/icons';
import { api, setToken } from '../api/client';

export default function Login() {
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { message } = App.useApp();

  const onFinish = async (values: { username: string; password: string }) => {
    setLoading(true);
    try {
      const res = await api.post<{ token: string }>('/api/auth/login', values);
      setToken(res.token);
      message.success('登录成功');
      navigate('/', { replace: true });
    } catch (e: any) {
      message.error(e.message || '登录失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(135deg,#eef2ff 0%,#f8fafc 100%)' }}>
      <Card style={{ width: 380, borderRadius: 14, boxShadow: '0 8px 32px rgba(16,24,40,.08)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <ThunderboltFilled style={{ fontSize: 34, color: '#4f46e5' }} />
          <Typography.Title level={4} style={{ margin: '10px 0 4px' }}>
            LLM 网关控制台
          </Typography.Title>
          <Typography.Text type="secondary">多渠道聚合 · 健康检查 · 故障切换</Typography.Text>
        </div>
        <Form layout="vertical" onFinish={onFinish} initialValues={{ username: 'admin', password: 'admin123' }}>
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input prefix={<UserOutlined />} size="large" placeholder="admin" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password prefix={<LockOutlined />} size="large" placeholder="admin123" />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="large" block loading={loading}>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
