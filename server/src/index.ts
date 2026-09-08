import fs from 'node:fs';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { config, loadSettings } from './config';
import { DATA_DIR, WEB_DIST_DIR, DB_PATH } from './paths';
import { migrate } from './db/migrate';
import { seedAdmin } from './db/seed';
import { startScheduler } from './scheduler/healthCron';
import { gatewayRoutes } from './routes/gateway';
import { authRoutes } from './routes/auth';
import { channelRoutes } from './routes/channels';
import { modelRouteRoutes } from './routes/routes';
import { keyRoutes } from './routes/keys';
import { logRoutes } from './routes/logs';
import { statsRoutes } from './routes/stats';
import { systemRoutes } from './routes/system';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  migrate();
  seedAdmin();
  loadSettings();

  const app = Fastify({
    logger: false,
    bodyLimit: 32 * 1024 * 1024,
    // 流式响应可能持续数分钟，禁用请求超时
    connectionTimeout: 0,
    keepAliveTimeout: 65_000,
  });

  await app.register(cors, { origin: config.corsOrigin === '*' ? true : config.corsOrigin });

  await app.register(gatewayRoutes);
  await app.register(authRoutes);
  await app.register(channelRoutes);
  await app.register(modelRouteRoutes);
  await app.register(keyRoutes);
  await app.register(logRoutes);
  await app.register(statsRoutes);
  await app.register(systemRoutes);

  app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

  // 生产模式：前端构建产物由后端同一端口托管
  if (fs.existsSync(WEB_DIST_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIST_DIR, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/v1')) {
        void reply.status(404).send({ error: { message: '接口不存在', type: 'not_found' } });
        return;
      }
      void reply.sendFile('index.html');
    });
  }

  startScheduler();

  try {
    await app.listen({ port: config.port, host: config.host });
    logger.info(`[gateway] 服务已启动: http://localhost:${config.port}`);
    logger.info(`[gateway] 数据库: ${DB_PATH}`);
    logger.info(`[gateway] 数据目录: ${DATA_DIR}`);
    if (!fs.existsSync(WEB_DIST_DIR)) {
      logger.warn('[gateway] 未检测到前端构建产物，开发模式请另开终端运行 npm run dev:web');
    }
  } catch (err) {
    logger.error('[gateway] 启动失败', err);
    process.exit(1);
  }
}

process.on('unhandledRejection', (e) => logger.error('unhandledRejection', e));
process.on('uncaughtException', (e) => logger.error('uncaughtException', e));

void main();
