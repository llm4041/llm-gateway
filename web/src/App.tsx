import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Button, Layout, Menu, Popconfirm, Space, Tag, Typography } from 'antd';
import {
  DashboardOutlined,
  ApiOutlined,
  NodeIndexOutlined,
  KeyOutlined,
  FileTextOutlined,
  SettingOutlined,
  LogoutOutlined,
  MessageOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { clearToken } from './api/client';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Channels from './pages/Channels';
import ModelRoutes from './pages/ModelRoutes';
import Keys from './pages/Keys';
import Logs from './pages/Logs';
import Settings from './pages/Settings';
import Chat from './pages/Chat';

const { Header, Sider, Content } = Layout;

const MENU = [
  { key: '/', icon: <DashboardOutlined />, label: '仪表盘' },
  { key: '/channels', icon: <ApiOutlined />, label: '渠道管理' },
  { key: '/chat', icon: <MessageOutlined />, label: '对话测试' },
  { key: '/routes', icon: <NodeIndexOutlined />, label: '模型路由' },
  { key: '/keys', icon: <KeyOutlined />, label: '网关密钥' },
  { key: '/logs', icon: <FileTextOutlined />, label: '请求日志' },
  { key: '/settings', icon: <SettingOutlined />, label: '系统设置' },
];

function Shell() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider width={216} theme="light" style={{ borderRight: '1px solid #eef0f4' }}>
        <div className="brand">
          <ThunderboltFilled style={{ color: '#4f46e5', fontSize: 20 }} />
          <span>LLM 网关</span>
        </div>
        <Menu
          mode="inline"
          selectedKeys={[location.pathname]}
          items={MENU}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: 'none' }}
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Space size={12}>
            <Typography.Text type="secondary">多渠道聚合 · 健康检查 · 故障无感切换</Typography.Text>
          </Space>
          <Space size={12}>
            <Tag color="blue" bordered={false}>
              admin
            </Tag>
            <Avatar size={30} style={{ background: '#4f46e5' }}>
              A
            </Avatar>
            <Popconfirm
              title="确认退出登录？"
              onConfirm={() => {
                clearToken();
                navigate('/login');
              }}
            >
              <Button type="text" icon={<LogoutOutlined />} />
            </Popconfirm>
          </Space>
        </Header>
        <Content style={{ padding: 24 }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/chat" element={<Chat />} />
            <Route path="/routes" element={<ModelRoutes />} />
            <Route path="/keys" element={<Keys />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  );
}

export default function App() {
  const location = useLocation();
  const authed = !!localStorage.getItem('gw_admin_token');

  if (!authed) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  if (location.pathname === '/login') return <Navigate to="/" replace />;
  return <Shell />;
}
