import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { GatewayError } from '../utils/errors';
import { relayChat, type ChatBody } from '../core/relay';
import { listAvailableModels } from '../core/selector';
import { bumpKeyUsage } from '../scheduler/healthCron';
import { lookupGatewayKey, type GatewayKeyContext } from '../middleware/apiKeyAuth';
import { verifyToken } from '../middleware/adminAuth';
import { logger } from '../utils/logger';

/**
 * 网关鉴权：优先用网关 Key；若不是有效 Key，则回退到管理员会话（JWT）。
 * 这样管理后台的「对话测试」页可直接用管理员登录态调用网关，无需额外创建密钥。
 * 管理员会话 ctx.keyId=0，allowedModels=[]（代表全部模型）。
 */
function resolvePrincipal(req: FastifyRequest, reply: FastifyReply): GatewayKeyContext | null {
  const raw = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (raw) {
    const r = lookupGatewayKey(raw);
    if (r.ok) return r.ctx;
    if (r.reason === 'ratelimited') {
      void reply.status(429).send({ error: { message: '超出速率限制', type: 'rate_limited' } });
      return null;
    }
    const admin = verifyToken(raw);
    if (admin) return { keyId: 0, keyName: 'admin', allowedModels: [] };
  }
  void reply.status(401).send({ error: { message: '需提供网关 API Key 或管理员登录', type: 'unauthorized' } });
  return null;
}

const chatSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.unknown()).min(1),
  stream: z.boolean().optional(),
});

function sendError(reply: FastifyReply, err: unknown): void {
  const status = err instanceof GatewayError ? err.status : 500;
  const type = err instanceof GatewayError ? err.type : 'internal_error';
  const message = (err as Error)?.message || '内部错误';
  if (status >= 500) logger.error(`[gateway] ${status} ${type}: ${message.slice(0, 300)}`);
  const payload = {
    error: { message, type, code: status },
  };
  if (reply.sent) return;
  void reply.status(status).send(payload);
}

export async function gatewayRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = resolvePrincipal(req, reply);
    if (!key) return;

    const parsed = chatSchema.safeParse(req.body);
    if (!parsed.success) {
      void reply.status(400).send({
        error: { message: `请求参数错误: ${parsed.error.issues[0]?.message || ''}`, type: 'invalid_request', code: 400 },
      });
      return;
    }
    const body = req.body as ChatBody;

    if (key.allowedModels.length > 0 && !key.allowedModels.includes(body.model) && !key.allowedModels.includes('*')) {
      void reply.status(403).send({
        error: { message: `该 API Key 无权限访问模型 ${body.model}`, type: 'model_not_allowed', code: 403 },
      });
      return;
    }

    try {
      await relayChat(body, reply, { keyId: key.keyId, keyName: key.keyName }, req.ip || '');
      if (key.keyId) bumpKeyUsage(key.keyId);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get('/v1/models', async (req: FastifyRequest, reply: FastifyReply) => {
    const key = resolvePrincipal(req, reply);
    if (!key) return;
    const { publicModels } = listAvailableModels();
    const models =
      key.allowedModels.length > 0 && !key.allowedModels.includes('*')
        ? publicModels.filter((m) => key.allowedModels.includes(m))
        : publicModels;
    void reply.send({
      object: 'list',
      data: models.map((id) => ({ id, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'llm-gateway' })),
    });
  });

  app.post('/v1/embeddings', async (_req: FastifyRequest, reply: FastifyReply) => {
    void reply.status(501).send({ error: { message: '一期暂不支持 embeddings', type: 'not_implemented', code: 501 } });
  });
}
