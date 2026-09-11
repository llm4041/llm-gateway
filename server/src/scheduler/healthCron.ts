import { all, run, sqlite } from '../db';
import type { ChannelRow } from '../db/schema';
import { probeChannel, type ProbeResult } from '../core/health';
import { logger } from '../utils/logger';
import { loadSettings, type SysSettings } from '../config';

let timer: NodeJS.Timeout | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;
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

/**
 * 清理过期日志。报文明细比元数据大一个量级，单独按更短周期过期；
 * 明细有效期不会超过主日志保留期，否则会留下主日志已删的孤儿明细。
 * SQLite 删除行后空间只进 freelist 供后续复用，文件大小不变，
 * 需要真正回收磁盘时传 vacuum=true（会锁库，只在手动触发时用）。
 */
export function cleanupLogs(retentionDays: number, detailRetentionDays?: number, vacuum = false): { logs: number; details: number } {
  const now = Date.now();
  const days = Math.max(1, retentionDays);
  const cutoff = now - days * 86400_000;
  // 明细周期取 min(明细天数, 主日志天数)，且不小于 1 天
  const detailDays = Math.min(Math.max(1, detailRetentionDays ?? days), days);
  const detailCutoff = now - detailDays * 86400_000;

  // 先清明细，避免日志主表删掉后留下孤儿记录
  const dres = run(
    'DELETE FROM request_log_details WHERE log_id IN (SELECT id FROM request_logs WHERE ts < ?)',
    detailCutoff,
  );
  const res = run('DELETE FROM request_logs WHERE ts < ?', cutoff);
  // 兜底：清理历史遗留的孤儿明细（主日志已不存在的）
  const orphan = run(
    'DELETE FROM request_log_details WHERE log_id NOT IN (SELECT id FROM request_logs)',
  );
  const changes = Number(res.changes || 0);
  const dchanges = Number(dres.changes || 0) + Number(orphan.changes || 0);
  if (changes > 0 || dchanges > 0) {
    logger.info(
      `[cleanup] 清理 ${changes} 条过期日志、${dchanges} 条报文明细（日志保留 ${days} 天 / 报文保留 ${detailDays} 天）`,
    );
  }
  if (vacuum) {
    const t0 = Date.now();
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    sqlite.exec('VACUUM');
    logger.info(`[cleanup] 已收缩数据库文件，耗时 ${Date.now() - t0}ms`);
  } else {
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return { logs: changes, details: dchanges };
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

  // 必须先清掉旧的，否则每次保存设置都会残留一个定时器
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = setInterval(() => {
    const s = loadSettings();
    cleanupLogs(s.logRetentionDays, s.logDetailRetentionDays);
  }, 6 * 3600 * 1000);
  cleanupTimer.unref?.();

  logger.info(`[scheduler] 健康检查已启动，间隔 ${s.healthCheckIntervalSec}s`);
}

export function restartScheduler(): void {
  if (timer) clearInterval(timer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  timer = null;
  cleanupTimer = null;
  startScheduler();
}

export function bumpKeyUsage(keyId: number): void {
  run('UPDATE gateway_keys SET total_requests = total_requests + 1, last_used_at = ? WHERE id = ?', Date.now(), keyId);
}
