/**
 * 星空画布 · Netlify Functions 统一入口
 * ==================================================================
 * 把 server.js 的后端代理逻辑封装为 Netlify 无服务器函数，
 * 使「星空画布」可发布为公网站点，任何浏览器（含手机）都能打开。
 *
 * 作用与 server.js 完全一致：
 *   - 服务端转发 Pollinations 免费模型，绕过浏览器 CORS 与 Cloudflare 人机验证
 *   - 转发自备 Key 的 OpenAI 兼容 / 通义万相 / 百度智能云 / remove.bg
 *   - 任何图片与下载都不含水印（nologo + 负面提示词）
 *
 * 路由（经 netlify.toml 的 /api/* 重定向到这里，:splat 即完整 /api/ 路径）：
 *   GET  /api/providers        → 能力目录
 *   GET  /api/health           → 健康信息
 *   POST /api/ai/models        → 拉取模型列表
 *   POST /api/ai/:cap          → 转发能力调用（chat/image/vision/upscale/matting/video）
 * ==================================================================
 */
'use strict';

const { URL } = require('url');

/* ---------------- 能力目录（与 server.js 完全一致） ---------------- */
function inlineCatalog() {
  return {
    version: '1.2.0-netlify',
    capabilities: [
      { id: 'chat', label: '智能对话' }, { id: 'image', label: '文生图 / 图生图' },
      { id: 'vision', label: '看图理解（反推提示词）' }, { id: 'upscale', label: '变清晰（超分）' },
      { id: 'matting', label: '抠图（主体分离）' }, { id: 'video', label: '视频生成' }
    ],
    providers: [
      { id: 'pollinations', label: 'Pollinations 免费模型', kind: 'free', needsKey: false,
        note: '开箱即用的免费通道（Netlify 函数服务端转发，绕过浏览器 CORS 与人机验证）。文生图 Sana/Flux 等、对话 OpenAI 开源模型。出图强制 nologo=true，任何图片都不含水印。',
        capabilities: {
          chat: { defaultModel: 'openai', models: [{ id: 'openai', label: 'GPT-OSS 20B（推理）' }, { id: 'openai-fast', label: 'GPT-OSS 20B（快速）' }, { id: 'mistral', label: 'Mistral' }, { id: 'llama', label: 'Llama' }, { id: 'qwen', label: 'Qwen' }, { id: 'gemini', label: 'Gemini' }] },
          image: { defaultModel: 'sana', models: [{ id: 'sana', label: 'Sana（免费无水印）' }, { id: 'flux', label: 'Flux（免费档）' }, { id: 'turbo', label: 'Turbo（免费档）' }, { id: 'sdxl', label: 'SDXL（免费档）' }], maxSize: 1536 }
        }
      },
      { id: 'openai-compat', label: 'OpenAI 兼容接口（自备 Key）', kind: 'byok', needsKey: true,
        baseUrlLabel: 'Base URL（通常以 /v1 结尾）', keyLabel: 'API Key',
        note: 'DeepSeek / 通义千问 / 智谱 GLM / Kimi / OpenAI 等。本后端模式下对话、看图、文生图均可转发。',
        presets: [
          { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', chatModels: ['deepseek-chat', 'deepseek-reasoner'], vision: false },
          { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', chatModels: ['qwen-plus', 'qwen-turbo', 'qwen-vl-max'], vision: true, imageModels: ['qwen-image'] },
          { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', chatModels: ['glm-4-plus', 'glm-4v-flash', 'glm-4v-plus'], vision: true },
          { label: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', chatModels: ['moonshot-v1-8k', 'moonshot-v1-32k'] },
          { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', chatModels: ['gpt-4o-mini', 'gpt-4o'], vision: true, imageModels: ['gpt-image-1'] }
        ],
        capabilities: {
          chat: { defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner', 'qwen-plus', 'qwen-vl-max', 'glm-4-plus', 'moonshot-v1-8k', 'gpt-4o-mini'] },
          vision: { defaultModel: 'qwen-vl-max', models: ['qwen-vl-max', 'glm-4v-flash', 'glm-4v-plus', 'gpt-4o-mini'] },
          image: { defaultModel: 'qwen-image', models: ['qwen-image', 'gpt-image-1'] }
        }
      },
      { id: 'dashscope-native', label: '通义万相（自备 Key）', kind: 'byok', needsKey: true, keyLabel: 'DashScope API Key',
        note: '阿里云通义万相文生图 / 文生视频。由本后端转发。',
        capabilities: {
          image: { defaultModel: 'wanx2.1-t2i-turbo', models: ['wanx2.1-t2i-turbo', 'wanx2.1-t2i-plus'] },
          video: { defaultModel: 'wanx2.1-t2v-turbo', models: ['wanx2.1-t2v-turbo', 'wanx2.1-t2v-plus'] }
        }
      },
      { id: 'baidu-aip', label: '百度智能云（自备 Key）', kind: 'byok', needsKey: true, keyLabel: 'API Key', secretLabel: 'Secret Key',
        note: '百度人像分割（抠图）、图像超分。由本后端转发。',
        capabilities: {
          upscale: { defaultModel: 'image_super_resolution', models: ['image_super_resolution'] },
          matting: { defaultModel: 'body_seg', models: ['body_seg', 'selfie_seg'] }
        }
      },
      { id: 'removebg', label: 'remove.bg（自备 Key）', kind: 'byok', needsKey: true, keyLabel: 'remove.bg API Key',
        note: '专业抠图服务。由本后端转发。',
        capabilities: { matting: { defaultModel: 'auto', models: ['auto'] } }
      },
      { id: 'local', label: '本地引擎（离线免费）', kind: 'local', needsKey: false,
        note: '浏览器内本地计算，素材不上传。',
        capabilities: { upscale: { defaultModel: 'local-upscale' }, matting: { defaultModel: 'local-matting' }, video: { defaultModel: 'local-video' }, vision: { defaultModel: 'local-analyze' } }
      }
    ],
    generationModes: [
      { id: 'main', label: '主图', promptTemplate: '电商主图，{subject}', defaultSize: '1:1', suggestSizes: ['1:1', '3:4'], negative: 'text, watermark, logo, cropped, worst quality, low quality', postProcess: [] },
      { id: 'whitebg', label: '白底图', promptTemplate: '纯白背景商品图，{subject}', defaultSize: '1:1', suggestSizes: ['1:1'], negative: 'text, watermark, logo, shadow, colored background, worst quality', postProcess: ['whiteBackground'] },
      { id: 'detail', label: '详情页', promptTemplate: '电商详情页配图，{subject}', defaultSize: '3:4', suggestSizes: ['3:4', '2:3'], negative: 'text, watermark, logo, worst quality', postProcess: [] },
      { id: 'video', label: '视频', promptTemplate: '{subject}', defaultSize: '9:16', suggestSizes: ['9:16', '16:9', '1:1'], negative: '', postProcess: [] },
      { id: 'free', label: '自由创作', promptTemplate: '{subject}', defaultSize: '1:1', suggestSizes: ['1:1', '3:4', '16:9'], negative: '', postProcess: [] }
    ],
    sizePresets: [
      { id: '1:1', label: '1:1 方形', ratio: [1, 1], width: 1024, height: 1024 },
      { id: '3:4', label: '3:4 竖版', ratio: [3, 4], width: 896, height: 1152 },
      { id: '16:9', label: '16:9 宽屏', ratio: [16, 9], width: 1280, height: 720 },
      { id: 'custom', label: '自定义尺寸', ratio: null, width: 0, height: 0 }
    ],
    exportFormats: [
      { id: 'png', label: 'PNG（无损）', mime: 'image/png' }, { id: 'jpeg', label: 'JPEG（压缩）', mime: 'image/jpeg' },
      { id: 'webp', label: 'WebP（高效）', mime: 'image/webp' }, { id: 'svg', label: 'SVG（矢量文本层）', mime: 'image/svg+xml' },
      { id: 'webm', label: 'WebM 视频（本地合成）', mime: 'video/webm' }, { id: 'json', label: 'JSON 工程存档', mime: 'application/json' }
    ],
    toolRegistry: []
  };
}

/* ---------------- 通用工具（与 server.js 一致） ---------------- */
function safeJson(t) { try { return JSON.parse(t); } catch (_) { return null; } }
function clampInt(v, min, max, d) { const n = parseInt(v, 10); if (Number.isNaN(n)) return d; return Math.max(min, Math.min(max, n)); }
function stripPrefix(dataUrl) {
  if (typeof dataUrl !== 'string') return '';
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}
function upstreamError(status, message, hint) {
  const e = new Error(message || `上游错误 ${status}`);
  e.status = status; e.hint = hint || '';
  return e;
}

function upstream(urlStr, opts = {}) {
  const u = new URL(urlStr);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ 'User-Agent': 'starry-canvas/1.0' }, opts.headers || {});
    const req = lib.request(u, { method: opts.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: buf, text: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ---------------- 供应商转发（与 server.js 一致） ---------------- */
async function forwardPollinationsChat(payload, model) {
  const messages = payload.messages || (payload.prompt ? [{ role: 'user', content: payload.prompt }] : []);
  const clean = (messages || []).map((m) => (Array.isArray(m.content)
    ? { role: m.role, content: m.content.filter((c) => c && c.type !== 'image_url').map((c) => c.text || '').join('\n') }
    : { role: m.role, content: m.content })).filter((m) => m.content);
  const r = await upstream('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model || 'openai', messages: clean, private: true, stream: !!payload.stream })
  });
  if (r.status !== 200) {
    const e = safeJson(r.text);
    throw upstreamError(r.status, (e && e.error) || `免费对话返回 ${r.status}（可能限流，请稍后重试）`);
  }
  if (payload.stream) {
    return { ok: true, sse: true, rawBody: r.body.toString('utf8'), rawHeaders: r.headers };
  }
  const data = safeJson(r.text);
  const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return {
    ok: true,
    data: { text: typeof content === 'string' ? content.trim() : '', model: (data && data.model) || model || 'openai' }
  };
}

async function forwardPollinationsImage(payload, model) {
  const width = clampInt(payload.width, 256, 1536, 1024);
  const height = clampInt(payload.height, 256, 1536, 1024);
  const params = new URLSearchParams({
    width: String(width), height: String(height),
    model: model || 'sana', nologo: 'true', private: 'true',
    seed: String(payload.seed ?? Math.floor(Math.random() * 99999999))
  });
  const neg = String(payload.negativePrompt || 'text, watermark, logo, worst quality, low quality').slice(0, 300);
  params.set('negative', neg);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(String(payload.prompt || '')).slice(0, 1800)}?${params}`;
  const r = await upstream(url, { headers: { Accept: 'image/*' } });
  if (r.status !== 200) throw upstreamError(r.status, `免费文生图返回 ${r.status}（可能限流，请稍后重试）`);
  return { ok: true, data: { images: [r.body.toString('base64')], imageBase64: true, width, height, model: model || 'sana', mime: (r.headers['content-type'] || 'image/jpeg').split(';')[0] } };
}

async function forwardOpenAiCompat(payload, model, cap, baseUrl, key) {
  const base = (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (cap === 'chat' || cap === 'vision') {
    let messages = payload.messages || [];
    if (cap === 'vision') {
      messages = [{ role: 'user', content: [{ type: 'text', text: payload.prompt || '描述这张图' }, { type: 'image_url', image_url: { url: payload.image } }] }];
    }
    const r = await upstream(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model, messages, stream: !!payload.stream })
    });
    if (r.status !== 200) throw upstreamError(r.status, (safeJson(r.text)?.error?.message) || `供应商返回 ${r.status}`);
    if (payload.stream) return { ok: true, sse: true, rawBody: r.body.toString('utf8'), rawHeaders: r.headers };
    const data = safeJson(r.text);
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return { ok: true, data: { text: typeof content === 'string' ? content.trim() : '', model: data && data.model } };
  }
  if (cap === 'image') {
    const r = await upstream(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model, prompt: payload.prompt, n: 1, size: `${payload.width || 1024}x${payload.height || 1024}` })
    });
    if (r.status !== 200) throw upstreamError(r.status, (safeJson(r.text)?.error?.message) || `供应商返回 ${r.status}`);
    const data = safeJson(r.text);
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    const url = data && data.data && data.data[0] && data.data[0].url;
    if (b64) return { ok: true, data: { images: [b64], imageBase64: true, width: payload.width, height: payload.height, model } };
    if (url) {
      const img = await upstream(url, {});
      return { ok: true, data: { images: [img.body.toString('base64')], imageBase64: true, width: payload.width, height: payload.height, model } };
    }
    throw upstreamError(500, '供应商没有返回图片');
  }
  throw upstreamError(400, `该供应商不支持「${cap}」`);
}

async function forwardDashscope(payload, model, key, cap) {
  if (cap === 'image') {
    const r = await upstream('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model || 'wanx2.1-t2i-turbo', input: { prompt: payload.prompt }, parameters: { size: `${payload.width || 1024}*${payload.height || 1024}`, n: payload.n || 1 } })
    });
    const data = safeJson(r.text);
    if (r.status !== 200 || !data) throw upstreamError(r.status, (data && data.message) || `通义万相返回 ${r.status}`);
    if (data.output && data.output.task_status) {
      return { ok: true, data: { taskId: data.output.task_id, status: data.output.task_status, message: '异步任务已提交，请用查询接口获取结果', model } };
    }
    const urls = (data.output && data.output.results || []).map((x) => x.url).filter(Boolean);
    return { ok: true, data: { urls, imageUrls: urls, message: '通义万相异步任务已提交', model } };
  }
  if (cap === 'video') {
    const r = await upstream('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2video/video-synthesis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: model || 'wanx2.1-t2v-turbo', input: { prompt: payload.prompt } })
    });
    const data = safeJson(r.text);
    if (r.status !== 200 || !data) throw upstreamError(r.status, (data && data.message) || `通义万相视频返回 ${r.status}`);
    return { ok: true, data: { taskId: data.output && data.output.task_id, message: '通义万相视频异步任务已提交，可在控制台或查询接口查看', model } };
  }
  throw upstreamError(400, `通义万相不支持「${cap}」`);
}

async function baiduToken(key, secret) {
  if (!key || !secret) throw upstreamError(400, '百度智能云需要 API Key 与 Secret Key');
  const r = await upstream(`https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=${encodeURIComponent(key)}&client_secret=${encodeURIComponent(secret)}`, {});
  const data = safeJson(r.text);
  if (!data || !data.access_token) throw upstreamError(400, '百度 access_token 获取失败：' + (data && data.error_description || r.text.slice(0, 80)));
  return data.access_token;
}
async function forwardBaidu(payload, model, key, secret, cap) {
  const token = await baiduToken(key, secret);
  if (cap === 'matting') {
    const img = payload.image;
    const r = await upstream('https://aip.baidubce.com/rest/2.0/image-classify/v1/body_seg?access_token=' + token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image: stripPrefix(img) }).toString()
    });
    const data = safeJson(r.text);
    if (r.status !== 200 || !data || data.error_code) throw upstreamError(r.status, (data && (data.error_msg || data.error_code)) || `百度抠图返回 ${r.status}`);
    return { ok: true, data: { image: data.foreground, imageBase64: true, mime: 'image/png', model: model || 'body_seg' } };
  }
  if (cap === 'upscale') {
    const r = await upstream('https://aip.baidubce.com/rest/2.0/image-process/v1/image_quality_enhance?access_token=' + token, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ image: stripPrefix(payload.image) }).toString()
    });
    const data = safeJson(r.text);
    if (r.status !== 200 || !data || data.error_code) throw upstreamError(r.status, (data && (data.error_msg || data.error_code)) || `百度超分返回 ${r.status}`);
    return { ok: true, data: { image: data.image, imageBase64: true, mime: 'image/png', model: model || 'image_super_resolution' } };
  }
  throw upstreamError(400, `百度智能云不支持「${cap}」`);
}

async function forwardRemoveBg(payload, key) {
  const img = stripPrefix(payload.image);
  const r = await upstream('https://api.remove.bg/v1.0/removebg', {
    method: 'POST',
    headers: { 'X-Api-Key': key },
    body: new URLSearchParams({ image_file_b64: img, size: 'auto' }).toString()
  });
  if (r.status !== 200) throw upstreamError(r.status, (safeJson(r.text)?.errors?.[0]?.message) || `remove.bg 返回 ${r.status}`);
  return { ok: true, data: { image: r.body.toString('base64'), imageBase64: true, mime: r.headers['content-type'] || 'image/png', model: 'auto' } };
}

async function routeForward(provider, cap, model, body, key, secret, baseUrl) {
  switch (provider) {
    case 'pollinations':
      if (cap === 'chat') return await forwardPollinationsChat(body, model);
      if (cap === 'image') return await forwardPollinationsImage(body, model);
      throw upstreamError(400, `免费通道不支持「${cap}」，请配置自备 Key 或使用本地引擎`);
    case 'openai-compat':
      return await forwardOpenAiCompat(body, model, cap, baseUrl, key);
    case 'dashscope-native':
      return await forwardDashscope(body, model, key, cap);
    case 'baidu-aip':
      return await forwardBaidu(body, model, key, secret, cap);
    case 'removebg':
      if (cap !== 'matting') throw upstreamError(400, `remove.bg 仅支持抠图`);
      return await forwardRemoveBg(body, key);
    case 'local':
      throw upstreamError(400, `本地引擎在浏览器内运行，无需后端转发`);
    default:
      throw upstreamError(400, `未知供应商：${provider}`);
  }
}

/* ---------------- Netlify Handler ---------------- */
exports.handler = async (event) => {
  const method = event.httpMethod || 'GET';
  const rawPath = event.path || '';
  const pathname = decodeURIComponent(rawPath).replace(/^\/api/, '/api');

  const send = (status, data, extraHeaders = {}) => ({
    statusCode: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, extraHeaders),
    body: typeof data === 'string' ? data : JSON.stringify(data)
  });

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, body: '' };
  }

  try {
    // 能力目录
    if (pathname === '/api/providers') return send(200, { ok: true, data: inlineCatalog() });
    // 健康检查
    if (pathname === '/api/health') return send(200, { ok: true, name: 'starry-canvas-backend', version: inlineCatalog().version, mode: 'netlify-function' });

    // 读取请求体
    let body = {};
    if (event.body) {
      try { body = event.isBase64Encoded ? JSON.parse(Buffer.from(event.body, 'base64').toString('utf8')) : JSON.parse(event.body); }
      catch (_) { body = {}; }
    }

    // 模型列表
    if (pathname === '/api/ai/models' && method === 'POST') {
      const key = event.headers['x-ai-key'] || '';
      const base = event.headers['x-ai-base-url'] || '';
      if (body.provider === 'pollinations') {
        const [t, i] = await Promise.all([
          upstream('https://text.pollinations.ai/models', {}).then((r) => safeJson(r.text)).catch(() => []),
          upstream('https://image.pollinations.ai/models', {}).then((r) => safeJson(r.text)).catch(() => [])
        ]);
        const norm = (arr) => (Array.isArray(arr) ? arr.map((x) => (typeof x === 'string' ? x : (x.name || x.id))).filter(Boolean) : []);
        return send(200, { ok: true, data: { models: [...norm(t), ...norm(i)], chat: norm(t), image: norm(i) } });
      }
      if (body.provider === 'openai-compat' && base) {
        const r = await upstream(`${base.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${key}` } });
        if (r.status === 200) { const d = safeJson(r.text); return send(200, { ok: true, data: { models: (d && d.data || []).map((m) => m.id) } }); }
        return send(400, { ok: false, error: { code: 'upstream', message: `拉取模型失败（${r.status}）` } });
      }
      return send(400, { ok: false, error: { code: 'unsupported', message: '该供应商在无 Key 情况下无法拉取模型列表' } });
    }

    // 能力调用
    const m = pathname.match(/^\/api\/ai\/(chat|image|vision|upscale|matting|video)$/);
    if (m && method === 'POST') {
      const cap = m[1];
      const provider = body.provider || 'pollinations';
      const model = body.model || '';
      const key = event.headers['x-ai-key'] || body.key || '';
      const secret = event.headers['x-ai-secret'] || body.secret || '';
      const baseUrl = event.headers['x-ai-base-url'] || body.baseUrl || '';
      const r = await routeForward(provider, cap, model, body, key, secret, baseUrl);
      if (r && r.sse && r.rawBody) {
        // SSE 流式：Netlify 函数一次性透传完整 SSE 文本（前端 SSE 解析器按事件行切分，逐条渲染）
        const ct = (r.rawHeaders && (r.rawHeaders['content-type'] || r.rawHeaders['Content-Type'])) || 'text/event-stream; charset=utf-8';
        return {
          statusCode: 200,
          headers: { 'Content-Type': ct, 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*', 'X-Accel-Buffering': 'no' },
          body: r.rawBody
        };
      }
      return send(200, r);
    }

    if (pathname.startsWith('/api/')) return send(404, { ok: false, error: { code: 'not_found', message: '接口不存在' } });

    // 非 /api 路径：Netlify 静态托管会自行处理，这里兜底
    return { statusCode: 404, body: 'Not Found' };
  } catch (err) {
    const status = err.status || 500;
    return send(status, { ok: false, error: { code: err.code || (status >= 500 ? 'upstream' : 'bad_request'), message: err.message || '服务器内部错误', hint: err.hint || '' } });
  }
};
