import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { get, run } from '../db';
import type { AdminRow } from '../db/schema';
import { hashPassword } from '../utils/crypto';
import { signToken, requireAdmin } from '../middleware/adminAuth';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/auth/login', async (req: FastifyRequest, reply: FastifyReply) => {
    const { username, password } = (req.body || {}) as { username?: string; password?: string };
    if (!username || !password) {
      return void reply.status(400).send({ error: { message: '请输入用户名和密码' } });
    }
    const row = get<AdminRow>('SELECT * FROM admins WHERE username = ?', username);
    if (!row || row.password_hash !== hashPassword(password, row.salt)) {
      return void reply.status(401).send({ error: { message: '用户名或密码错误' } });
    }
    void reply.send({ data: { token: signToken(row.username), username: row.username } });
  });

  app.get('/api/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = requireAdmin(req, reply);
    if (!payload) return;
    void reply.send({ data: payload });
  });

  app.post('/api/auth/password', async (req: FastifyRequest, reply: FastifyReply) => {
    const payload = requireAdmin(req, reply);
    if (!payload) return;
    const { oldPassword, newPassword } = (req.body || {}) as { oldPassword?: string; newPassword?: string };
    if (!oldPassword || !newPassword || newPassword.length < 6) {
      return void reply.status(400).send({ error: { message: '原密码必填，新密码至少 6 位' } });
    }
    const row = get<AdminRow>('SELECT * FROM admins WHERE username = ?', payload.username);
    if (!row || row.password_hash !== hashPassword(oldPassword, row.salt)) {
      return void reply.status(401).send({ error: { message: '原密码错误' } });
    }
    run('UPDATE admins SET password_hash = ? WHERE id = ?', hashPassword(newPassword, row.salt), row.id);
    void reply.send({ data: { ok: true } });
  });
}
