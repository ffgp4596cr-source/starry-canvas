/**
 * 星空画布 · 全局状态与事件总线
 * 负责：节点集合、视口、选区、设置（含 AI 路由与密钥）、主题、本地持久化。
 * 所有跨模块通信都走 bus，避免模块间循环依赖。
 */

import { uid, debounce, toast } from '../ui/dom.js';

/* ------------------------------------------------------------------ *
 * 事件总线
 * ------------------------------------------------------------------ */

class EventBus {
  constructor() { this.map = new Map(); }
  on(evt, fn) {
    if (!this.map.has(evt)) this.map.set(evt, new Set());
    this.map.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  once(evt, fn) {
    const off = this.on(evt, (payload) => { off(); fn(payload); });
    return off;
  }
  off(evt, fn) { this.map.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const set = this.map.get(evt);
    if (!set || !set.size) return;
    for (const fn of Array.from(set)) {
      try { fn(payload); } catch (err) { console.error(`[bus:${evt}]`, err); }
    }
  }
}

export const bus = new EventBus();

/* ------------------------------------------------------------------ *
 * 默认设置
 * ------------------------------------------------------------------ */

const STORAGE_KEY = 'starry-canvas:settings:v1';
const PROJECT_KEY = 'starry-canvas:project:v1';

export const DEFAULT_SETTINGS = {
  theme: 'dark',
  /** 每种能力默认走哪条通道：{ provider, model } */
  ai: {
    routes: {
      chat: { provider: 'pollinations', model: 'openai' },
      image: { provider: 'sd3-gradio', model: 'sd3-medium' },
      vision: { provider: 'openai-compat', model: '' },
      upscale: { provider: 'local', model: 'local-upscale' },
      matting: { provider: 'local', model: 'local-matting' },
      video: { provider: 'local', model: 'local-video' }
    },
    providers: {
      pollinations: { enabled: true, key: '', models: { chat: 'openai', image: 'flux' } },
      'sd3-gradio': { enabled: true, key: '', models: { image: 'sd3-medium' } },
      'openai-compat': { enabled: false, key: '', secret: '', baseUrl: 'https://api.deepseek.com/v1', models: { chat: '', image: '', vision: '', video: '' } },
      'dashscope-native': { enabled: false, key: '', models: { image: 'wanx2.1-t2i-turbo', video: 'wanx2.1-t2v-turbo' } },
      'baidu-aip': { enabled: false, key: '', secret: '', models: { upscale: 'image_super_resolution', matting: 'body_seg' } },
      removebg: { enabled: false, key: '', models: { matting: 'auto' } }
    },
    /** 生成失败时是否自动回退到下一条可用通道 */
    autoFallback: true,
    concurrency: 2
  },
  generate: {
    mode: 'main',
    sizeId: '1:1',
    customW: 1024,
    customH: 1024,
    count: 1,
    negative: '',
    seed: '',
    enhance: true,
    useModeTemplate: true
  },
  export: {
    format: 'png',
    scope: 'node',
    scale: 2,
    quality: 0.92,
    background: 'transparent',
    withMeta: false
  },
  canvas: {
    starfield: true,
    starDensity: 1,
    gridSnap: false,
    gridSize: 40,
    showMeta: true,
    minScale: 0.05,
    maxScale: 12
  },
  chat: {
    systemPrompt: '你是「星空画布」的 AI 创作助手，擅长电商视觉、提示词工程与图像后期。回答简洁、可执行，涉及提示词时直接给出可复制的成品。',
    keepContext: 12,
    stream: true
  },
  autosave: true
};

/* ------------------------------------------------------------------ *
 * 运行时状态
 * ------------------------------------------------------------------ */

export const state = {
  /** @type {Map<string, object>} */
  nodes: new Map(),
  zCounter: 1,
  viewport: { x: 0, y: 0, scale: 1 },
  /** @type {Set<string>} */
  selection: new Set(),
  tool: 'select',
  settings: structuredClone(DEFAULT_SETTINGS),
  catalog: null,
  /** 是否存在后端代理（单文件版为 false） */
  backend: false,
  backendInfo: null,
  /** 剪贴板：节点快照数组 */
  clipboard: null,
  /** 系统剪贴板里的图片（用于跨应用粘贴） */
  lastCopiedImage: null,
  ready: false,
  /** 运行中的任务，便于取消与计数 */
  tasks: new Map(),
  chat: { messages: [], pending: false, attach: null },
  stats: { generated: 0, processed: 0 }
};

/* ------------------------------------------------------------------ *
 * 深合并（用于把已存设置覆盖到默认值上，容忍版本升级）
 * ------------------------------------------------------------------ */

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base)) return Array.isArray(patch) ? patch.slice() : base;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    out[k] = k in base ? deepMerge(base[k], patch[k]) : patch[k];
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.settings = deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
  } catch (err) {
    console.warn('[settings] 读取失败，使用默认设置', err);
    state.settings = structuredClone(DEFAULT_SETTINGS);
  }
  return state.settings;
}

export const saveSettings = debounce(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch (err) {
    console.warn('[settings] 保存失败', err);
  }
}, 300);

export function updateSettings(patch) {
  state.settings = deepMerge(state.settings, patch);
  saveSettings();
  bus.emit('settings:changed', state.settings);
  return state.settings;
}

/* ------------------------------------------------------------------ *
 * 主题
 * ------------------------------------------------------------------ */

export function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  state.settings.theme = t;
  const label = document.getElementById('theme-label');
  if (label) label.textContent = t === 'dark' ? '深空黑' : '极简白';
  saveSettings();
  bus.emit('theme:changed', t);
}

export function toggleTheme() {
  const next = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  toast(next === 'dark' ? '已切换到深空黑' : '已切换到极简白', { type: 'ok', timeout: 1600 });
  return next;
}

/* ------------------------------------------------------------------ *
 * 节点操作
 * ------------------------------------------------------------------ */

export function createNode(partial = {}) {
  const node = {
    id: partial.id || uid('node'),
    type: partial.type || 'image',
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    w: partial.w ?? 320,
    h: partial.h ?? 240,
    rotation: partial.rotation ?? 0,
    z: partial.z ?? ++state.zCounter,
    locked: !!partial.locked,
    hidden: !!partial.hidden,
    data: { ...(partial.data || {}) },
    meta: {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      source: partial.meta?.source || 'create',
      tool: partial.meta?.tool || '',
      title: partial.meta?.title || '',
      ...(partial.meta || {})
    }
  };
  state.nodes.set(node.id, node);
  state.zCounter = Math.max(state.zCounter, node.z);
  bus.emit('node:added', node);
  bus.emit('nodes:changed');
  return node;
}

export function getNode(id) { return state.nodes.get(id); }

export function updateNode(id, patch, opts = {}) {
  const node = state.nodes.get(id);
  if (!node) return null;
  const { silent = false } = opts;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'data' || k === 'meta') Object.assign(node[k], v);
    else node[k] = v;
  }
  node.meta.updatedAt = Date.now();
  if (!silent) {
    bus.emit('node:updated', node);
    bus.emit('nodes:changed');
  }
  return node;
}

export function removeNodes(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  const removed = [];
  for (const id of list) {
    const node = state.nodes.get(id);
    if (!node) continue;
    state.nodes.delete(id);
    state.selection.delete(id);
    removed.push(node);
  }
  if (removed.length) {
    bus.emit('nodes:removed', removed);
    bus.emit('nodes:changed');
  }
  return removed;
}

export function selectedNodes() {
  return Array.from(state.selection).map((id) => state.nodes.get(id)).filter(Boolean);
}

export function firstSelected() {
  return selectedNodes().sort((a, b) => b.z - a.z)[0] || null;
}

export function setSelection(ids, { additive = false } = {}) {
  if (!additive) state.selection.clear();
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    if (!state.nodes.has(id)) continue;
    if (additive && state.selection.has(id)) state.selection.delete(id);
    else state.selection.add(id);
  }
  bus.emit('selection:changed', Array.from(state.selection));
}

export function clearSelection() {
  if (!state.selection.size) return;
  state.selection.clear();
  bus.emit('selection:changed', []);
}

export function bringToFront(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  for (const id of list) {
    const n = state.nodes.get(id);
    if (n) n.z = ++state.zCounter;
  }
  bus.emit('nodes:changed');
}

export function allNodes() { return Array.from(state.nodes.values()); }

export function imageNodes() { return allNodes().filter((n) => n.type === 'image' && n.data.src); }

/* ------------------------------------------------------------------ *
 * 视口
 * ------------------------------------------------------------------ */

export function setViewport(patch) {
  Object.assign(state.viewport, patch);
  bus.emit('viewport:changed', state.viewport);
}

export function screenToWorld(sx, sy) {
  const { x, y, scale } = state.viewport;
  return { x: (sx - x) / scale, y: (sy - y) / scale };
}

export function worldToScreen(wx, wy) {
  const { x, y, scale } = state.viewport;
  return { x: wx * scale + x, y: wy * scale + y };
}

/* ------------------------------------------------------------------ *
 * AI 路由解析
 * ------------------------------------------------------------------ */

export function routeFor(capability) {
  const ai = state.settings.ai;
  const route = ai.routes[capability] || {};
  const providerId = route.provider || DEFAULT_SETTINGS.ai.routes[capability]?.provider || 'local';
  const providerCfg = ai.providers[providerId] || {};
  const model = route.model || providerCfg.models?.[capability] || '';
  const credential = {
    key: providerCfg.key || '',
    secret: providerCfg.secret || '',
    baseUrl: providerCfg.baseUrl || ''
  };
  return { provider: providerId, model, credential, enabled: providerId === 'local' || providerCfg.enabled !== false };
}

/** 某能力当前可用的通道列表（按优先级排序，用于自动回退） */
export function availableRoutes(capability) {
  const ai = state.settings.ai;
  const catalog = state.catalog;
  if (!catalog) return [];
  const out = [];
  const primary = routeFor(capability);
  out.push(primary);
  for (const p of catalog.providers) {
    if (p.id === primary.provider) continue;
    if (!p.capabilities?.[capability]) continue;
    if (p.needsKey && !ai.providers[p.id]?.key) continue;
    if (p.needsKey && ai.providers[p.id]?.enabled === false) continue;
    const cfg = ai.providers[p.id] || {};
    out.push({
      provider: p.id,
      model: cfg.models?.[capability] || p.capabilities[capability].defaultModel || '',
      credential: { key: cfg.key || '', secret: cfg.secret || '', baseUrl: cfg.baseUrl || '' },
      enabled: true
    });
  }
  // 本地引擎永远兜底（若该能力支持）
  const local = catalog.providers.find((p) => p.id === 'local');
  if (local?.capabilities?.[capability] && !out.some((r) => r.provider === 'local')) {
    out.push({ provider: 'local', model: local.capabilities[capability].defaultModel, credential: {}, enabled: true });
  }
  return out;
}

export function providerLabel(id) {
  return state.catalog?.providers?.find((p) => p.id === id)?.label || id;
}

export function capabilitySupportedBy(capability, providerId) {
  const p = state.catalog?.providers?.find((x) => x.id === providerId);
  return !!p?.capabilities?.[capability];
}

/* ------------------------------------------------------------------ *
 * 项目持久化（localStorage，带容量保护）
 * ------------------------------------------------------------------ */

export function serializeProject() {
  return {
    app: '星空画布',
    version: state.catalog?.version || '1.0.0',
    savedAt: new Date().toISOString(),
    viewport: { ...state.viewport },
    zCounter: state.zCounter,
    nodes: allNodes()
      .slice()
      .sort((a, b) => a.z - b.z)
      .map((n) => ({ ...n, data: { ...n.data }, meta: { ...n.meta } }))
  };
}

export function deserializeProject(obj) {
  if (!obj || !Array.isArray(obj.nodes)) throw new Error('工程文件格式不正确');
  state.nodes.clear();
  state.selection.clear();
  state.zCounter = 1;
  for (const raw of obj.nodes) {
    const node = {
      id: raw.id || uid('node'),
      type: raw.type || 'image',
      x: +raw.x || 0, y: +raw.y || 0, w: +raw.w || 320, h: +raw.h || 240,
      rotation: +raw.rotation || 0, z: +raw.z || ++state.zCounter,
      locked: !!raw.locked, hidden: !!raw.hidden,
      data: { ...(raw.data || {}) },
      meta: { createdAt: raw.meta?.createdAt || Date.now(), updatedAt: raw.meta?.updatedAt || Date.now(), ...(raw.meta || {}) }
    };
    state.nodes.set(node.id, node);
    state.zCounter = Math.max(state.zCounter, node.z);
  }
  if (obj.viewport) Object.assign(state.viewport, obj.viewport);
  bus.emit('project:loaded', { count: state.nodes.size });
  bus.emit('nodes:changed');
  bus.emit('viewport:changed', state.viewport);
  return state.nodes.size;
}

export const saveProject = debounce(() => {
  if (!state.settings.autosave) return;
  try {
    const payload = JSON.stringify(serializeProject());
    localStorage.setItem(PROJECT_KEY, payload);
    bus.emit('project:saved', { bytes: payload.length });
  } catch (err) {
    // 配额不足时不要打断创作，只提示一次
    if (err?.name === 'QuotaExceededError' || /quota/i.test(String(err?.message))) {
      state.settings.autosave = false;
      toast('自动保存已暂停：浏览器本地存储空间不足', {
        type: 'warn',
        hint: '画布里的图片较多。建议用「导出 → JSON 工程存档」保存到本地，或删掉不再需要的节点。',
        timeout: 9000
      });
    } else {
      console.warn('[project] 自动保存失败', err);
    }
  }
}, 1200);

export function loadProject() {
  try {
    const raw = localStorage.getItem(PROJECT_KEY);
    if (!raw) return 0;
    return deserializeProject(JSON.parse(raw));
  } catch (err) {
    console.warn('[project] 读取失败', err);
    return 0;
  }
}

export function clearProject() {
  localStorage.removeItem(PROJECT_KEY);
  state.nodes.clear();
  state.selection.clear();
  bus.emit('nodes:changed');
}

/* ------------------------------------------------------------------ *
 * 尺寸换算
 * ------------------------------------------------------------------ */

export function resolveSize(sizeId, customW, customH) {
  const preset = state.catalog?.sizePresets?.find((s) => s.id === sizeId) || state.catalog?.sizePresets?.[0];
  if (!preset) return { width: 1024, height: 1024, label: '1024×1024', ratio: null };
  if (preset.id === 'custom') {
    const w = Math.max(64, Math.round(+customW || 1024));
    const h = Math.max(64, Math.round(+customH || 1024));
    return { width: w, height: h, label: `${w}×${h}`, ratio: null, custom: true };
  }
  return { width: preset.width, height: preset.height, label: `${preset.width}×${preset.height}`, ratio: preset.ratio, presetId: preset.id };
}

export function modeById(id) {
  return state.catalog?.generationModes?.find((m) => m.id === id) || state.catalog?.generationModes?.[0];
}

export function applyModeTemplate(modeId, subject) {
  const mode = modeById(modeId);
  if (!mode) return subject;
  return mode.promptTemplate.replace(/\{subject\}/g, subject || '');
}
