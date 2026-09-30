/**
 * 星空画布 · 设置中心
 * ------------------------------------------------------------------
 * 六个页签：
 *   AI 接口 —— 免费模型 + 自备 Key 的多供应商接入（Key / Base URL / 模型）
 *   能力路由 —— 对话·文生图·看图·变清晰·抠图·视频 各走哪条通道
 *   画布 / 对话 / 快捷键 / 数据
 * 所有改动即时写入 state.settings 并持久化到 localStorage，
 * 通过 bus 'settings:changed' 通知其它模块刷新（通道徽标、路由行、星空背景）。
 */

import {
  state, bus, DEFAULT_SETTINGS, saveSettings, applyTheme,
  providerLabel, serializeProject, deserializeProject, clearProject
} from '../core/state.js';
import { requestBackgroundRedraw, renderAllNodes, fitToContent } from '../core/engine.js';
import { ai } from '../ai/client.js';
import { el, modal, toast, clamp, copyText, downloadBlob, timestampName, humanSize } from '../ui/dom.js';

const CAPS = ['chat', 'image', 'vision', 'upscale', 'matting', 'video'];
const CAP_LABEL = { chat: '智能对话', image: '文生图 / 图生图', vision: '看图理解（反推提示词）', upscale: '变清晰（超分）', matting: '抠图（主体分离）', video: '视频生成' };
const KIND_LABEL = { free: '免费直连', byok: '自备 Key', local: '本地离线' };

const TABS = [
  { id: 'ai', label: 'AI 接口', ico: '🔌' },
  { id: 'routes', label: '能力路由', ico: '🧭' },
  { id: 'canvas', label: '画布', ico: '🌌' },
  { id: 'chat', label: '对话', ico: '💬' },
  { id: 'keys', label: '快捷键', ico: '⌨' },
  { id: 'data', label: '数据', ico: '💾' }
];

const SHORTCUTS = [
  ['空格 + 拖拽 / 中键拖拽', '平移画布'], ['滚轮 / Ctrl 滚轮', '缩放（以光标为中心）'],
  ['双击图片节点', '打开工具菜单'], ['双击空白处', '新建文本节点'],
  ['Ctrl V', '粘贴剪贴板图片'], ['Ctrl C', '复制选中图片到系统剪贴板'],
  ['Ctrl D', '在画布内复制选中节点'], ['Ctrl A', '全选'],
  ['Ctrl Z / Ctrl Shift Z', '撤销 / 重做'], ['Delete', '删除选中'],
  ['Ctrl G', 'AI 生成（提示词 + 模式 + 尺寸）'], ['Ctrl E', '导出下载（自选格式）'],
  ['Ctrl K', '智能对话'], ['Ctrl P', '提示词工坊（输出 / 反推）'],
  ['Ctrl J', '切换明暗主题'], ['Ctrl ,', '打开设置'],
  ['Shift 1 / Shift 0', '适应全部内容 / 回到 100%'], ['Esc', '关闭弹窗 / 取消选择'],
  ['方向键', '微调选中节点位置'], ['Ctrl S', '保存工程存档']
];

/* ================================================================== *
 * 小工具
 * ================================================================== */

function catProvider(id) {
  return (state.catalog && state.catalog.providers ? state.catalog.providers : []).find((p) => p.id === id) || null;
}

function cfgOf(id) {
  if (!state.settings.ai.providers[id]) {
    const d = (DEFAULT_SETTINGS.ai.providers[id] || { enabled: false, key: '', models: {} });
    state.settings.ai.providers[id] = JSON.parse(JSON.stringify(d));
  }
  const c = state.settings.ai.providers[id];
  if (!c.models) c.models = {};
  return c;
}

function commit(section) {
  saveSettings();
  bus.emit('settings:changed', { section: section || 'ai' });
}

function switchEl(isOn, onChange) {
  const s = el('div.switch' + (isOn ? '.on' : ''), { role: 'switch', tabindex: '0', 'aria-checked': String(!!isOn) });
  const flip = () => {
    const v = !s.classList.contains('on');
    s.classList.toggle('on', v);
    s.setAttribute('aria-checked', String(v));
    onChange(v);
  };
  s.addEventListener('click', flip);
  s.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); flip(); }
  });
  return s;
}

function rowSwitch(label, hint, get, set) {
  return el('div.row.between', { style: { padding: '8px 0', gap: '12px' } }, [
    el('div.grow', {}, [
      el('div', { text: label, style: { fontSize: '12.5px', color: 'var(--text-1)' } }),
      hint ? el('div.muted', { text: hint, style: { fontSize: '11px', marginTop: '2px' } }) : null
    ]),
    switchEl(get(), set)
  ]);
}

function sliderRow(label, min, max, step, get, set, fmt) {
  const val = el('span.slider-val', { text: fmt(get()) });
  const inp = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
  inp.addEventListener('input', () => { const v = Number(inp.value); val.textContent = fmt(v); set(v); });
  return el('div.field', {}, [el('label.lbl', { text: label }), el('div.slider-row', {}, inp, val)]);
}

function statusDot(kind) {
  return el('span.rl-dot' + (kind === 'ok' ? '' : '.' + kind));
}

function keyField(label, value, onInput, placeholder) {
  const inp = el('input.input', { type: 'password', value: value || '', placeholder: placeholder || '', autocomplete: 'off', spellcheck: 'false' });
  inp.addEventListener('input', () => onInput(inp.value.trim()));
  const eye = el('button.icon-btn', { text: '👁', title: '显示 / 隐藏', onclick: () => { inp.type = inp.type === 'password' ? 'text' : 'password'; } });
  return el('div.field', {}, [
    el('label.lbl', { text: label }),
    el('div.inline-row', { style: { gap: '6px' } }, [inp, eye])
  ]);
}

function modelField(providerId, cap, models, onChange) {
  const cfg = cfgOf(providerId);
  const listId = 'dl-' + providerId + '-' + cap;
  const dl = el('datalist', { id: listId }, (models || []).map((m) => el('option', { value: typeof m === 'string' ? m : m.id, label: typeof m === 'string' ? m : (m.label || m.id) })));
  const inp = el('input.input', { type: 'text', list: listId, value: cfg.models[cap] || '', placeholder: '模型名（可下拉选择或手填）', spellcheck: 'false' });
  inp.addEventListener('change', () => { cfg.models[cap] = inp.value.trim(); onChange(inp.value.trim()); });
  return {
    node: el('div.field', {}, [el('label.lbl', { text: CAP_LABEL[cap] + ' 模型' }), inp, dl]),
    addOptions(ids) {
      (ids || []).forEach((id) => {
        if (!Array.from(dl.options).some((o) => o.value === id)) dl.appendChild(el('option', { value: id }));
      });
    },
    setValue(v) { inp.value = v || ''; cfg.models[cap] = v || ''; }
  };
}

/* ================================================================== *
 * 状态判定（供设置面板、路由表、左下角通道徽标共用）
 * ================================================================== */

export function providerStatus(id) {
  const p = catProvider(id);
  if (!p) return { kind: 'err', text: '目录中不存在该供应商' };
  if (p.id === 'local') return { kind: 'ok', text: '浏览器本地计算，离线可用' };
  const cfg = cfgOf(id);
  if (cfg.enabled === false) return { kind: 'warn', text: '已关闭' };
  if (p.needsKey && !cfg.key) return { kind: 'err', text: '缺 API Key' };
  if (p.needsSecret && !cfg.secret) return { kind: 'err', text: '缺 Secret Key' };
  if (!ai.backend && p.kind === 'byok' && id !== 'openai-compat') return { kind: 'warn', text: '需后端代理（node server.js）' };
  return { kind: 'ok', text: '就绪' };
}

export function routeStatus(cap) {
  const r = state.settings.ai.routes[cap] || {};
  const id = r.provider || 'local';
  const p = catProvider(id);
  if (!p) return { kind: 'err', text: '通道不存在' };
  if (id === 'local') return { kind: 'ok', text: '本地引擎（离线可用）' };
  if (!p.capabilities || !p.capabilities[cap]) return { kind: 'err', text: '该供应商不支持此能力' };
  const cfg = cfgOf(id);
  if (cfg.enabled === false) return { kind: 'warn', text: '供应商已关闭' };
  if (p.needsKey && !cfg.key) return { kind: 'err', text: '缺 API Key' };
  const model = r.model || cfg.models[cap] || (p.capabilities[cap] && p.capabilities[cap].defaultModel) || '';
  if (!model && id === 'openai-compat') return { kind: 'warn', text: '未指定模型名' };
  return { kind: 'ok', text: (providerLabel(id) + (model ? ' · ' + model : '')) };
}

/** 左下角徽标用的一句话概述 */
export function engineSummary() {
  const img = routeStatus('image');
  const chat = routeStatus('chat');
  const free = (cfgOf('pollinations').enabled !== false);
  const byok = Object.keys(state.settings.ai.providers).filter((k) => k !== 'pollinations' && k !== 'local' && cfgOf(k).enabled !== false && cfgOf(k).key);
  if (byok.length) return '已接入 ' + byok.length + ' 个自备接口';
  if (free) return '免费模型';
  return chat.kind === 'err' && img.kind === 'err' ? '未配置通道' : '本地引擎';
}

/* ================================================================== *
 * 模型列表拉取 + 连通测试
 * ================================================================== */

function credHeaders(id) {
  const cfg = cfgOf(id);
  const h = { 'Content-Type': 'application/json' };
  if (cfg.key) h['x-ai-key'] = cfg.key;
  if (cfg.secret) h['x-ai-secret'] = cfg.secret;
  if (cfg.baseUrl) h['x-ai-base-url'] = cfg.baseUrl;
  return h;
}

export async function fetchProviderModels(id) {
  if (id === 'pollinations') {
    const [t, i] = await Promise.all([
      fetch('https://text.pollinations.ai/models', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
      fetch('https://image.pollinations.ai/models', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => [])
    ]);
    const norm = (arr) => (Array.isArray(arr) ? arr.map((x) => (typeof x === 'string' ? x : (x.name || x.id))).filter(Boolean) : []);
    const chat = norm(t);
    const image = norm(i);
    if (!chat.length && !image.length) throw new Error('免费模型列表暂时取不到（可能被限流），可直接手填 openai / flux / sana');
    return { chat: chat, image: image, count: chat.length + image.length };
  }
  if (!ai.backend) {
    throw new Error('未连接后端代理，无法拉取该供应商模型列表。请运行 node server.js 后刷新，或直接在输入框手填模型名');
  }
  const res = await fetch('./api/ai/models', {
    method: 'POST',
    headers: credHeaders(id),
    body: JSON.stringify({ provider: id })
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.ok === false) {
    const e = (json && json.error) || {};
    throw new Error(e.message || ('拉取失败（HTTP ' + res.status + '）'));
  }
  const models = (json.data && json.data.models) || [];
  return { all: models, chat: models, image: models, vision: models, video: models, count: models.length };
}

export async function testProvider(id) {
  const p = catProvider(id);
  if (!p) throw new Error('供应商不存在');
  if (id === 'local') return { text: '本地引擎在浏览器内运行，无需连通测试（变清晰 / 抠图 / 帧合成视频均离线可用）', kind: 'ok' };
  const cfg = cfgOf(id);
  if (p.needsKey && !cfg.key) throw new Error('请先填写 API Key');

  // 有模型列表接口的先拉一次，既是连通测试又能填充下拉
  if (id === 'openai-compat' || id === 'pollinations') {
    try {
      const got = await fetchProviderModels(id);
      return { text: '连通正常，取到 ' + got.count + ' 个模型', kind: 'ok', models: got };
    } catch (err) {
      if (id === 'pollinations') throw err;
      // openai-compat 拉不到列表时退化为一次最小对话
    }
  }

  const cap = CAPS.find((c) => p.capabilities && p.capabilities[c]);
  if (!cap) throw new Error('该供应商没有可用能力');
  const model = cfg.models[cap] || (p.capabilities[cap] && p.capabilities[cap].defaultModel) || '';
  const route = { provider: id, model: model, credential: { key: cfg.key, secret: cfg.secret, baseUrl: cfg.baseUrl }, enabled: true };
  const t0 = performance.now();
  if (cap === 'chat' || cap === 'vision') {
    const res = await ai.call('chat', {
      messages: [{ role: 'user', content: '连通性测试，请只回复两个字：正常' }],
      prompt: '连通性测试，请只回复两个字：正常',
      stream: false
    }, { preferred: route, allowFallback: false });
    const text = (res && res.text ? String(res.text) : '').slice(0, 40);
    return { text: '连通正常 · ' + Math.round(performance.now() - t0) + 'ms · 回复「' + (text || '空') + '」', kind: 'ok' };
  }
  if (cap === 'image') {
    const res = await ai.call('image', { prompt: 'a single blue dot on white background', width: 256, height: 256, n: 1 }, { preferred: route, allowFallback: false });
    const imgs = (res && (res.images || res.imageUrls)) || [];
    if (!imgs.length) throw new Error((res && res.message) || '接口没有返回图片');
    return { text: '连通正常 · ' + Math.round(performance.now() - t0) + 'ms · 返回 1 张测试图', kind: 'ok' };
  }
  if (cap === 'video') {
    return { text: '接口可达（视频生成耗时较长，未实际出片）。模型：' + (model || '默认'), kind: 'ok' };
  }
  return { text: '接口可达 · 能力 ' + cap + ' · 模型 ' + (model || '默认'), kind: 'ok' };
}

/* ================================================================== *
 * 设置主对话框
 * ================================================================== */

let settingsModal = null;

export function openSettings(tab = 'ai') {
  if (settingsModal) { settingsModal.close(); }
  let current = TABS.some((t) => t.id === tab) ? tab : 'ai';

  const pane = el('div.set-pane');
  const nav = el('div.set-nav');

  function renderNav() {
    nav.textContent = '';
    TABS.forEach((t) => {
      const dotKind = t.id === 'ai' ? worstProviderKind() : (t.id === 'routes' ? worstRouteKind() : null);
      nav.appendChild(el('button.set-nav-item' + (current === t.id ? '.active' : ''), {
        type: 'button',
        onclick: () => { current = t.id; renderNav(); renderPane(); }
      }, [
        el('span', { text: t.ico + ' ' + t.label }),
        dotKind ? el('span.sn-dot', { style: { background: dotKind === 'err' ? 'var(--err)' : 'var(--warn)' } }) : null
      ]));
    });
  }

  function renderPane() {
    pane.textContent = '';
    const builders = { ai: paneAi, routes: paneRoutes, canvas: paneCanvas, chat: paneChat, keys: paneKeys, data: paneData };
    (builders[current] || paneAi)(pane);
  }

  settingsModal = modal({
    title: '设置',
    sub: '接入自备 API、启用免费模型、分配能力通道',
    size: 'wide',
    onClose: () => { settingsModal = null; commit('ai'); },
    body: el('div.set-layout', {}, [nav, pane]),
    footer: [
      el('div.grow.muted', { style: { fontSize: '11px' }, text: 'Key 只保存在本机浏览器 localStorage，请求时通过 Header 传给本地后端代理，不写入任何文件' }),
      el('button.btn.primary', { text: '完成', onclick: () => settingsModal.close() })
    ]
  });

  renderNav();
  renderPane();
  return settingsModal;
}

export function openHelp() { openSettings('keys'); }

function worstProviderKind() {
  let worst = null;
  for (const p of (state.catalog ? state.catalog.providers : [])) {
    if (p.kind !== 'byok') continue;
    const cfg = cfgOf(p.id);
    if (cfg.enabled === false || !cfg.key) continue;
    const st = providerStatus(p.id);
    if (st.kind === 'err') return 'err';
    if (st.kind === 'warn') worst = 'warn';
  }
  return worst;
}

function worstRouteKind() {
  let worst = null;
  for (const cap of CAPS) {
    const st = routeStatus(cap);
    if (st.kind === 'err') return 'err';
    if (st.kind === 'warn') worst = 'warn';
  }
  return worst;
}

/* ------------------------------------------------------------------ *
 * 页签 1：AI 接口
 * ------------------------------------------------------------------ */

function paneAi(host) {
  host.appendChild(el('div.notice.info', { style: { marginBottom: '12px' } }, [
    el('span.n-ico', { text: 'ⓘ' }),
    el('div.n-body', {}, [
      el('div', { text: '开箱即用：Pollinations 免费模型（对话 + 文生图）与本地引擎（变清晰 / 抠图 / 视频合成）无需任何 Key。' }),
      el('div', { style: { marginTop: '3px' }, text: '需要更强能力（看图反推提示词、真实文生视频、专业抠图）时，在下方填入你自己的 API Key 即可直连接口。' })
    ])
  ]));

  if (!ai.backend) {
    host.appendChild(el('div.notice.warn', { style: { marginBottom: '12px' } }, [
      el('span.n-ico', { text: '⚠' }),
      el('div.n-body', {}, [
        el('div', { text: '当前为单文件 / 无后端模式：免费模型可直连使用，自备 Key 的接口只有 OpenAI 兼容类（对话、看图）能跨域直连。' }),
        el('div', { style: { marginTop: '3px' }, text: '要接通义万相、百度智能云、remove.bg 等，请在项目目录运行 node server.js 后刷新本页。' })
      ])
    ]));
  }

  const providers = (state.catalog ? state.catalog.providers : []);
  providers.forEach((p) => host.appendChild(providerCard(p)));
}

function providerCard(p) {
  const cfg = cfgOf(p.id);
  const isLocal = p.id === 'local';
  const enabled = isLocal ? true : cfg.enabled !== false;
  const card = el('div.provider-card' + (enabled ? '.enabled' : ''));

  const statusLine = el('div.pc-notes', { text: '' });
  function refreshStatus() {
    const st = isLocal ? { kind: 'ok', text: '浏览器本地计算，离线可用，不消耗任何额度' } : providerStatus(p.id);
    statusLine.textContent = (st.kind === 'ok' ? '● ' : st.kind === 'warn' ? '◐ ' : '○ ') + st.text;
    statusLine.style.color = st.kind === 'ok' ? 'var(--ok)' : st.kind === 'warn' ? 'var(--warn)' : 'var(--text-3)';
    card.classList.toggle('enabled', !isLocal && cfg.enabled !== false);
  }

  const head = el('div.pc-head', {}, [
    el('div.pc-name', { text: p.label }),
    el('div.pc-kind.' + (p.kind || 'byok'), { text: KIND_LABEL[p.kind] || '自备 Key' }),
    el('div.grow'),
    isLocal ? el('span.muted', { style: { fontSize: '11px' }, text: '始终启用' })
      : switchEl(enabled, (v) => { cfg.enabled = v; commit('ai'); refreshStatus(); renderFields(); })
  ]);

  const caps = el('div.pc-caps', {}, Object.keys(p.capabilities || {}).map((c) => el('span.pc-cap', { text: CAP_LABEL[c] || c })));

  const fieldsHost = el('div.pc-fields');
  function renderFields() {
    fieldsHost.textContent = '';
    if (isLocal) {
      fieldsHost.appendChild(el('div.muted', { style: { fontSize: '11.5px', lineHeight: '1.6' }, text: '变清晰＝Canvas 高质量重采样 + 锐化；抠图＝颜色距离 + 边缘羽化的主体分离；看图＝本地像素统计生成描述；视频＝MediaRecorder 运镜合成 WebM。全部在本机完成，素材不上传。' }));
      return;
    }
    if (cfg.enabled === false) {
      fieldsHost.appendChild(el('div.muted', { style: { fontSize: '11.5px' }, text: '开关已关闭，打开后可编辑 Key 与模型。' }));
      return;
    }

    // 预设（OpenAI 兼容）
    if (Array.isArray(p.presets) && p.presets.length) {
      const presetRow = el('div.pc-presets');
      p.presets.forEach((ps) => {
        const active = (cfg.baseUrl || '') === ps.baseUrl;
        presetRow.appendChild(el('button.chip' + (active ? '.active' : ''), {
          type: 'button', text: ps.label, title: ps.baseUrl,
          onclick: () => {
            cfg.baseUrl = ps.baseUrl;
            if (!cfg.models.chat && ps.chatModels && ps.chatModels[0]) cfg.models.chat = ps.chatModels[0];
            if (ps.vision && !cfg.models.vision) cfg.models.vision = (ps.chatModels || []).find((m) => /vl|vision|4o|gemini/i.test(m)) || cfg.models.chat || '';
            if (ps.imageModels && ps.imageModels[0] && !cfg.models.image) cfg.models.image = ps.imageModels[0];
            commit('ai');
            renderFields();
            toast('已切换到 ' + ps.label, { type: 'ok', hint: ps.baseUrl, timeout: 2600 });
          }
        }));
      });
      fieldsHost.appendChild(el('div.field', {}, [el('label.lbl', { text: '常用平台预设（点击自动填 Base URL 与模型）' }), presetRow]));
    }

    if (p.needsKey !== false || p.keyLabel) {
      fieldsHost.appendChild(keyField(p.keyLabel || 'API Key', cfg.key, (v) => { cfg.key = v; commit('ai'); refreshStatus(); }, '粘贴你的 API Key'));
    }
    if (p.secretLabel) {
      fieldsHost.appendChild(keyField(p.secretLabel, cfg.secret, (v) => { cfg.secret = v; commit('ai'); refreshStatus(); }, '粘贴 Secret Key'));
    }
    if (p.baseUrlLabel || p.id === 'openai-compat') {
      const inp = el('input.input', { type: 'text', value: cfg.baseUrl || '', placeholder: 'https://api.example.com/v1', spellcheck: 'false' });
      inp.addEventListener('change', () => { cfg.baseUrl = inp.value.trim().replace(/\/+$/, ''); commit('ai'); });
      fieldsHost.appendChild(el('div.field', {}, [el('label.lbl', { text: p.baseUrlLabel || 'Base URL' }), inp]));
    }

    // 每种能力的模型
    Object.keys(p.capabilities || {}).forEach((cap) => {
      const models = (p.capabilities[cap] && p.capabilities[cap].models) || [];
      const mf = modelField(p.id, cap, models, (v) => {
        commit('ai');
        refreshStatus();
        const route = state.settings.ai.routes[cap];
        if (route && route.provider === p.id && !route.model) route.model = v;
      });
      fieldsHost.appendChild(mf.node);
      fieldRefs.push({ provider: p.id, cap: cap, field: mf });
    });

    // 操作行
    const testOut = el('div.muted', { style: { fontSize: '11px', minHeight: '15px' } });
    const btnFetch = el('button.btn.sm.ghost', { text: '⟳ 拉取模型列表' });
    const btnTest = el('button.btn.sm', { text: '⚡ 测试连通' });
    btnFetch.addEventListener('click', async () => {
      btnFetch.disabled = true;
      testOut.textContent = '正在拉取模型列表…';
      try {
        const got = await fetchProviderModels(p.id);
        const ids = got.all || [];
        fieldRefs.filter((r) => r.provider === p.id).forEach((r) => r.field.addOptions(ids.length ? ids : (got[r.cap] || [])));
        if (!ids.length) {
          if (got.chat) fieldRefs.filter((r) => r.provider === p.id && r.cap === 'chat').forEach((r) => r.field.addOptions(got.chat));
          if (got.image) fieldRefs.filter((r) => r.provider === p.id && r.cap === 'image').forEach((r) => r.field.addOptions(got.image));
        }
        testOut.textContent = '✓ 已取到 ' + got.count + ' 个模型，可在上方输入框下拉选择';
        testOut.style.color = 'var(--ok)';
        // 顺带自动填第一个可用模型
        fieldRefs.filter((r) => r.provider === p.id).forEach((r) => {
          if (!cfgOf(p.id).models[r.cap]) {
            const first = (ids.length ? ids : (got[r.cap] || []))[0];
            if (first) r.field.setValue(first);
          }
        });
        commit('ai');
        refreshStatus();
      } catch (err) {
        testOut.textContent = '✕ ' + String(err.message || err).slice(0, 160);
        testOut.style.color = 'var(--err)';
      } finally { btnFetch.disabled = false; }
    });
    btnTest.addEventListener('click', async () => {
      btnTest.disabled = true;
      testOut.textContent = '正在测试连通…';
      testOut.style.color = 'var(--text-3)';
      try {
        const r = await testProvider(p.id);
        testOut.textContent = (r.kind === 'ok' ? '✓ ' : '◐ ') + r.text;
        testOut.style.color = r.kind === 'ok' ? 'var(--ok)' : 'var(--warn)';
        if (r.models) btnFetch.click();
        toast(providerLabel(p.id) + ' 连通正常', { type: 'ok', hint: r.text, timeout: 4200 });
      } catch (err) {
        testOut.textContent = '✕ ' + String(err.message || err).slice(0, 200);
        testOut.style.color = 'var(--err)';
        toast('连通测试失败', { type: 'err', hint: String((err && err.hint) || err.message || err).slice(0, 200), timeout: 7000 });
      } finally { btnTest.disabled = false; }
    });
    const btnRoute = el('button.btn.sm.ghost', {
      text: '⇢ 设为默认通道', title: '把该供应商设为它支持的所有能力的默认通道',
      onclick: () => {
        const caps = Object.keys(p.capabilities || {});
        caps.forEach((cap) => {
          state.settings.ai.routes[cap] = { provider: p.id, model: cfgOf(p.id).models[cap] || (p.capabilities[cap] && p.capabilities[cap].defaultModel) || '' };
        });
        commit('routes');
        toast('已把 ' + caps.map((c) => CAP_LABEL[c]).join('、') + ' 指向 ' + p.label, { type: 'ok', timeout: 4200 });
        refreshStatus();
      }
    });
    fieldsHost.appendChild(el('div.inline-row', { style: { gap: '6px', flexWrap: 'wrap' } }, [btnTest, btnFetch, btnRoute]));
    fieldsHost.appendChild(testOut);
  }

  const fieldRefs = [];
  const notes = p.note ? el('div.pc-notes', { text: p.note }) : null;

  card.append(head, notes || document.createDocumentFragment(), caps, statusLine, fieldsHost);
  refreshStatus();
  renderFields();
  return card;
}

/* ------------------------------------------------------------------ *
 * 页签 2：能力路由
 * ------------------------------------------------------------------ */

function paneRoutes(host) {
  host.appendChild(el('div.sec-title', { text: '每种能力走哪条通道' }));

  const table = el('table.route-table');
  const thead = el('thead', {}, el('tr', {}, [
    el('th', { text: '能力' }), el('th', { text: '通道' }), el('th', { text: '模型' }), el('th', { text: '状态' })
  ]));
  const tbody = el('tbody');
  table.append(thead, tbody);

  const statusCells = [];

  CAPS.forEach((cap) => {
    const route = state.settings.ai.routes[cap] || (state.settings.ai.routes[cap] = { provider: 'local', model: '' });
    const candidates = (state.catalog ? state.catalog.providers : []).filter((p) => (p.capabilities && p.capabilities[cap]) || p.id === 'local');

    const provSel = el('select.select', {}, candidates.map((p) => el('option', {
      value: p.id, text: p.label + (p.kind === 'free' ? '（免费）' : p.kind === 'local' ? '（离线）' : ''), selected: route.provider === p.id
    })));
    if (!candidates.some((p) => p.id === route.provider)) route.provider = (candidates[0] || {}).id || 'local';

    const p0 = catProvider(route.provider);
    const models0 = (p0 && p0.capabilities && p0.capabilities[cap] && p0.capabilities[cap].models) || [];
    const listId = 'rt-' + cap;
    const dl = el('datalist', { id: listId }, models0.map((m) => el('option', { value: typeof m === 'string' ? m : m.id })));
    const modelInp = el('input.input', {
      type: 'text', list: listId, spellcheck: 'false',
      value: route.model || cfgOf(route.provider).models[cap] || '',
      placeholder: route.provider === 'local' ? '本地引擎（无需模型）' : '模型名'
    });
    modelInp.disabled = route.provider === 'local';

    const stTd = el('td', {}, el('div.route-line', { style: { gap: '6px' } }, [statusDot('ok'), el('span', { text: '' })]));
    statusCells.push({ cap: cap, cell: stTd });

    provSel.addEventListener('change', () => {
      route.provider = provSel.value;
      const np = catProvider(route.provider);
      route.model = cfgOf(route.provider).models[cap] || (np && np.capabilities && np.capabilities[cap] && np.capabilities[cap].defaultModel) || '';
      dl.textContent = '';
      (((np && np.capabilities && np.capabilities[cap] && np.capabilities[cap].models) || [])).forEach((m) => dl.appendChild(el('option', { value: typeof m === 'string' ? m : m.id })));
      modelInp.value = route.model;
      modelInp.disabled = route.provider === 'local';
      commit('routes');
      refreshStatuses();
    });
    modelInp.addEventListener('change', () => {
      route.model = modelInp.value.trim();
      cfgOf(route.provider).models[cap] = route.model;
      commit('routes');
      refreshStatuses();
    });

    tbody.appendChild(el('tr', {}, [
      el('td', {}, [el('div', { text: CAP_LABEL[cap], style: { fontWeight: '600' } })]),
      el('td', {}, provSel),
      el('td', {}, modelInp, dl),
      stTd
    ]));
  });

  function refreshStatuses() {
    statusCells.forEach(({ cap, cell }) => {
      const st = routeStatus(cap);
      const line = cell.querySelector('.route-line');
      line.textContent = '';
      line.append(statusDot(st.kind), el('span', { text: st.text, style: { fontSize: '11px', color: st.kind === 'err' ? 'var(--err)' : 'var(--text-2)' } }));
    });
  }

  host.appendChild(table);
  refreshStatuses();

  host.appendChild(el('div.hr'));
  host.appendChild(rowSwitch('失败时自动回退到下一条可用通道',
    '例如自备接口报错或限流时，自动改用免费模型 / 本地引擎完成任务',
    () => state.settings.ai.autoFallback !== false,
    (v) => { state.settings.ai.autoFallback = v; commit('routes'); }));
  host.appendChild(el('div.field', { style: { marginTop: '8px' } }, [
    el('label.lbl', { text: '批量生成并发数（1-4）' }),
    (() => {
      const inp = el('input.input', { type: 'number', min: '1', max: '4', value: String(state.settings.ai.concurrency || 2), style: { maxWidth: '110px' } });
      inp.addEventListener('change', () => { state.settings.ai.concurrency = clamp(Number(inp.value) || 2, 1, 4); inp.value = String(state.settings.ai.concurrency); commit('routes'); });
      return inp;
    })()
  ]));

  host.appendChild(el('div.notice.info', { style: { marginTop: '12px' } }, [
    el('span.n-ico', { text: 'ⓘ' }),
    el('div.n-body', { text: '「看图理解」是反推提示词的关键能力：免费档没有视觉模型，因此默认走自备的 OpenAI 兼容接口（如 qwen-vl-max / glm-4v-flash / gpt-4o-mini）。未配置时会自动回退到本地图像分析，仍能产出结构化提示词，只是语义精度略低。' })
  ]));
}

/* ------------------------------------------------------------------ *
 * 页签 3：画布
 * ------------------------------------------------------------------ */

function paneCanvas(host) {
  const s = state.settings;
  host.appendChild(el('div.sec-title', { text: '主题' }));
  const themeRow = el('div.chip-row');
  [['dark', '深空黑'], ['light', '极简白']].forEach(([id, label]) => {
    themeRow.appendChild(el('button.chip' + (s.theme === id ? '.active' : ''), {
      type: 'button', text: (id === 'dark' ? '🌑 ' : '☀ ') + label,
      onclick: () => {
        s.theme = id;
        applyTheme(id);
        commit('canvas');
        themeRow.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        themeRow.querySelector('.chip:nth-child(' + (id === 'dark' ? 1 : 2) + ')').classList.add('active');
        bus.emit('theme:changed', { theme: id });
      }
    }));
  });
  host.appendChild(themeRow);
  host.appendChild(el('div.muted', { style: { fontSize: '11px', margin: '6px 0 12px' }, text: '也可以点右上角的主题开关，或按 Ctrl J 随时切换。' }));

  host.appendChild(el('div.sec-title', { text: '星空与网格' }));
  host.appendChild(rowSwitch('星空背景', '科技风动态星点，随视口视差移动', () => s.canvas.starfield !== false, (v) => { s.canvas.starfield = v; commit('canvas'); requestBackgroundRedraw(); }));
  host.appendChild(sliderRow('星点密度', 0.2, 3, 0.1, () => s.canvas.starDensity || 1, (v) => { s.canvas.starDensity = v; commit('canvas'); requestBackgroundRedraw(); }, (v) => v.toFixed(1) + '×'));
  host.appendChild(rowSwitch('对齐网格', '拖动节点时吸附到网格', () => !!s.canvas.gridSnap, (v) => { s.canvas.gridSnap = v; commit('canvas'); requestBackgroundRedraw(); }));
  host.appendChild(sliderRow('网格间距', 10, 200, 10, () => s.canvas.gridSize || 40, (v) => { s.canvas.gridSize = v; commit('canvas'); requestBackgroundRedraw(); }, (v) => v + ' px'));
  host.appendChild(rowSwitch('显示星空网格线', '关闭后只保留纯净背景', () => s.canvas.showGrid !== false, (v) => { s.canvas.showGrid = v; commit('canvas'); requestBackgroundRedraw(); }));

  host.appendChild(el('div.sec-title', { text: '节点' }));
  host.appendChild(rowSwitch('显示节点信息条', '在节点下方显示标题、引擎、耗时等元信息', () => s.canvas.showMeta !== false, (v) => { s.canvas.showMeta = v; commit('canvas'); renderAllNodes(); }));
  host.appendChild(rowSwitch('自动保存画布', '把节点与视口存到浏览器本地（图片过大时会自动暂停并提示）', () => s.autosave !== false, (v) => { s.autosave = v; commit('canvas'); }));
  host.appendChild(el('div.inline-row', { style: { gap: '6px', marginTop: '10px' } }, [
    el('button.btn.sm.ghost', { text: '⤢ 适应全部内容', onclick: () => { fitToContent(90, true); } }),
    el('button.btn.sm.ghost', { text: '100% 视图', onclick: () => bus.emit('viewport:reset') })
  ]));
}

/* ------------------------------------------------------------------ *
 * 页签 4：对话
 * ------------------------------------------------------------------ */

function paneChat(host) {
  const c = state.settings.chat;
  host.appendChild(el('div.sec-title', { text: '智能对话' }));
  host.appendChild(el('div.field', {}, [
    el('label.lbl', { text: '系统提示词（决定助手的角色与风格）' }),
    (() => {
      const ta = el('textarea.textarea', { rows: '5', placeholder: '例如：你是电商视觉专家…' });
      ta.value = c.systemPrompt || '';
      ta.addEventListener('change', () => { c.systemPrompt = ta.value; commit('chat'); });
      return ta;
    })()
  ]));
  host.appendChild(el('div.chip-row', { style: { marginBottom: '10px' } }, [
    ['默认助手', DEFAULT_SETTINGS.chat.systemPrompt],
    ['电商视觉专家', '你是资深电商视觉总监，擅长主图 / 白底图 / 详情页的构图、光影、卖点排布。回答要给出可直接使用的提示词成品与具体参数，少讲理论。'],
    ['提示词工程师', '你是提示词工程专家。用户给一句话或一张图，你输出结构化提示词：主体、风格、光影、构图、镜头、画质、负面提示词，中英双语，可直接粘贴到生成器。'],
    ['极简模式', '回答尽量短，直接给结论和可执行步骤，不要客套。']
  ].map(([label, text]) => el('button.chip', {
    type: 'button', text: label,
    onclick: () => { c.systemPrompt = text; commit('chat'); paneChatRefresh(); toast('已切换对话风格：' + label, { type: 'ok', timeout: 2400 }); }
  }))));

  host.appendChild(sliderRow('携带上下文轮数', 0, 30, 1, () => c.keepContext == null ? 12 : c.keepContext, (v) => { c.keepContext = v; commit('chat'); }, (v) => v === 0 ? '不携带' : v + ' 轮'));
  host.appendChild(rowSwitch('流式输出', '逐字返回，关闭后一次性返回全文', () => c.stream !== false, (v) => { c.stream = v; commit('chat'); }));

  host.appendChild(el('div.hr'));
  const out = el('div.muted', { style: { fontSize: '11px', minHeight: '16px' } });
  host.appendChild(el('div.inline-row', { style: { gap: '6px' } }, [
    el('button.btn.sm', {
      text: '⚡ 测试对话通道', onclick: async (e) => {
        e.target.disabled = true;
        out.textContent = '正在调用当前对话通道…';
        try {
          const t0 = performance.now();
          const res = await ai.call('chat', { messages: [{ role: 'user', content: '只回复两个字：正常' }], prompt: '只回复两个字：正常', stream: false });
          out.textContent = '✓ ' + providerLabel(res.__route ? res.__route.provider : '?') + ' · ' + Math.round(performance.now() - t0) + 'ms · 回复「' + String(res.text || '').slice(0, 20) + '」';
          out.style.color = 'var(--ok)';
        } catch (err) {
          out.textContent = '✕ ' + String(err.message || err).slice(0, 180);
          out.style.color = 'var(--err)';
        } finally { e.target.disabled = false; }
      }
    }),
    el('button.btn.sm.ghost', { text: '↺ 恢复默认系统提示词', onclick: () => { c.systemPrompt = DEFAULT_SETTINGS.chat.systemPrompt; commit('chat'); paneChatRefresh(); } })
  ]));
  host.appendChild(out);

  function paneChatRefresh() {
    host.textContent = '';
    paneChat(host);
  }
}

/* ------------------------------------------------------------------ *
 * 页签 5：快捷键
 * ------------------------------------------------------------------ */

function paneKeys(host) {
  host.appendChild(el('div.sec-title', { text: '快捷键' }));
  const grid = el('div.kbd-grid');
  SHORTCUTS.forEach(([k, v]) => {
    grid.appendChild(el('div.kbd-row', {}, [
      el('span.k', { text: v }),
      el('span.v', {}, k.split(' / ').map((part) => el('kbd.pk', { text: part })))
    ]));
  });
  host.appendChild(grid);
  host.appendChild(el('div.notice.info', { style: { marginTop: '14px' } }, [
    el('span.n-ico', { text: 'ⓘ' }),
    el('div.n-body', { text: '在输入框内打字时快捷键自动失效，不会误触发。Mac 上把 Ctrl 换成 ⌘ 同样可用。' })
  ]));
}

/* ------------------------------------------------------------------ *
 * 页签 6：数据
 * ------------------------------------------------------------------ */

function paneData(host) {
  host.appendChild(el('div.sec-title', { text: '画布存档' }));
  const info = el('div.muted', { style: { fontSize: '11.5px', lineHeight: '1.7' } });
  function refreshInfo() {
    const bytes = (() => { try { return new Blob([JSON.stringify(serializeProject())]).size; } catch (_) { return 0; } })();
    info.textContent = '节点 ' + state.nodes.size + ' 个 · 存档约 ' + humanSize(bytes) + ' · 自动保存 ' + (state.settings.autosave !== false ? '开启' : '已暂停') + ' · 后端代理 ' + (ai.backend ? '已连接' : '未连接（单文件模式）') + ' · 能力目录 ' + ((state.catalog && state.catalog.version) || '-');
  }
  refreshInfo();
  host.appendChild(info);

  host.appendChild(el('div.inline-row', { style: { gap: '6px', margin: '10px 0', flexWrap: 'wrap' } }, [
    el('button.btn.sm', {
      text: '⬇ 导出工程 JSON', onclick: () => {
        const blob = new Blob([JSON.stringify(serializeProject(), null, 2)], { type: 'application/json' });
        downloadBlob(blob, timestampName('星空画布工程', 'json'));
        toast('工程已导出', { type: 'ok', hint: '包含节点、位置、提示词与来源链路', timeout: 4000 });
      }
    }),
    el('button.btn.sm.ghost', { text: '⬆ 导入工程 JSON', onclick: () => bus.emit('panel:pick-file', { for: 'project-import' }) }),
    el('button.btn.sm.ghost', { text: '📋 复制设置（不含 Key）', onclick: async () => {
      const safe = JSON.parse(JSON.stringify(state.settings));
      Object.values(safe.ai.providers).forEach((p) => { p.key = p.key ? '***' : ''; p.secret = p.secret ? '***' : ''; });
      await copyText(JSON.stringify(safe, null, 2));
      toast('设置已复制（Key 已脱敏）', { type: 'ok', timeout: 3000 });
    } })
  ]));

  host.appendChild(el('div.hr'));
  host.appendChild(el('div.sec-title', { text: '危险操作' }));
  host.appendChild(el('div.inline-row', { style: { gap: '6px', flexWrap: 'wrap' } }, [
    el('button.btn.sm.danger', {
      text: '🗑 清空画布', onclick: async () => {
        const { confirmDialog } = await import('../ui/dom.js');
        const ok = await confirmDialog({ title: '清空画布', message: '将删除全部 ' + state.nodes.size + ' 个节点并清除本地存档，<b>不可撤销</b>。确定继续？', okText: '全部清空', danger: true });
        if (!ok) return;
        clearProject();
        bus.emit('history:clear');
        bus.emit('project:save-request');
        refreshInfo();
        toast('画布已清空', { type: 'ok', timeout: 2600 });
      }
    }),
    el('button.btn.sm.ghost', {
      text: '↺ 重置全部设置', onclick: async () => {
        const { confirmDialog } = await import('../ui/dom.js');
        const ok = await confirmDialog({ title: '重置设置', message: '将恢复默认主题、通道、路由与对话设置，<b>已填写的 API Key 会被清除</b>。确定继续？', okText: '重置', danger: true });
        if (!ok) return;
        state.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        applyTheme(state.settings.theme);
        commit('all');
        refreshInfo();
        if (settingsModal) { settingsModal.close(); }
        openSettings('ai');
        toast('设置已恢复默认', { type: 'ok', timeout: 3000 });
      }
    })
  ]));

  host.appendChild(el('div.hr'));
  host.appendChild(el('div.sec-title', { text: '关于' }));
  host.appendChild(el('div.muted', { style: { fontSize: '11.5px', lineHeight: '1.8' }, html:
    '<b>星空画布</b> · 无限画布 AI 创作台<br>' +
    '能力目录版本：' + ((state.catalog && state.catalog.version) || '-') + '<br>' +
    '运行模式：' + (ai.backend ? '完整版（Node 后端代理，支持全部供应商）' : '单文件版（浏览器直连免费模型）') + '<br>' +
    '隐私：图片与提示词默认只在本机处理；调用云端接口时按你配置的通道发送，Key 保存在浏览器本地。'
  }));
  host.appendChild(el('div.inline-row', { style: { gap: '6px', marginTop: '8px' } }, [
    el('button.btn.sm.ghost', { text: '查看能力目录 JSON', onclick: async () => { await copyText(JSON.stringify(state.catalog, null, 2)); toast('能力目录已复制到剪贴板', { type: 'ok', timeout: 3000 }); } })
  ]));
}

/** 供 main.js 在导入工程文件后刷新设置面板信息 */
export function refreshSettings() {
  if (settingsModal) { settingsModal.close(); openSettings('data'); }
}

export { deserializeProject };
