import { all, run } from './index';
import { hashPassword, newSalt } from '../utils/crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

export function seedAdmin(): void {
  const existing = all('SELECT id FROM admins LIMIT 1');
  if (existing.length > 0) return;
  const salt = newSalt();
  run('INSERT INTO admins (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)', config.adminUsername, hashPassword(config.adminPassword, salt), salt, Date.now());
  logger.info(`[seed] 已创建管理员账号：${config.adminUsername} / ${config.adminPassword}（登录后请尽快修改密码）`);
}
