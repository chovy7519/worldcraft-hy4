/**
 * WorldCraft LLM 后端代理（最小可运行实现，零第三方依赖）
 *
 * 启动：
 *   OPENAI_API_KEY=sk-... node server/llm-proxy.mjs
 *   npm run dev          # Vite 会把 /api 代理到 127.0.0.1:5191
 *
 * 为什么需要它：v1.2.0 把密钥存在 localStorage 并由浏览器直接请求上游，
 * 密钥会出现在本机所有网络请求里，且无法做配额 / 审计 / 模型白名单。
 * 这里把密钥留在服务端环境变量，并对前端传入的工具定义做白名单收敛。
 *
 * 生产部署：把该进程放到网关后面，用环境变量注入密钥；不要把 OPENAI_API_KEY
 * 写进任何前端代码、构建产物或 git。
 */
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 5191);
const HOST = process.env.HOST ?? '127.0.0.1';
const UPSTREAM = (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
const API_KEY = process.env.OPENAI_API_KEY ?? '';
const MAX_BODY = 64 * 1024;
const ALLOWED_MODELS = (process.env.ALLOWED_MODELS ?? 'gpt-4o-mini,gpt-4o').split(',').map((s) => s.trim());
const ALLOWED_TOOL = 'compile_commands';

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 只允许白名单字段，且工具名必须是 compile_commands —— 防止前端借代理打任意上游接口 */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return { error: '请求体必须是对象' };
  const model = typeof raw.model === 'string' ? raw.model : ALLOWED_MODELS[0];
  if (!ALLOWED_MODELS.includes(model)) return { error: `模型不在白名单：${model}` };
  if (!Array.isArray(raw.messages) || raw.messages.length === 0 || raw.messages.length > 8) {
    return { error: 'messages 非法' };
  }
  const tools = Array.isArray(raw.tools) ? raw.tools : [];
  if (tools.length > 1 || tools.some((t) => t?.function?.name !== ALLOWED_TOOL)) {
    return { error: '只允许 compile_commands 工具' };
  }
  return {
    body: {
      model,
      temperature: 0,
      messages: raw.messages.map((m) => ({ role: String(m.role), content: String(m.content ?? '') })),
      ...(tools.length ? { tools, tool_choice: { type: 'function', function: { name: ALLOWED_TOOL } } } : {}),
    },
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
    res.end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, keyConfigured: Boolean(API_KEY), upstream: UPSTREAM });
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/llm') {
    json(res, 404, { error: 'not found' });
    return;
  }
  if (!API_KEY) {
    json(res, 503, { error: '服务端未配置 OPENAI_API_KEY' });
    return;
  }
  let raw;
  try { raw = await readBody(req); }
  catch (e) { json(res, 400, { error: (e).message }); return; }
  const checked = sanitize(raw);
  if (checked.error) { json(res, 400, { error: checked.error }); return; }

  try {
    const upstream = await fetch(`${UPSTREAM}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify(checked.body),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    json(res, 502, { error: `上游请求失败：${e.message}` });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[worldcraft] LLM proxy listening on http://${HOST}:${PORT}`);
  console.log(`[worldcraft] upstream=${UPSTREAM} keyConfigured=${Boolean(API_KEY)} models=${ALLOWED_MODELS.join(',')}`);
  if (!API_KEY) console.warn('[worldcraft] 警告：未设置 OPENAI_API_KEY，/api/llm 会返回 503');
});
