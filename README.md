# LLM Gateway

LLM API 负载均衡网关：把多个厂商的大模型 API 聚合到统一的 OpenAI 兼容接口，自带 Web 管理台。

- **多渠道聚合**：录入各厂商的 Base URL + API Key，一个网关暴露所有模型
- **模型可用性测试**：渠道管理里批量测试该渠道下的全部（或指定）模型，逐条返回可用/不可用、延迟与失败原因（真实 1-token 调用，不影响熔断状态）
- **定时健康检查**：自动探测渠道可用性，连续失败自动停用并指数退避冷却，连续成功自动恢复
- **故障无感切换**：同一模型多渠道按优先级依次重试，首字节前对客户端完全透明
- **模型级降级链**：某模型所有渠道都失败时，可配置自动降级到备用模型重试
- **流式支持**：SSE 流式透传（含 reasoning 思考内容），首字节后不静默切换
- **网关密钥**：对外发 Key（哈希存储、限流、模型白名单、有效期）
- **调用统计**：仪表盘按渠道 / 模型维度统计请求、成功率、延迟与 Token 用量
- **对话测试**：内置对话页直接测试任意模型，免创建网关密钥

技术栈：Node.js 22 + TypeScript + Fastify + SQLite（`node:sqlite`，零原生编译）；前端 React 18 + Vite + Ant Design 5。

---

## 快速开始

### 方式一：Docker 部署（推荐）

```bash
docker compose up -d --build
```

打开 `http://localhost:3000`，默认账号 `admin / admin123`（**生产环境务必通过环境变量修改**，见下文配置表）。

数据（SQLite 数据库、主加密密钥）持久化在 Docker 卷 `llm-gateway-data`（容器内 `/app/data`），升级镜像不丢数据。

指定管理员密码与 JWT 密钥启动：

```bash
ADMIN_PASSWORD=your-password JWT_SECRET=$(openssl rand -hex 32) docker compose up -d --build
```

不用 compose 时：

```bash
docker build -t llm-gateway .
docker run -d --name llm-gateway -p 3000:3000 \
  -e ADMIN_PASSWORD=your-password \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -v llm-gateway-data:/app/data \
  llm-gateway
```

### 方式二：本地开发

要求 Node.js ≥ 22。

```bash
npm install            # 安装前后端依赖（server 与 web 各自的 node_modules）
npm run dev:server     # 后端 http://localhost:3000（tsx watch 热重载）
npm run dev:web        # 前端 http://localhost:5173（Vite 代理 API 到 3000）
npm run mock           # 可选：启动本地 mock 上游（4010），内置 mock-ok/mock-fail 等模型
```

生产运行（单端口 3000，后端托管前端静态资源）：

```bash
npm run build          # 构建 web/dist 与 server/dist/server.cjs
npm start              # http://localhost:3000
```

> 后端仅在**启动时**检测 `web/dist` 是否存在来决定是否托管前端——先 build 再 start。

---

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `<项目根>/data` | 数据目录（SQLite + 主密钥） |
| `DB_PATH` | `<DATA_DIR>/gateway.db` | 数据库文件路径 |
| `ADMIN_USERNAME` | `admin` | 管理员用户名 |
| `ADMIN_PASSWORD` | `admin123` | 管理员密码（首次启动写入，之后改库或删库重建生效） |
| `JWT_SECRET` | 开发默认值 | 管理端 JWT 签名密钥，**生产必须设置** |
| `MASTER_KEY` | 自动生成 | 上游 Key 的 AES-256-GCM 主加密密钥；不设则生成 `data/.master_key` |
| `CORS_ORIGIN` | `*` | 跨域来源 |

系统级运行参数（探测间隔、超时、熔断阈值、日志保留天数等）在 Web「系统设置」页调整，存库生效。

---

## 使用指南

### 1. 渠道管理

录入上游渠道：名称、Base URL（如 `https://api.kilo.ai/api/gateway`）、API Key。

- **从上游获取模型**：填好 URL + Key 后点一下，实时探测上游 `/v1/models` 填充下拉，可点选可手输（填 `*` 通配所有模型）
- **模型测试**：一行点「模型测试」打开弹窗——默认选中该渠道的全部模型（含别名映射），可增删（支持手动输入模型名），点「开始测试」逐条真实调用（`max_tokens=1`），结果展示模型 / 上游实际名 / 可用状态 / 延迟 / 失败原因，可勾选「只看失败」。测试不写入熔断统计，失败不会停用渠道。收费模型会产生极少量 token 消耗，请按需选择。
- **别名映射**：`对外名=上游实际名`（每行一条），让多个渠道对外提供同一个模型名——这是做多渠道容灾的关键
- **优先级 / 权重**：同一模型的渠道调度顺序与权重
- **定时健康探测**：收费渠道可关闭探测（0 费用），仍正常参与负载均衡与熔断保护

### 2. 模型路由

- 展示顺序：拖动模型左侧手柄排序（同时作用于对话页下拉）
- 渠道顺序：展开模型后拖动组内渠道，**越靠上越优先**，失败时按序切换（也可选加权随机 / 轮询策略）
- **失败降级**：为模型配置降级链（如 `z-ai/glm-5.3` → 免费 model），该模型所有渠道失败后自动换降级模型重试；防环去重，流式同样只在首字节前降级

### 3. 网关密钥

对外调用 `/v1/*` 需要 Bearer Key：支持模型白名单、RPM 限流、有效期、启停。

> 明文只在创建时展示一次（服务端仅存 SHA-256 哈希）。本浏览器会缓存你创建的密钥供列表「复制」；换机器后可用「重新生成」换新明文（旧 Key 立即失效）。

### 4. 客户端接入

OpenAI 兼容，任何 OpenAI SDK / 框架把 Base URL 指向网关即可：

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer sk-gw-xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "demo",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

- `GET /v1/models`：聚合所有健康渠道的模型
- `POST /v1/chat/completions`：同步 / SSE 流式
- 响应头 `X-Gateway-Channel(-Name)`：实际命中的渠道；`X-Gateway-Fallback`：发生了模型级降级
- 管理员登录态也可直接调用网关（对话测试页即此方式），无需创建网关密钥

### 5. 可观测性

- **请求日志**：每次调用的模型、命中渠道、延迟、首字延迟、Token 用量、错误详情与 `failover_chain` 切换链路
- **仪表盘**：请求趋势、渠道调用排行、模型 Token 用量排行（24h）、最近失败请求

---

## 核心机制

- **健康检查**：默认每 5 分钟以 `/v1/models` 探测（可切 chat 模式与指定探测模型）；手动停用的渠道跳过；自动停用的渠道冷却结束自动复探测，连续成功 2 次恢复
- **熔断**：连续失败达阈值（默认 3 次）自动停用 + 指数退避冷却（5 分钟起、上限 1 小时）；401/403 鉴权失败与 4xx 请求错误**不计入**熔断（避免聚合渠道里单个付费模型误伤整个渠道）
- **故障切换**：首字节前失败 → 透明切换下一渠道；首字节后中断 → 返回错误事件，不静默伪造成功
- **安全**：上游 Key AES-256-GCM 加密存储（主密钥在数据目录）；网关密钥仅存哈希；管理端 JWT

---

## 项目结构

```
├── server/              # 后端（Fastify + node:sqlite，esbuild 打包为单文件）
│   └── src/
│       ├── core/        # selector 渠道选择 / relay 转发与切换 / health 探测 / breaker 熔断 / adaptor 适配器
│       ├── routes/      # admin API 与 /v1 网关
│       ├── scheduler/   # 健康检查定时任务
│       └── db/          # SQLite 封装 / 迁移 / 种子
├── web/                 # 前端（React 18 + Vite + AntD 5，构建产物由后端托管）
├── scripts/mock-upstream.js  # 本地 mock 上游（联调用）
├── data/                # 运行数据（gateway.db + .master_key，勿提交）
├── Dockerfile
└── docker-compose.yml
```

## 常见问题

- **登录 401 / 被登出**：管理端 JWT 过期会自动跳登录页；对话页只有网关自身鉴权错误才登出，上游返回的模型级 401（如付费模型未授权）只显示错误
- **对话页 Tokens 显示 `-`**：流式下网关透传上游分片，已在请求里带 `stream_options.include_usage`，个别上游不支持时无 usage
- **测试收费模型报 401**：该模型需要单独授权，与你的渠道 Key 无关；可给该模型配置降级链自动落到免费模型
- **改了前端不生效**：后端启动时才检测 `web/dist`，需重新 build 并重启
- **换机器后渠道 Key 解密失败**：主密钥在 `data/.master_key`，迁移时随数据目录一起带走；或改用 `MASTER_KEY` 环境变量固定
