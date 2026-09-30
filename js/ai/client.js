/**
 * 星空画布 · AI 客户端
 * ------------------------------------------------------------------
 * 对上暴露六个能力（chat / image / vision / upscale / matting / video），
 * 对下自动选择通道：
 *   1. 有后端代理 → 一律走 /api/ai/*，任何供应商都不受浏览器 CORS 限制，密钥不进前端代码；
 *   2. 无后端（单文件版）→ 免费通道可直连（Pollinations 开放 CORS），
 *      自备 Key 通道尝试直连，被浏览器拦截时给出明确的解决指引；
 *   3. provider === 'local' → 交给注册的本地引擎，在浏览器里离线计算。
 * 任一通道失败时，按 availableRoutes 自动回退到下一条可用通道。
 */

import { state, bus, availableRoutes, routeFor, providerLabel, capabilitySupportedBy } from '../core/state.js';
import { toast } from '../ui/dom.js';

export class AiClientError extends Error {
  constructor(code, message, hint = '', extra = {}) {
    super(message);
    this.name = 'AiClientError';
    this.code = code;
    this.hint = hint;
    Object.assign(this, extra);
  }
}

const localEngines = { upscale: null, matting: null, video: null, analyze: null };

export function registerLocalEngine(name, fn) { localEngines[name] = fn; }
export function hasLocalEngine(name) { return typeof localEngines[name] === 'function'; }

/** 从 OpenAI 风格的多模态 messages 里取第一张图片 */
function pickFirstImageUrl(messages) {
  for (const m of messages || []) {
    if (!Array.isArray(m.content)) continue;
    for (const c of m.content) {
      const url = c && c.type === 'image_url' ? (c.image_url && (c.image_url.url || c.image_url)) : null;
      if (typeof url === 'string' && url) return url;
    }
  }
  return null;
}

export const ai = {
  backend: false,
  backendInfo: null,
  catalog: null,

  /* ---------------- 初始化：探测后端 + 拉取能力目录 ---------------- */
  async init() {
    // 先探测本地后端代理（node server.js）：后端转发可绕过浏览器 CORS 与人机验证，
    // 是免费模型出图/对话真正可用的首选通道
    let backendReady = false;
    try {
      const res = await fetch('./api/providers', { cache: 'no-store' });
      const json = await res.json();
      if (json?.ok && json.data) {
        this.catalog = json.data;
        state.catalog = json.data;
        this.backend = true;
        backendReady = true;
      }
    } catch (_) { /* 无后端 */ }

    if (backendReady) {
      try {
        const res = await fetch('./api/health', { cache: 'no-store' });
        this.backendInfo = await res.json();
      } catch (_) { this.backendInfo = null; }
    } else {
      // 无后端时使用静态内置能力目录（完整供应商，见 js/ai/catalog.js）
      const injected = window.__STARRY_INLINE__;
      if (injected?.catalog) {
        this.catalog = injected.catalog;
        state.catalog = injected.catalog;
        this.backend = false;
      }
    }

    // 兜底：既无后端也无内联目录时，至少保证界面不崩
    if (!this.catalog) {
      this.catalog = FALLBACK_CATALOG;
      state.catalog = FALLBACK_CATALOG;
    }

    state.backend = this.backend;
    state.backendInfo = this.backendInfo;
    bus.emit('ai:ready', { backend: this.backend, catalog: this.catalog });
    return this.catalog;
  },

  /* ---------------- 通用调用（带自动回退） ---------------- */
  async call(capability, payload = {}, opts = {}) {
    const { allowFallback = state.settings.ai.autoFallback !== false, onAttempt = null, preferred = null } = opts;
    const routes = preferred ? [preferred, ...availableRoutes(capability).filter((r) => r.provider !== preferred.provider)] : availableRoutes(capability);
    if (!routes.length) {
      throw new AiClientError('no_route', `没有可用于「${capability}」的通道`, '请在「设置 → AI 接口」里配置一个供应商，或切换到本地引擎');
    }
    let lastErr = null;
    const tried = [];
    for (const route of routes) {
      if (!allowFallback && route !== routes[0]) break;
      if (route.provider !== 'local' && !route.credential?.key && needsKey(route.provider)) {
        tried.push({ provider: route.provider, skipped: 'no_key' });
        continue;
      }
      if (route.provider !== 'local' && !capabilitySupportedBy(capability, route.provider)) {
        tried.push({ provider: route.provider, skipped: 'unsupported' });
        continue;
      }
      try {
        onAttempt?.({ route, attempt: tried.length + 1 });
        const result = await this._invoke(capability, payload, route);
        if (tried.length && capability !== 'chat') {
          toast(`已由「${providerLabel(route.provider)}」完成`, { type: 'ok', timeout: 2200 });
        }
        result.__route = route;
        result.__tried = tried;
        return result;
      } catch (err) {
        lastErr = err;
        tried.push({ provider: route.provider, error: err.code || 'error', message: err.message });
        bus.emit('ai:attempt-failed', { capability, route, err });
        if (!allowFallback) break;
        // 用户输入类错误（提示词为空、内容策略）不值得换通道重试
        if (['bad_request', 'content_policy', 'abort'].includes(err.code)) break;
      }
    }
    if (lastErr) {
      lastErr.tried = tried;
      throw lastErr;
    }
    throw new AiClientError('no_route', `没有可用通道完成「${capability}」`, tried.map((t) => `${providerLabel(t.provider)}：${t.skipped || t.error}`).join('；'));
  },

  async _invoke(capability, payload, route) {
    if (route.provider === 'local') return this._invokeLocal(capability, payload, route);
    // 免费文本通道只收纯文本 messages：带图提问统一在这里先跑本地看图理解并剥离
    // 图片块，之后无论直连还是走后端代理，上游都不会再因 image_url 返回 400/500
    if (capability === 'chat' && route.provider === 'pollinations') {
      const prepared = await this._prepareFreeChatMessages(payload);
      payload = { ...payload, messages: prepared.messages, __localVisionNote: prepared.note };
    }
    let out;
    if (this.backend) out = await this._invokeBackend(capability, payload, route);
    else out = await this._invokeDirect(capability, payload, route);
    // 统一去水印：任何通道返回的图片（出图/抠图/超分）都过一遍角落水印清除，
    // 确保画布与下载得到的任何图片都不含水印、不残留 logo
    if (capability === 'image' && Array.isArray(out.images)) {
      out.images = await Promise.all(out.images.map(async (u) => (typeof u === 'string' ? await stripWatermark(u, route.provider) : u)));
    } else if ((capability === 'image' || capability === 'upscale' || capability === 'matting') && typeof out.image === 'string') {
      out.image = await stripWatermark(out.image, route.provider);
    }
    return out;
  },

  async _invokeLocal(capability, payload, route) {
    const fn = localEngines[capability];
    if (typeof fn !== 'function') {
      throw new AiClientError('no_local', `本地引擎不支持「${capability}」`, '请在设置里为该能力配置云端接口');
    }
    return fn(payload, route);
  },

  /* ---------------- 走后端代理 ---------------- */
  async _invokeBackend(capability, payload, route) {
    const headers = { 'Content-Type': 'application/json' };
    if (route.credential?.key) headers['x-ai-key'] = route.credential.key;
    if (route.credential?.secret) headers['x-ai-secret'] = route.credential.secret;
    if (route.credential?.baseUrl) headers['x-ai-base-url'] = route.credential.baseUrl;

    let res;
    try {
      res = await fetch(`./api/ai/${capability}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, provider: route.provider, model: route.model || payload.model })
      });
    } catch (err) {
      throw new AiClientError('network', `无法连接本地服务：${err.message}`, '请确认已运行 node server.js，然后刷新页面');
    }

    if (payload.stream && capability === 'chat') {
      if (!res.ok || !(res.headers.get('content-type') || '').includes('event-stream')) {
        throw await this._parseError(res, capability);
      }
      return { stream: res.body, raw: res, localVision: payload.__localVisionNote || '' };
    }

    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      const e = json?.error || {};
      throw new AiClientError(e.code || 'upstream', e.message || `后端返回 ${res.status}`, e.hint || '', { fallbacks: json?.fallbacks });
    }
    const data = json.data || {};
    if (payload.__localVisionNote) {
      data.localVision = payload.__localVisionNote;
      if (typeof data.model === 'string' && data.model) data.model += ' + 本地看图理解';
    }
    // 后端返回的图片若是裸 base64（imageBase64=true），统一补上 dataURL 前缀，
    // 让出图、抠图、超分的结果都能被画布 / readImage 直接消费
    if (data.imageBase64 === true) {
      const mime = data.mime || 'image/png';
      if (Array.isArray(data.images)) {
        data.images = data.images.map((b) => (typeof b === 'string' && !b.startsWith('data:') ? `data:${mime};base64,${b}` : b));
      }
      if (typeof data.image === 'string' && data.image && !data.image.startsWith('data:')) {
        data.image = `data:${mime};base64,${data.image}`;
      }
      delete data.imageBase64;
    }
    return data;
  },

  async _parseError(res, capability) {
    const text = await res.text().catch(() => '');
    let e = {};
    try { e = JSON.parse(text).error || {}; } catch (_) { e = { message: text.slice(0, 200) }; }
    return new AiClientError(e.code || 'upstream', e.message || `${capability} 请求失败（${res.status}）`, e.hint || '');
  },

  /**
   * 免费文本通道只吃纯文本 messages：把附带的图片交给本地「看图理解」引擎转成
   * 客观描述后作为系统上下文注入，既保住"带图提问"能力，又不上传原图、不花钱。
   * @returns {Promise<{messages:Array, note:string}>}
   */
  async _prepareFreeChatMessages(payload) {
    const raw = Array.isArray(payload.messages) && payload.messages.length
      ? payload.messages
      : [{ role: 'user', content: payload.prompt || '' }];
    const img = payload.image || pickFirstImageUrl(raw);
    if (!img) return { messages: raw, note: '' };

    // 去掉 image_url 块，只保留文本，避免上游 400
    const messages = raw
      .map((m) => (Array.isArray(m.content)
        ? { role: m.role, content: m.content.filter((c) => c && c.type !== 'image_url').map((c) => (c && c.text) || '').join('\n').trim() }
        : { role: m.role, content: m.content }))
      .filter((m) => m.content);

    let note = '';
    if (typeof localEngines.vision === 'function') {
      try {
        const r = await localEngines.vision({ image: img, prompt: payload.prompt || '' });
        note = String((r && r.text) || '').trim();
      } catch (_) { /* 本地分析失败就退化为纯文本对话 */ }
    }
    if (note) {
      messages.unshift({
        role: 'system',
        content: '用户随消息附带了一张图片。下面是本地离线图像分析引擎给出的客观描述：\n'
          + note.slice(0, 2600)
          + '\n请基于这段描述回答用户的问题；涉及主观审美或需要真正视觉模型的判断时，说明当前依据的是本地图像分析结果。'
      });
    }
    return { messages, note };
  },

  /* ---------------- 无后端时直连（仅免费通道可靠） ---------------- */
  async _invokeDirect(capability, payload, route) {
    const cred = route.credential || {};
    if (route.provider === 'pollinations') {
      if (capability === 'chat') {
        // 图片已在 _invoke 里统一剥离并转为本地看图理解上下文，这里直接用纯文本消息
        const visionNote = payload.__localVisionNote || '';
        const res = await fetch('https://text.pollinations.ai/openai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cred.key ? { Authorization: `Bearer ${cred.key}` } : {}) },
          body: JSON.stringify({
            model: route.model || 'openai',
            messages: payload.messages || [{ role: 'user', content: payload.prompt || '' }],
            private: true,
            stream: !!payload.stream
          })
        });
        if (!res.ok) throw new AiClientError('upstream', `免费模型返回 ${res.status}`, '免费通道可能限流，稍后重试或配置自备 Key');
        if (payload.stream) return { stream: res.body, raw: res, localVision: visionNote };
        const json = await res.json().catch(() => null);
        const content = json?.choices?.[0]?.message?.content;
        return {
          text: typeof content === 'string' ? content.trim() : '',
          model: (json?.model || route.model || '') + (visionNote ? ' + 本地看图理解' : ''),
          localVision: visionNote
        };
      }
      if (capability === 'image') {
        const params = new URLSearchParams({
          width: String(payload.width || 1024),
          height: String(payload.height || 1024),
          model: route.model || 'sana',
          nologo: 'true',
          private: 'true',
          seed: String(payload.seed ?? Math.floor(Math.random() * 99999999))
        });
        if (payload.negativePrompt) params.set('negative', String(payload.negativePrompt).slice(0, 300));
        const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(payload.prompt || '')}?${params}`;
        const res = await fetch(url, { headers: cred.key ? { Authorization: `Bearer ${cred.key}` } : {} });
        if (!res.ok) throw new AiClientError('upstream', `免费文生图返回 ${res.status}`, '免费通道可能限流，稍后重试');
        const blob = await res.blob();
        return { images: [await blobToDataUrlLocal(blob)], width: payload.width, height: payload.height, model: route.model || 'sana' };
      }
      throw new AiClientError('unsupported', `免费通道不支持「${capability}」`, '请在设置里为它配置一个自备 Key 的供应商');
    }

    // 自备 Key 直连：多数厂商不允许浏览器跨域，这里给出可诊断的错误
    if (!cred.key) throw new AiClientError('no_key', `${providerLabel(route.provider)}需要 API Key`, '在「设置 → AI 接口」中填写；或改用免费模型 / 本地引擎');
    try {
      if (capability === 'chat' || capability === 'vision') {
        const base = (cred.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
        const res = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cred.key}` },
          body: JSON.stringify({
            model: route.model,
            messages: capability === 'vision'
              ? [{ role: 'user', content: [{ type: 'text', text: payload.prompt || '描述这张图' }, { type: 'image_url', image_url: { url: payload.image } }] }]
              : payload.messages,
            stream: !!payload.stream
          })
        });
        if (!res.ok) throw new AiClientError('upstream', `供应商返回 ${res.status}`, await res.text().then((t) => t.slice(0, 160)).catch(() => ''));
        if (payload.stream) return { stream: res.body, raw: res };
        const json = await res.json();
        return { text: (json?.choices?.[0]?.message?.content || '').trim(), model: json?.model };
      }
      throw new AiClientError('unsupported', `单文件版无法直连「${capability}」`, '该能力需要后端代理：请运行完整版（node server.js），或改用本地引擎');
    } catch (err) {
      if (err instanceof AiClientError) throw err;
      throw new AiClientError('cors', `浏览器拦截了对该供应商的直连请求`, '厂商接口通常禁止网页跨域调用。请改用完整版（node server.js）由后端代理转发，或先用免费模型 / 本地引擎', { cause: String(err.message || err) });
    }
  },

  /* ---------------- 六个能力的语义化封装 ---------------- */

  chat(opts) { return this.call('chat', opts, { preferred: opts.route, allowFallback: opts.allowFallback !== false }); },
  image(opts) { return this.call('image', opts, { preferred: opts.route, onAttempt: opts.onAttempt }); },
  vision(opts) { return this.call('vision', opts, { preferred: opts.route, onAttempt: opts.onAttempt }); },
  upscale(opts) { return this.call('upscale', opts, { preferred: opts.route, onAttempt: opts.onAttempt }); },
  matting(opts) { return this.call('matting', opts, { preferred: opts.route, onAttempt: opts.onAttempt }); },
  video(opts) { return this.call('video', opts, { preferred: opts.route, onAttempt: opts.onAttempt }); },

  async listModels(route) {
    const r = route || routeFor('chat');
    if (this.backend) {
      const res = await fetch('./api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(r.credential.key ? { 'x-ai-key': r.credential.key } : {}), ...(r.credential.baseUrl ? { 'x-ai-base-url': r.credential.baseUrl } : {}) },
        body: JSON.stringify({ provider: r.provider })
      });
      const json = await res.json();
      if (!json.ok) throw new AiClientError(json.error?.code || 'upstream', json.error?.message || '拉取失败', json.error?.hint || '');
      return json.data.models || [];
    }
    const base = (r.credential.baseUrl || '').replace(/\/+$/, '');
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${r.credential.key}` } });
    if (!res.ok) throw new AiClientError('upstream', `拉取模型列表失败（${res.status}）`, '');
    const json = await res.json();
    return (json.data || []).map((m) => m.id).sort();
  },

  /** 连通性测试：对话通道发一句最短消息 */
  async testRoute(capability, route) {
    const t0 = Date.now();
    if (capability === 'chat') {
      const r = await this._invoke('chat', { messages: [{ role: 'user', content: 'ping' }], stream: false }, route);
      return { ok: true, ms: Date.now() - t0, detail: (r.text || '').slice(0, 40), model: r.model };
    }
    if (capability === 'image') {
      const r = await this._invoke('image', { prompt: 'a tiny blue star, minimal', width: 256, height: 256 }, route);
      return { ok: true, ms: Date.now() - t0, detail: r.images?.length ? '出图成功' : '无图片返回', model: r.model };
    }
    if (capability === 'models') {
      const models = await this.listModels(route);
      return { ok: true, ms: Date.now() - t0, detail: `${models.length} 个模型` };
    }
    return { ok: false, ms: 0, detail: '该能力需要真实图片输入，请在画布上双击图片测试' };
  }
};

async function blobToDataUrlLocal(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('blob 转 dataURL 失败'));
    fr.readAsDataURL(blob);
  });
}

function needsKey(providerId) {
  const p = state.catalog?.providers?.find((x) => x.id === providerId);
  return !!p?.needsKey;
}

/* ------------------------------------------------------------------ *
 * 水印 / logo 清除（浏览器端，Canvas 像素级内容感知）
 * ------------------------------------------------------------------ */
/**
 * 检测并去除图片角落的品牌水印 / logo。
 * 策略：在图片「右下角」底部条带区域内寻找「浅色/白色文字型」像素簇，
 * 若存在则用上方邻域颜色做中值填充覆盖，实现视觉无痕去水印。
 * 仅当确实检测到疑似水印时才会改动图片；干净图片原样返回，零误伤。
 */
async function stripWatermark(dataUrl, providerHint) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image')) return dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('load fail'));
      im.src = dataUrl;
    });
    if (!img.naturalWidth || !img.naturalHeight) return dataUrl;
    const w = img.naturalWidth, h = img.naturalHeight;
    if (w < 200 || h < 200) return dataUrl; // 小图不值得处理

    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    let id = ctx.getImageData(0, 0, w, h);
    let px = id.data;

    // 关注条带：右下角底部约 7% 高度、右 35% 宽度（Pollinations / 多数厂商 logo 落在此）
    const bandY0 = Math.floor(h * 0.88);
    const bandX0 = Math.floor(w * 0.62);
    const ly = h - bandY0;   // 条带高度
    const lx = w - bandX0;   // 条带宽度

    // 1) 统计条带内「浅色前景」（>200 三通道）像素，判定是否为水印文字行
    let bright = 0, total = 0;
    const rowBright = new Array(ly).fill(0);
    const colBright = new Array(lx).fill(0);
    for (let y = 0; y < ly; y++) {
      for (let x = 0; x < lx; x++) {
        const yy = bandY0 + y, xx = bandX0 + x;
        const i = (yy * w + xx) * 4;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        total++;
        if (r > 195 && g > 195 && b > 195) { bright++; rowBright[y]++; colBright[x]++; }
      }
    }
    const ratio = bright / total;
    // 水印的浅色像素占比通常 1%–18%；低于 0.5% 说明无文字 logo，直接返回原图
    if (ratio < 0.005 || ratio > 0.35) return dataUrl;

    // 2) 定位「水印行」：把条带按行切成几段，取浅色最密集的连续行区间
    let bestTop = -1, bestBot = -1, bestScore = 0;
    for (let y = 0; y < ly; y++) {
      let score = 0;
      for (let yy = y; yy < ly && yy < y + Math.floor(ly * 0.5); yy++) score += rowBright[yy];
      if (score > bestScore) { bestScore = score; bestTop = y; bestBot = Math.min(ly, y + Math.floor(ly * 0.5)); }
    }
    if (bestScore === 0) return dataUrl;

    // 3) 水印区域 = 条带里从 bestTop 到 bestBot，右端 bandX0..w（logo 几乎总贴右下）
    const regX0 = bandX0, regX1 = w, regY0 = bandY0 + bestTop, regY1 = bandY0 + bestBot;
    const regW = regX1 - regX0, regH = regY1 - regY0;
    if (regW < 2 || regH < 2) return dataUrl;

    // 4) 用「水印区域上方一行」的采样色做中值填充（保持背景连续，视觉无痕）
    //    对每个水印像素：若它比上邻像素“更浅”且“与上方差异大”，视为水印前景并替换为上邻色；
    //    否则保留（可能是主体的一部分）。
    const fillRow = Math.max(0, regY0 - Math.max(1, Math.floor(regH * 0.3)));
    let changed = 0;
    const N = Math.max(2, Math.floor(regH * 0.2));
    for (let y = regY0; y < regY1; y++) {
      // 逐列取该列上方条带的代表色（中值）
      for (let x = regX0; x < regX1; x++) {
        const idx = (y * w + x) * 4;
        const r = px[idx], g = px[idx + 1], b = px[idx + 2];
        // 水印前景 = 高亮且与局部上方有明确反差
        if (r > 175 && g > 175 && b > 175) {
          // 取该像素上方 1~N 行、同列 ±3px 的中值颜色
          const samples = [];
          for (let k = 1; k <= N; k++) {
            const sy = y - k; if (sy < 0) continue;
            for (let dx = -3; dx <= 3; dx++) {
              const sx = x + dx; if (sx < 0 || sx >= w) continue;
              const si = (sy * w + sx) * 4;
              samples.push([px[si], px[si + 1], px[si + 2]]);
            }
          }
          if (samples.length) {
            const med = medianColor(samples);
            // 与上方代表色差异足够大才替换（防止误伤主体的浅色像素）
            const dR = r - med[0], dG = g - med[1], dB = b - med[2];
            if (dR + dG + dB > 120) {
              px[idx] = med[0]; px[idx + 1] = med[1]; px[idx + 2] = med[2]; px[idx + 3] = 255;
              changed++;
            }
          }
        }
      }
    }
    if (changed < Math.max(8, (regW * regH) * 0.01)) return dataUrl; // 改动太少视为无意义，返回原图

    ctx.putImageData(id, 0, 0);
    const mime = (dataUrl.match(/^data:([^;]+)/) || [])[1] || 'image/png';
    return cv.toDataURL(mime, 0.92);
  } catch (_) {
    return dataUrl;
  }
}

function medianColor(samples) {
  samples.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
  const m = samples[Math.floor(samples.length / 2)];
  return [m[0], m[1], m[2]];
}

/* ------------------------------------------------------------------ *
 * SSE 解析：后端透传与直连都适用
 * ------------------------------------------------------------------ */

export async function readSseStream(body, { onDelta, onDone, signal } = {}) {
  if (!body) { onDone?.(''); return ''; }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json = null;
        try { json = JSON.parse(data); } catch (_) { continue; }
        if (json.error) {
          throw new AiClientError('stream', json.error.message || '流式返回错误', json.error.hint || '');
        }
        const delta = json.choices?.[0]?.delta?.content
          ?? json.choices?.[0]?.message?.content
          ?? json.delta?.text ?? '';
        if (delta) { full += delta; onDelta?.(delta, full); }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* 已释放 */ }
  }
  onDone?.(full);
  return full;
}

/** 非流式兜底解析（供应商不支持 stream 时） */
export function extractText(json) {
  const m = json?.choices?.[0]?.message;
  if (typeof m?.content === 'string') return m.content;
  if (Array.isArray(m?.content)) return m.content.map((c) => c.text || '').join('');
  return json?.text || '';
}

/* ------------------------------------------------------------------ *
 * 极端兜底目录：后端与内联目录都拿不到时，保证界面可用
 * ------------------------------------------------------------------ */
const FALLBACK_CATALOG = {
  version: 'fallback',
  capabilities: [{ id: 'chat' }, { id: 'image' }, { id: 'vision' }, { id: 'upscale' }, { id: 'matting' }, { id: 'video' }],
  providers: [
    { id: 'pollinations', label: 'Pollinations 免费模型', kind: 'free', needsKey: false, capabilities: { chat: { defaultModel: 'openai', models: [{ id: 'openai', label: 'GPT-OSS 20B' }] }, image: { defaultModel: 'sana', models: [{ id: 'sana', label: 'Sana' }], maxSize: 1536 } } },
    { id: 'local', label: '本地引擎', kind: 'local', needsKey: false, capabilities: { upscale: { defaultModel: 'local-upscale' }, matting: { defaultModel: 'local-matting' }, video: { defaultModel: 'local-video' } } }
  ],
  generationModes: [
    { id: 'main', label: '主图', promptTemplate: '电商主图，{subject}', defaultSize: '1:1', suggestSizes: ['1:1'], postProcess: [] },
    { id: 'whitebg', label: '白底图', promptTemplate: '纯白背景商品图，{subject}', defaultSize: '1:1', suggestSizes: ['1:1'], postProcess: ['whiteBackground'] },
    { id: 'detail', label: '详情页', promptTemplate: '电商详情页配图，{subject}', defaultSize: '3:4', suggestSizes: ['3:4'], postProcess: [] },
    { id: 'video', label: '视频', promptTemplate: '{subject}', defaultSize: '9:16', suggestSizes: ['9:16'], postProcess: [] },
    { id: 'free', label: '自由创作', promptTemplate: '{subject}', defaultSize: '1:1', suggestSizes: ['1:1'], postProcess: [] }
  ],
  sizePresets: [
    { id: '1:1', label: '1:1 方形', ratio: [1, 1], width: 1024, height: 1024 },
    { id: '3:4', label: '3:4 竖版', ratio: [3, 4], width: 896, height: 1152 },
    { id: '16:9', label: '16:9 宽屏', ratio: [16, 9], width: 1280, height: 720 },
    { id: 'custom', label: '自定义尺寸', ratio: null, width: 0, height: 0 }
  ],
  exportFormats: [
    { id: 'png', label: 'PNG', mime: 'image/png' },
    { id: 'jpeg', label: 'JPEG', mime: 'image/jpeg' },
    { id: 'webp', label: 'WebP', mime: 'image/webp' },
    { id: 'json', label: 'JSON 工程存档', mime: 'application/json' }
  ],
  toolRegistry: []
};
