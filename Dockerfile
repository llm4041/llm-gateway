# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web-builder
WORKDIR /build
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 阶段 2：构建后端（esbuild 打包为自包含单文件） ----------
FROM node:22-alpine AS server-builder
WORKDIR /build
COPY server/package.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build

# ---------- 阶段 3：运行时 ----------
FROM node:22-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.title="llm-gateway" \
      org.opencontainers.image.description="LLM API 负载均衡网关：多渠道聚合 / 健康检查 / 故障无感切换"

# 目录布局需保持 server/dist/server.cjs + web/dist：
# paths.ts 以 server.cjs 所在目录推导 ROOT_DIR=/app、WEB_DIST_DIR=/app/web/dist、DATA_DIR=/app/data
COPY --from=server-builder /build/dist/server.cjs ./server/dist/server.cjs
COPY --from=web-builder /build/dist/ ./web/dist/

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 3000

# 健康检查：网关自带 /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/dist/server.cjs"]
