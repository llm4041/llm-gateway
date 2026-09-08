import { run } from '../db';
import type { ChannelRow } from '../db/schema';
import { logger } from '../utils/logger';
import type { SysSettings } from '../config';

export function cooldownMsFor(failStreak: number, s: SysSettings): number {
  const base = Math.max(30, s.cooldownBaseSec) * 1000;
  const exp = Math.min(4, Math.max(0, failStreak - s.failThreshold));
  const candidate = base * Math.pow(2, exp);
  return Math.min(candidate, Math.max(base, s.cooldownMaxSec * 1000));
}

/**
 * 记录一次失败：
 * - 连续失败达阈值（默认 3 次，含鉴权失败 401/403）→ 自动停用 + 冷却（指数退避）
 * - 不再对单次鉴权失败立即停用整渠道：聚合上游（如 kilo）对个别付费模型单独鉴权，
 *   一次 401 不代表 key 无效；依赖透明故障切换保证成功率，连续达阈值才停用
 */
export function recordFailure(ch: ChannelRow, errorMsg: string, type: string, s: SysSettings): void {
  const now = Date.now();
  const failStreak = ch.fail_streak + 1;
  const shouldDisable = s.autoDisable === 1 && failStreak >= Math.max(1, s.failThreshold) && ch.disabled_reason !== 'manual';

  if (shouldDisable) {
    const until = now + cooldownMsFor(failStreak, s);
    run(
      `UPDATE channels SET
         fail_streak = ?, success_streak = 0, last_error = ?, last_checked_at = ?,
         total_failures = total_failures + 1, status = 'disabled', enabled = 0,
         disabled_reason = 'auto', cooldown_until = ?, updated_at = ?
       WHERE id = ?`,
      failStreak,
      errorMsg.slice(0, 1000),
      now,
      until,
      now,
      ch.id,
    );
    logger.warn(
      `[breaker] 渠道「${ch.name}」连续失败 ${failStreak} 次，已自动停用，冷却至 ${new Date(until).toLocaleString('zh-CN')}`,
    );
    return;
  }

  run(
    `UPDATE channels SET
       fail_streak = ?, success_streak = 0, last_error = ?, last_checked_at = ?,
       total_failures = total_failures + 1, status = 'failing', updated_at = ?
     WHERE id = ?`,
    failStreak,
    errorMsg.slice(0, 1000),
    now,
    now,
    ch.id,
  );
}

/** 记录一次成功：清零失败计数，满足恢复阈值则自动重新启用 */
export function recordSuccess(ch: ChannelRow, latencyMs: number, s: SysSettings): void {
  const now = Date.now();
  const successStreak = ch.success_streak + 1;
  const canRecover =
    !ch.enabled &&
    ch.disabled_reason === 'auto' &&
    (ch.cooldown_until == null || ch.cooldown_until <= now) &&
    successStreak >= Math.max(1, s.recoverThreshold);

  if (canRecover) {
    run(
      `UPDATE channels SET fail_streak = 0, success_streak = ?, latency_ms = ?, last_error = NULL,
         last_checked_at = ?, status = 'healthy', enabled = 1, disabled_reason = NULL,
         cooldown_until = NULL, updated_at = ? WHERE id = ?`,
      successStreak,
      latencyMs,
      now,
      now,
      ch.id,
    );
    logger.info(`[breaker] 渠道「${ch.name}」连续成功 ${successStreak} 次，已自动恢复启用`);
    return;
  }

  run(
    `UPDATE channels SET fail_streak = 0, success_streak = ?, latency_ms = ?, last_error = NULL,
       last_checked_at = ?, status = 'healthy', updated_at = ? WHERE id = ?`,
    successStreak,
    latencyMs,
    now,
    now,
    ch.id,
  );
}

export function bumpRequestStats(ch: ChannelRow, ok: boolean, tokens: number): void {
  run(
    `UPDATE channels SET total_requests = total_requests + 1,
       total_failures = total_failures + ?, total_tokens = total_tokens + ?, updated_at = ?
     WHERE id = ?`,
    ok ? 0 : 1,
    tokens || 0,
    Date.now(),
    ch.id,
  );
}

/** 手动启用：清除自动停用痕迹 */
export function forceEnable(id: number): void {
  run(
    `UPDATE channels SET enabled = 1, disabled_reason = NULL, cooldown_until = NULL,
       fail_streak = 0, status = 'unknown', updated_at = ? WHERE id = ?`,
    Date.now(),
    id,
  );
}
