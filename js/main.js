/**
 * 星空画布 · 应用入口
 * ------------------------------------------------------------------
 * 负责装配：设置 → 主题 → 无限画布引擎 → 历史 → 剪贴板 → AI 客户端
 * → 本地引擎注册 → 顶栏 / 左栏 / 右侧面板 / 右键菜单 / 快捷键 / 持久化。
 * 各功能模块（生成、工具、提示词、对话、导出、视频、设置）都通过 bus 事件
 * 与直接调用协作，本文件只做接线，不实现业务逻辑。
 */

import {
  state, bus, loadSettings, applyTheme, toggleTheme, createNode, updateNode, removeNodes,
  setSelection, getNode, allNodes, selectedNodes, serializeProject, deserializeProject,
  saveProject, loadProject, clearProject, setViewport, providerLabel, screenToWorld
} from './core/state.js';
import {
  initEngine, renderAllNodes, nodeElement, zoomAt, setZoom, fitToContent, focusNode,
  requestBackgroundRedraw, isTyping, updateLocator
} from './core/engine.js';
import { initHistory, undo, redo } from './core/history.js';
import { ai, registerLocalEngine } from './ai/client.js';
import { initClipboard, addImageNode, duplicateSelection, copyNodeImageToSystem, pickFiles } from './features/clipboard.js';
import { openExportDialog, quickDownloadNode } from './features/exporter.js';
import { openToolMenu, closeToolMenu, runTool, runToolOnSelection, buildLocalPromptText } from './features/tools.js';
import { openGenerateDialog, renderGeneratePanel, addPromptCard } from './features/generate.js';
import { openPromptStudio, renderPromptPanel, attachImageToStudio } from './features/prompt-studio.js';
import { renderChatPanel, setChatAttachment, chatWithImage } from './features/chat.js';
import { renderPropsPanel, openPropsPanel } from './features/props.js';
import { openSettings, openHelp, engineSummary, routeStatus } from './features/settings.js';
import { openVideoDialog, addVideoFrame, registerVideoEngine } from './features/video.js';
import { localUpscale, localMatting, analyzeImage } from './features/imageops.js';
import { el, $, $$, on, toast, clamp, throttle, fileToDataUrl, confirmDialog } from './ui/dom.js';

const $id = (id) => document.getElementById(id);

/* ================================================================== *
 * 本地引擎：把纯前端算法接进统一的 ai.call 通道
 * ================================================================== */

function registerLocalEngines() {
  registerLocalEngine('upscale', async (p) => {
    if (!p || !p.image) return { ok: false, code: 'no_image', message: '缺少待处理的图片' };
    const r = await localUpscale(p.image, { factor: clamp(p.scale || 2, 1, 4) });
    return { image: r.dataUrl, width: r.width, height: r.height, factor: r.factor, model: 'local-upscale', engine: r.engine, costMs: r.costMs };
  });

  registerLocalEngine('matting', async (p) => {
    if (!p || !p.image) return { ok: false, code: 'no_image', message: '缺少待处理的图片' };
    const r = await localMatting(p.image, {
      output: p.white ? 'white' : 'transparent',
      tolerance: p.tolerance, feather: p.feather
    });
    return { image: r.dataUrl, model: 'local-matting', engine: r.engine, costMs: r.costMs, whiteBackground: !!p.white };
  });

  // 看图理解：没有视觉模型时用本地像素分析产出结构化提示词
  registerLocalEngine('vision', async (p) => {
    if (!p || !p.image) return { ok: false, code: 'no_image', message: '缺少待分析的图片' };
    const a = await analyzeImage(p.image);
    return { text: buildLocalPromptText(a), analysis: a, model: 'local-analyze', engine: '本地图像分析', ok: true };
  });

  registerVideoEngine();
}

/* ================================================================== *
 * 右侧面板
 * ================================================================== */

const PANELS = {
  generate: { render: renderGeneratePanel, label: '生成' },
  prompt: { render: renderPromptPanel, label: '提示词' },
  chat: { render: renderChatPanel, label: '对话' },
  props: { render: renderPropsPanel, label: '属性' }
};
let activePanel = null;

export function openPanel(id) {
  if (!PANELS[id]) id = 'generate';
  const bar = $id('rightbar');
  const body = $id('panel-body');
  if (!bar || !body) return;
  if (activePanel && activePanel !== id) destroyPanel(body);
  activePanel = id;
  bar.classList.remove('hidden');
  $$('#panel-tabs .ptab').forEach((b) => b.classList.toggle('active', b.dataset.panel === id));
  body.textContent = '';
  const host = el('div.panel-host', { dataset: { panel: id } });
  body.appendChild(host);
  try {
    PANELS[id].render(host);
  } catch (err) {
    host.appendChild(el('div.notice.err', {}, [el('span.n-ico', { text: '✕' }), el('div.n-body', { text: '面板加载失败：' + String(err.message || err) })]));
    console.error('[panel]', id, err);
  }
  bus.emit('panel:opened', { id });
}

function destroyPanel(body) {
  try { body.dispatchEvent(new CustomEvent('panel:destroy', { bubbles: true })); } catch (_) { /* 忽略 */ }
}

function closePanel() {
  const bar = $id('rightbar');
  const body = $id('panel-body');
  if (body) destroyPanel(body);
  activePanel = null;
  if (bar) bar.classList.add('hidden');
  if (body) body.textContent = '';
  $$('#panel-tabs .ptab').forEach((b) => b.classList.remove('active'));
}

function bindPanels() {
  on($id('panel-tabs'), 'click', (e) => {
    const btn = e.target.closest('.ptab');
    if (!btn) return;
    const id = btn.dataset.panel;
    if (activePanel === id) closePanel();
    else openPanel(id);
  });
  on($id('panel-close'), 'click', () => closePanel());
}

/* ================================================================== *
 * 顶栏 / 左栏
 * ================================================================== */

function createTextNode(type, world) {
  const isNote = type === 'note';
  const w = isNote ? 200 : 240;
  const h = isNote ? 200 : 96;
  const p = world || viewportWorld();
  const node = createNode({
    type: type,
    x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w: w, h: h,
    data: { text: '' },
    meta: { source: 'canvas', title: isNote ? '便签' : '文本卡片' }
  });
  setSelection([node.id]);
  renderAllNodes();
  bus.emit('history:push', { label: isNote ? '新建便签' : '新建文本' });
  bus.emit('project:save-request');
  setTimeout(() => startTextEdit(node.id), 30);
  return node;
}

function startTextEdit(nodeId) {
  const root = nodeElement(nodeId);
  const body = root && root.querySelector('.text-body');
  if (body) body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
}

function viewportWorld() {
  const st = $id('stage');
  const r = st ? st.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
  return screenToWorld(r.width / 2, r.height / 2);
}

function doCreate(kind, world) {
  switch (kind) {
    case 'image': pickFiles('image/*,video/*,.json'); break;
    case 'text': createTextNode('text', world); break;
    case 'note': createTextNode('note', world); break;
    case 'generate': openGenerateDialog(); break;
    case 'video': openVideoDialog({}); break;
    case 'chat': openPanel('chat'); break;
    case 'prompt': openPanel('prompt'); break;
    default: break;
  }
}

function bindTopbar() {
  on($id('create-bar'), 'click', (e) => {
    const btn = e.target.closest('[data-create]');
    if (btn) doCreate(btn.dataset.create);
  });
  on($id('zoom-in'), 'click', () => zoomAt(1.25));
  on($id('zoom-out'), 'click', () => zoomAt(1 / 1.25));
  on($id('zoom-value'), 'click', () => resetZoom());
  on($id('zoom-fit'), 'click', () => fitToContent(90, true));

  const ts = $id('theme-switch');
  on(ts, 'click', () => { toggleTheme(); syncThemeUI(); });
  on(ts, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTheme(); syncThemeUI(); } });

  on($id('btn-prompt-studio'), 'click', () => openPromptStudio({}));
  on($id('btn-settings'), 'click', () => openSettings('ai'));
  on($id('btn-export'), 'click', () => openExportDialog());
  on($id('btn-help'), 'click', () => openHelp());
}

function bindLeftbar() {
  const lb = $id('leftbar');
  on(lb, 'click', (e) => {
    const tool = e.target.closest('[data-tool]');
    if (tool) { setTool(tool.dataset.tool); return; }
    const create = e.target.closest('[data-create]');
    if (create) { doCreate(create.dataset.create); return; }
    if (e.target.closest('#tool-undo')) { const l = undo(); toast(l ? '已撤销：' + l : '没有可撤销的操作', { type: 'info', timeout: 1800 }); return; }
    if (e.target.closest('#tool-redo')) { const l = redo(); toast(l ? '已重做：' + l : '没有可重做的操作', { type: 'info', timeout: 1800 }); return; }
    if (e.target.closest('#tool-delete')) { deleteSelection(); return; }
    if (e.target.closest('#engine-badge')) { openSettings('routes'); }
  });
  setTool(state.tool || 'select');
}

function setTool(tool) {
  state.tool = tool === 'pan' ? 'pan' : 'select';
  $$('#leftbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === state.tool));
  const st = $id('stage');
  if (st) st.classList.toggle('tool-pan', state.tool === 'pan');
  const mode = $id('hud-mode');
  if (mode) mode.textContent = state.tool === 'pan' ? '抓手平移' : '选择模式';
}

function deleteSelection() {
  const ids = Array.from(state.selection);
  if (!ids.length) { toast('没有选中的节点', { type: 'warn', timeout: 1800 }); return; }
  removeNodes(ids);
  renderAllNodes();
  bus.emit('history:push', { label: '删除 ' + ids.length + ' 个节点' });
  bus.emit('project:save-request');
  toast('已删除 ' + ids.length + ' 个节点', { type: 'ok', hint: 'Ctrl Z 可撤销', timeout: 2600 });
}

function resetZoom() {
  const st = $id('stage');
  const r = st ? st.getBoundingClientRect() : { width: innerWidth, height: innerHeight };
  setZoom(1, r.width / 2, r.height / 2);
}

/* ================================================================== *
 * HUD / 徽标
 * ================================================================== */

const syncHud = throttle(() => {
  const pos = $id('hud-pos');
  if (pos) {
    const w = viewportWorld();
    pos.textContent = 'x ' + Math.round(w.x) + ' · y ' + Math.round(w.y);
  }
  const zv = $id('zoom-value');
  if (zv) zv.textContent = Math.round(state.viewport.scale * 100) + '%';
  const count = $id('hud-count');
  if (count) {
    const sel = state.selection.size;
    count.textContent = sel ? ('已选 ' + sel + ' / ' + state.nodes.size + ' 个节点') : (state.nodes.size + ' 个节点');
  }
  const hint = $id('hint-empty');
  if (hint) hint.classList.toggle('hidden', state.nodes.size > 0);
}, 60);

function refreshEngineBadge() {
  const text = $id('engine-text');
  const badge = $id('engine-badge');
  if (!text || !badge) return;
  let summary = '未就绪';
  try { summary = engineSummary(); } catch (_) { summary = '免费模型'; }
  text.textContent = summary;
  const img = safeRouteStatus('image');
  const chat = safeRouteStatus('chat');
  const kind = (img === 'err' && chat === 'err') ? 'err' : ((img === 'warn' || chat === 'warn') ? 'warn' : 'ok');
  badge.classList.remove('ok', 'warn', 'err');
  badge.classList.add(kind);
  badge.title = '文生图：' + safeRouteText('image') + '\n对话：' + safeRouteText('chat') + '\n点击查看能力路由';
}

function safeRouteStatus(cap) { try { return routeStatus(cap).kind; } catch (_) { return 'warn'; } }
function safeRouteText(cap) { try { return routeStatus(cap).text; } catch (_) { return '未配置'; } }

function syncThemeUI() {
  const dark = state.settings.theme !== 'light';
  const label = $id('theme-label');
  if (label) label.textContent = dark ? '深空黑' : '极简白';
  const ts = $id('theme-switch');
  if (ts) {
    ts.classList.toggle('on', !dark);
    ts.setAttribute('aria-pressed', String(!dark));
  }
}

/* ================================================================== *
 * 引擎事件接线
 * ================================================================== */

function bindEngineEvents() {
  bus.on('node:dblclick', ({ id, clientX, clientY }) => {
    const node = getNode(id);
    if (!node) return;
    if (node.type === 'image' || node.type === 'video') { openToolMenu(id, clientX, clientY); return; }
    if (node.type === 'prompt') { openPropsPanel(id); openPanel('props'); return; }
    startTextEdit(id);
  });

  bus.on('node:action', ({ id, action }) => {
    const node = getNode(id);
    if (!node) return;
    switch (action) {
      case 'zoom': focusNode(id); break;
      case 'tools': {
        const root = nodeElement(id);
        const r = root ? root.getBoundingClientRect() : null;
        openToolMenu(id, r ? r.left + r.width / 2 : innerWidth / 2, r ? r.top + r.height / 2 : innerHeight / 2);
        break;
      }
      case 'dup': duplicateSelection(28); break;
      case 'download': quickDownloadNode(id); break;
      case 'del': deleteSelection(); break;
      default: break;
    }
  });

  bus.on('node:contextmenu', ({ id, clientX, clientY }) => {
    const node = getNode(id);
    if (!node) return;
    if (node.type === 'image' || node.type === 'video') { openToolMenu(id, clientX, clientY); return; }
    showMenu(clientX, clientY, nodeMenuItems(node));
  });

  bus.on('canvas:contextmenu', ({ clientX, clientY, world }) => {
    showMenu(clientX, clientY, canvasMenuItems(world));
  });

  bus.on('project:import', ({ project, source }) => {
    try {
      const n = deserializeProject(project);
      renderAllNodes();
      fitToContent(90, true);
      bus.emit('history:push', { label: '导入工程' });
      toast('工程已导入：' + n + ' 个节点', { type: 'ok', hint: source || '', timeout: 4200 });
    } catch (err) {
      toast('工程导入失败', { type: 'err', hint: String(err.message || err), timeout: 7000 });
    }
  });

  bus.on('project:save-request', () => saveProject());
  bus.on('nodes:changed', syncHud);
  bus.on('selection:changed', syncHud);
  bus.on('viewport:changed', syncHud);
  bus.on('viewport:reset', () => resetZoom());
  bus.on('settings:changed', () => { refreshEngineBadge(); syncThemeUI(); });
  bus.on('theme:changed', () => syncThemeUI());
  bus.on('ai:ready', () => { refreshEngineBadge(); });
  bus.on('history:changed', () => { /* 按钮状态由 history.js 直接维护 */ });

  // 面板内的「选一张图」请求
  bus.on('panel:pick-image', (payload) => pickImageFor(payload && payload.for));
  bus.on('panel:pick-file', (payload) => {
    if (payload && payload.for === 'project-import') pickFiles('.json,application/json');
    else pickFiles('image/*,video/*,.json');
  });
  bus.on('canvas:create', (p) => doCreate(p && p.kind, p && p.world));
  bus.on('panel:open', (p) => {
    // 各功能模块发的是 { panel }，历史上也有 { id }，两种都接
    const id = (p && (p.panel || p.id)) || 'generate';
    if (p && p.prompt != null && state.settings.generate) state.settings.generate.lastSubject = String(p.prompt);
    openPanel(id);
  });
}

/* ================================================================== *
 * 文件选择：为面板提供图片（对话附图 / 反推 / 视频帧）
 * ================================================================== */

function pickTempFile(accept) {
  return new Promise((resolve) => {
    const inp = el('input.sr-only', { type: 'file', accept: accept || 'image/*' });
    document.body.appendChild(inp);
    let done = false;
    const finish = (f) => { if (done) return; done = true; setTimeout(() => inp.remove(), 0); resolve(f); };
    inp.addEventListener('change', () => finish(inp.files && inp.files.length ? inp.files[0] : null));
    inp.addEventListener('cancel', () => finish(null));
    inp.click();
  });
}

async function pickImageFor(purpose) {
  const file = await pickTempFile('image/*');
  if (!file) return;
  const dataUrl = await fileToDataUrl(file);
  if (purpose === 'video-frames') {
    if (!addVideoFrame(dataUrl, file.name)) {
      // 面板已关闭：直接把图片放到画布，避免用户白选一次
      await addImageNode(dataUrl, { title: file.name, source: 'file' });
    }
    return;
  }
  const node = await addImageNode(dataUrl, { title: file.name, source: 'file' });
  if (!node) return;
  if (purpose === 'chat') { openPanel('chat'); setChatAttachment(node.id); }
  else if (purpose === 'reverse') { openPanel('prompt'); attachImageToStudio(node.id); }
}

/* ================================================================== *
 * 右键菜单（画布空白 / 非图片节点）
 * ================================================================== */

let menuNode = null;
function closeMenu() {
  if (menuNode) { menuNode.remove(); menuNode = null; }
  document.removeEventListener('pointerdown', onMenuOutside, true);
  window.removeEventListener('keydown', onMenuEsc, true);
}
function onMenuEsc(e) { if (e.key === 'Escape') closeMenu(); }
function onMenuOutside(e) { if (menuNode && !menuNode.contains(e.target)) closeMenu(); }

function menuItem(item) {
  if (item.sep) return el('div.tm-sep');
  const row = el('div.tm-item' + (item.danger ? '.danger' : ''), {
    role: 'menuitem', title: item.hint || item.label
  }, [
    el('span.tm-ico', { text: item.icon || '·' }),
    el('div.tm-txt', {}, [
      el('div.tm-name', { text: item.label }),
      item.hint ? el('div.tm-hint', { text: item.hint }) : null
    ]),
    item.key ? el('span.tm-key', { text: item.key }) : null
  ]);
  if (item.disabled) row.classList.add('disabled');
  row.addEventListener('click', () => {
    if (item.disabled) return;
    closeMenu();
    if (item.run) item.run();
  });
  return row;
}

function showMenu(clientX, clientY, items) {
  closeMenu();
  closeToolMenu();
  menuNode = el('div.tool-menu', { role: 'menu' });
  items.forEach((it) => {
    if (it.title) { menuNode.appendChild(el('div.tm-group', { text: it.title })); return; }
    menuNode.appendChild(menuItem(it));
  });
  document.body.appendChild(menuNode);
  const mw = menuNode.offsetWidth;
  const mh = menuNode.offsetHeight;
  menuNode.style.left = Math.max(10, Math.min(clientX, innerWidth - mw - 12)) + 'px';
  menuNode.style.top = Math.max(10, Math.min(clientY, innerHeight - mh - 12)) + 'px';
  setTimeout(() => {
    document.addEventListener('pointerdown', onMenuOutside, true);
    window.addEventListener('keydown', onMenuEsc, true);
  }, 0);
}

function canvasMenuItems(world) {
  const hasSel = state.selection.size > 0;
  const items = [{ title: '在画布上创建' }];
  items.push(
    { icon: '🖼', label: '上传图片', hint: '图片 / 视频 / JSON 工程', run: () => pickFiles('image/*,video/*,.json') },
    { icon: '📝', label: '新建文本卡片', key: '双击空白', run: () => createTextNode('text', world) },
    { icon: '🗒', label: '新建便签', run: () => createTextNode('note', world) },
    { icon: '✨', label: 'AI 生成图片', hint: '提示词 + 模式 + 尺寸', key: 'Ctrl G', run: () => openGenerateDialog() },
    { icon: '🎬', label: '生成视频', hint: '运镜合成 / 文生视频', run: () => openVideoDialog({}) },
    { icon: '📋', label: '粘贴图片', hint: '从系统剪贴板', key: 'Ctrl V', run: () => pasteFromSystem() },
    { sep: true }
  );
  if (hasSel) {
    items.push(
      { title: '选中 ' + state.selection.size + ' 个节点' },
      { icon: '⧉', label: '复制一份', key: 'Ctrl D', run: () => duplicateSelection(28) },
      { icon: '⬇', label: '下载选中', run: () => { const id = Array.from(state.selection)[0]; quickDownloadNode(id); } },
      { icon: '⇩', label: '导出为…', hint: 'PNG / JPEG / WebP / SVG / JSON / WebM', key: 'Ctrl E', run: () => openExportDialog() },
      { icon: '🗑', label: '删除', key: 'Del', danger: true, run: () => deleteSelection() },
      { sep: true }
    );
  }
  items.push(
    { title: '视图' },
    { icon: '⤢', label: '适应全部内容', key: 'Shift 1', run: () => fitToContent(90, true) },
    { icon: '1:1', label: '回到 100%', key: 'Shift 0', run: () => resetZoom() },
    { icon: '☑', label: '全选节点', key: 'Ctrl A', run: () => { setSelection(allNodes().map((n) => n.id)); renderAllNodes(); } },
    { sep: true },
    { icon: '⚙', label: 'AI 接口设置', hint: engineSummary(), key: 'Ctrl ,', run: () => openSettings('ai') },
    { icon: '？', label: '快捷键与帮助', run: () => openHelp() }
  );
  return items;
}

function nodeMenuItems(node) {
  const items = [
    { title: (node.meta && node.meta.title) || '节点操作' },
    { icon: '⧉', label: '复制一份', key: 'Ctrl D', run: () => duplicateSelection(28) },
    { icon: '📋', label: '复制内容', hint: '文本复制到剪贴板', run: async () => {
      const { copyText } = await import('./ui/dom.js');
      await copyText(node.type === 'image' ? ((node.meta && node.meta.prompt) || '') : (node.data && node.data.text) || '');
      toast('已复制', { type: 'ok', timeout: 1800 });
    } },
    { icon: 'ⓘ', label: '属性与来源', run: () => { openPropsPanel(node.id); openPanel('props'); } },
    { icon: node.locked ? '🔓' : '🔒', label: node.locked ? '取消锁定' : '锁定位置', run: () => {
      updateNode(node.id, { locked: !node.locked });
      renderAllNodes();
      bus.emit('history:push', { label: node.locked ? '解锁节点' : '锁定节点' });
      toast(node.locked ? '已解锁' : '已锁定，不再随拖动移动', { type: 'ok', timeout: 2200 });
    } },
    { icon: '⤢', label: '定位到该节点', run: () => focusNode(node.id) },
    { sep: true },
    { icon: '🗑', label: '删除', key: 'Del', danger: true, run: () => deleteSelection() }
  ];
  return items;
}

async function pasteFromSystem() {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = (item.types || []).find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      const dataUrl = await fileToDataUrl(new File([blob], 'clipboard.' + type.split('/')[1], { type: type }));
      await addImageNode(dataUrl, { title: '剪贴板图片', source: 'paste' });
      return;
    }
    toast('系统剪贴板里没有图片', { type: 'warn', hint: '先复制一张图片，再按 Ctrl V', timeout: 4200 });
  } catch (err) {
    toast('浏览器拒绝了剪贴板读取', { type: 'warn', hint: '可直接在页面上按 Ctrl V 粘贴', timeout: 5000 });
  }
}

/* ================================================================== *
 * 快捷键
 * ================================================================== */

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = isTyping(e.target);

    // 输入框内只放行少数全局键
    if (typing) {
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); }
      return;
    }

    if (mod && !e.shiftKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'z': e.preventDefault(); { const l = undo(); if (l) toast('已撤销：' + l, { type: 'info', timeout: 1600 }); break; }
        case 'y': e.preventDefault(); { const l = redo(); if (l) toast('已重做：' + l, { type: 'info', timeout: 1600 }); break; }
        case 'd': e.preventDefault(); duplicateSelection(28); return;
        case 'a': e.preventDefault(); setSelection(allNodes().map((n) => n.id)); renderAllNodes(); return;
        case 'g': e.preventDefault(); openGenerateDialog(); return;
        case 'e': e.preventDefault(); openExportDialog(); return;
        case 'k': e.preventDefault(); openPanel('chat'); return;
        case 'p': e.preventDefault(); openPromptStudio({}); return;
        case 'j': e.preventDefault(); toggleTheme(); syncThemeUI(); return;
        case 's': e.preventDefault(); saveNow(); return;
        case ',': e.preventDefault(); openSettings('ai'); return;
        case '=': case '+': e.preventDefault(); zoomAt(1.25); return;
        case '-': case '_': e.preventDefault(); zoomAt(1 / 1.25); return;
        case '0': e.preventDefault(); resetZoom(); return;
        default: break;
      }
    }
    if (mod && e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === 'z') { e.preventDefault(); const l = redo(); if (l) toast('已重做：' + l, { type: 'info', timeout: 1600 }); return; }
      if (k === 'u') { e.preventDefault(); runToolOnSelection('upscale'); return; }
      if (k === 'm') { e.preventDefault(); runToolOnSelection('matting'); return; }
      if (k === 'r') { e.preventDefault(); runToolOnSelection('reverse'); return; }
      if (k === 'v') { e.preventDefault(); openVideoDialog({}); return; }
    }
    if (e.shiftKey && !mod) {
      if (e.key === '1' || e.key === '!') { e.preventDefault(); fitToContent(90, true); return; }
      if (e.key === '0' || e.key === ')') { e.preventDefault(); resetZoom(); return; }
    }

    switch (e.key) {
      case 'Delete': case 'Backspace': e.preventDefault(); deleteSelection(); return;
      case 'Escape': closeMenu(); closeToolMenu(); if (state.selection.size) { setSelection([]); renderAllNodes(); } return;
      case 'F1': e.preventDefault(); openHelp(); return;
      case 'v': case 'V': setTool('select'); return;
      case 'h': case 'H': setTool('pan'); return;
      case 'l': case 'L': {
        const lp = document.getElementById('locator-panel');
        if (lp) { lp.classList.toggle('hidden'); updateLocator(); }
        return;
      }
      case 'Enter': {
        const sel = selectedNodes();
        if (sel.length === 1 && (sel[0].type === 'text' || sel[0].type === 'note')) { e.preventDefault(); startTextEdit(sel[0].id); }
        else if (sel.length === 1 && sel[0].type === 'image') { e.preventDefault(); runTool('generate', sel[0].id); }
        return;
      }
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': {
        if (!state.selection.size) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        selectedNodes().forEach((n) => updateNode(n.id, { x: n.x + dx, y: n.y + dy }, { silent: true }));
        renderAllNodes();
        nudgeCommit();
        return;
      }
      default: break;
    }
  });
}

let nudgeTimer = null;
function nudgeCommit() {
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => {
    bus.emit('history:push', { label: '移动节点' });
    bus.emit('project:save-request');
  }, 500);
}

function saveNow() {
  try {
    localStorage.setItem('starry-canvas:project:v1', JSON.stringify(serializeProject()));
    toast('工程已保存到浏览器本地', { type: 'ok', hint: '也可在「设置 · 数据」导出 JSON 存档', timeout: 3200 });
  } catch (err) {
    toast('保存失败', { type: 'err', hint: String(err.message || err).slice(0, 160), timeout: 6000 });
  }
}

/* ================================================================== *
 * 生命周期
 * ================================================================== */

function bindLifecycle() {
  window.addEventListener('beforeunload', () => {
    try { localStorage.setItem('starry-canvas:project:v1', JSON.stringify(serializeProject())); } catch (_) { /* 配额不足时忽略 */ }
  });
  // 面板销毁时清理各自的订阅（由各 render 函数监听 panel:destroy）
  on(window, 'resize', throttle(() => { requestBackgroundRedraw(); syncHud(); }, 120));

  // 定位面板折叠
  const lp = document.getElementById('locator-panel');
  if (lp) {
    const header = lp.querySelector('.locator-header');
    const btn = lp.querySelector('.locator-toggle');
    if (header) {
      header.addEventListener('click', (e) => {
        if (e.target.closest('.locator-toggle')) return;
        lp.classList.toggle('collapsed');
        if (btn) btn.textContent = lp.classList.contains('collapsed') ? '+' : '−';
      });
    }
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        lp.classList.toggle('collapsed');
        btn.textContent = lp.classList.contains('collapsed') ? '+' : '−';
      });
    }
  }
}

function hideSplash() {
  const app = $id('app');
  if (app) app.classList.remove('boot');
  const sp = $id('boot-splash');
  if (sp) setTimeout(() => sp.remove(), 700);
}

function welcome(restoredCount) {
  const chat = safeRouteStatus('chat');
  const img = safeRouteStatus('image');
  const ready = chat !== 'err' || img !== 'err';
  if (restoredCount > 0) {
    toast('已恢复上次的画布：' + restoredCount + ' 个节点', { type: 'ok', hint: '双击图片可唤出 AI 工具菜单', timeout: 5200 });
    return;
  }
  toast('星空画布已就绪', {
    type: ready ? 'ok' : 'warn',
    hint: ready
      ? '免费模型可直接生成：按 Ctrl G 输入提示词，或拖入 / 粘贴图片后双击调用变清晰、抠图、反推提示词'
      : '免费通道暂不可用，可在「设置 · AI 接口」填入自备 Key',
    timeout: 9000
  });
}

/* ================================================================== *
 * 启动
 * ================================================================== */

async function boot() {
  try {
    loadSettings();
    applyTheme(state.settings.theme);
    syncThemeUI();

    initEngine();
    initHistory();
    initClipboard();
    registerLocalEngines();

    bindTopbar();
    bindLeftbar();
    bindPanels();
    bindEngineEvents();
    bindKeys();
    bindLifecycle();

    const restored = loadProject();
    renderAllNodes();
    syncHud();
    updateLocator();

    await ai.init();
    refreshEngineBadge();

    // 默认展开生成面板，让首次使用者立刻看到入口
    if (!restored) openPanel('generate');

    state.ready = true;
    hideSplash();
    welcome(restored);

    // 调试入口：控制台可用 window.星空 直接调用能力
    window.starry = {
      state, bus, ai,
      generate: openGenerateDialog, video: openVideoDialog, settings: openSettings,
      exportDialog: openExportDialog, promptStudio: openPromptStudio,
      tool: runTool, panel: openPanel,
      project: { save: saveNow, clear: clearProject, json: serializeProject }
    };
  } catch (err) {
    console.error('[boot] 启动失败', err);
    hideSplash();
    toast('启动失败', { type: 'err', hint: String(err && err.message || err).slice(0, 200), timeout: 12000 });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

/* 保险：如果 boot() 因任何原因未关闭 splash，5 秒后强制移除 */
if (typeof window !== 'undefined') {
  setTimeout(function() {
    var sp = document.getElementById('boot-splash');
    var app = document.getElementById('app');
    if (sp && sp.parentNode) {
      if (app) app.classList.remove('boot');
      sp.style.transition = 'opacity .6s';
      sp.style.opacity = '0';
      sp.style.pointerEvents = 'none';
      setTimeout(function() { sp.remove(); }, 700);
    }
  }, 5000);
}

export { closePanel, createTextNode, refreshEngineBadge, doCreate };
