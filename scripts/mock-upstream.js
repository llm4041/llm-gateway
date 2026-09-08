/**
 * 模拟 OpenAI 兼容上游，用于本地自测健康检查和故障切换。
 * 行为由 model 字段决定，一个进程即可模拟多种上游状态。
 *
 *   node scripts/mock-upstream.js [port]
 *
 * model 约定：
 *   mock-ok          正常返回（非流式/流式均可）
 *   mock-fail        返回 500
 *   mock-401         返回 401（模拟 Key 失效）
 *   mock-slow        延迟 3 秒后成功
 *   mock-cut         流式输出 2 个分片后中断
 *   mock-empty       返回 200 但 body 非法 JSON
 */
const http = require('node:http');

const PORT = Number(process.argv[2] || process.env.MOCK_PORT || 4010);
const MODELS = ['mock-ok', 'mock-fail', 'mock-401', 'mock-slow', 'mock-cut', 'mock-empty'];

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let counter = 0;

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: MODELS.map((id) => ({ id, object: 'model' })) }));
    return;
  }

  if (!req.url.startsWith('/v1/chat/completions')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  const body = await readBody(req);
  const model = body.model || 'mock-ok';
  const n = ++counter;
  console.log(`[mock] #${n} model=${model} stream=${!!body.stream}`);

  if (model === 'mock-401') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'auth_error' } }));
    return;
  }
  if (model === 'mock-fail') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'internal upstream error', type: 'server_error' } }));
    return;
  }
  if (model === 'mock-empty') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('<html>not json</html>');
    return;
  }
  if (model === 'mock-slow') await sleep(3000);

  const reply = `来自 ${model} 的回复（第 ${n} 次调用）`;

  if (body.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const chunks = [reply.slice(0, 6), reply.slice(6, 12), reply.slice(12)];
    for (let i = 0; i < chunks.length; i++) {
      if (model === 'mock-cut' && i === 2) {
        console.log('[mock] 主动中断流');
        res.destroy();
        return;
      }
      res.write(`data: ${JSON.stringify({ id: `chatcmpl-${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }] })}\n\n`);
      await sleep(120);
    }
    res.write(`data: ${JSON.stringify({ id: `chatcmpl-${n}`, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      id: `chatcmpl-${n}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 12, total_tokens: 20 },
    }),
  );
});

server.listen(PORT, () => {
  console.log(`[mock] OpenAI 兼容上游已启动: http://localhost:${PORT}/v1`);
  console.log(`[mock] 可用模型: ${MODELS.join(', ')}`);
});
