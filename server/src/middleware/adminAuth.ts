import type { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { config } from '../config';

export type AdminPayload = { username: string };

export function signToken(username: string): string {
  return jwt.sign({ username }, config.jwtSecret, { expiresIn: '12h' });
}

export function verifyToken(token: string): AdminPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as AdminPayload;
  } catch {
    return null;
  }
}

export function requireAdmin(req: FastifyRequest, reply: FastifyReply): AdminPayload | null {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = raw ? verifyToken(raw) : null;
  if (!payload) {
    void reply.status(401).send({ error: { message: '未登录或登录已过期', type: 'unauthorized' } });
    return null;
  }
  return payload;
}
