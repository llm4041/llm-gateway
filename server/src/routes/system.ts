import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../config';
import { requireAdmin } from '../middleware/adminAuth';
import { runHealthCheck, lastRun, restartScheduler, cleanupLogs } from '../scheduler/healthCron';

function guard(req: FastifyRequest, reply: FastifyReply): boolean {
  return !!requireAdmin(req, reply);
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async (req, reply) => {
    if (!guard(req, reply)) return;
    void reply.send({ data: loadSettings(), defaults: DEFAULT_SETTINGS });
  });

  app.put('/api/settings', async (req, reply) => {
    if (!guard(req, reply)) return;
    const patch = (req.body || {}) as Record<string, unknown>;
    const next = saveSettings(patch);
    restartScheduler();
    void reply.send({ data: next });
  });

  app.get('/api/health/status', async (req, reply) => {
    if (!guard(req, reply)) return;
    void reply.send({ data: { lastRunAt: lastRun.at, results: lastRun.results } });
  });

  app.post('/api/health/run', async (req, reply) => {
    if (!guard(req, reply)) return;
    const results = await runHealthCheck();
    void reply.send({ data: { results } });
  });

  app.post('/api/health/check-one', async (req, reply) => {
    if (!guard(req, reply)) return;
    const { id } = (req.body || {}) as { id?: number };
    if (!id) return void reply.status(400).send({ error: { message: '缺少 id' } });
    void reply.send({ data: { ok: true } });
  });

  app.post('/api/logs/cleanup', async (req, reply) => {
    if (!guard(req, reply)) return;
    const s = loadSettings();
    // 手动触发时才 VACUUM：会锁库，不放在定时清理里做
    const r = cleanupLogs(s.logRetentionDays, s.logDetailRetentionDays, true);
    void reply.send({ data: { ok: true, logs: r.logs, details: r.details } });
  });
}
