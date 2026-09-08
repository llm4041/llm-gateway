import { all, run } from '../db';
import type { ChannelRow } from '../db/schema';
import { probeChannel, type ProbeResult } from '../core/health';
import { logger } from '../utils/logger';
import { loadSettings, type SysSettings } from '../config';

let timer: NodeJS.Timeout | null = null;
let running = false;
export const lastRun: { at: number | null; results: ProbeResult[] } = { at: null, results: [] };

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

export async function runHealthCheck(): Promise<ProbeResult[]> {
  if (running) return lastRun.results;
  running = true;
  const s: SysSettings = loadSettings();
  const now = Date.now();
  // 手动停用的渠道不探测；自动停用的渠道在冷却结束后仍要探测以便自动恢复；
  // health_check=0 的渠道（如收费模型）跳过定时探测，避免产生费用，仍正常参与负载均衡
  const targets = all<ChannelRow>('SELECT * FROM channels').filter(
    (ch) => ch.disabled_reason !== 'manual' && ch.health_check !== 0,
  ).filter((ch) => ch.cooldown_until == null || ch.cooldown_until <= now);

  if (targets.length === 0) {
    running = false;
    lastRun.at = Date.now();
    lastRun.results = [];
    return [];
  }

  const results: ProbeResult[] = [];
  const started = Date.now();
  await pool(targets, Math.max(1, s.healthCheckConcurrency), async (ch) => {
    const r = await probeChannel(ch, s);
    results.push(r);
  });

  lastRun.at = Date.now();
  lastRun.results = results;
  const failed = results.filter((r) => !r.ok);
  logger.info(
    `[health] 探测 ${results.length} 个渠道，成功 ${results.length - failed.length}，失败 ${failed.length}，耗时 ${Date.now() - started}ms`,
  );
  running = false;
  return results;
}

export function cleanupLogs(retentionDays: number): void {
  const cutoff = Date.now() - Math.max(1, retentionDays) * 86400_000;
  const res = run('DELETE FROM request_logs WHERE ts < ?', cutoff);
  if (res.changes > 0) logger.info(`[cleanup] 清理 ${res.changes} 条过期请求日志`);
}

export function startScheduler(): void {
  const s = loadSettings();
  if (timer) clearInterval(timer);
  const intervalMs = Math.max(30, s.healthCheckIntervalSec) * 1000;
  timer = setInterval(() => {
    runHealthCheck().catch((e) => logger.error('[health] 调度异常', e));
  }, intervalMs);
  timer.unref?.();

  // 启动 5 秒后跑一轮；日志每天清理一次
  setTimeout(() => {
    runHealthCheck().catch((e) => logger.error('[health] 首轮探测异常', e));
  }, 5000).unref?.();

  setInterval(() => cleanupLogs(loadSettings().logRetentionDays), 6 * 3600 * 1000).unref?.();

  logger.info(`[scheduler] 健康检查已启动，间隔 ${s.healthCheckIntervalSec}s`);
}

export function restartScheduler(): void {
  if (timer) clearInterval(timer);
  startScheduler();
}

export function bumpKeyUsage(keyId: number): void {
  run('UPDATE gateway_keys SET total_requests = total_requests + 1, last_used_at = ? WHERE id = ?', Date.now(), keyId);
}
