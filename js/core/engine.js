/**
 * 星空画布 · 无限画布引擎
 * ------------------------------------------------------------------
 * 无限性的实现方式：
 *  - 世界层 #world 是一个 0×0 的原点容器，节点用绝对世界坐标定位，
 *    容器整体靠 transform: translate(x,y) scale(k) 映射到屏幕，
 *    因此画布没有任何边界，向任意方向蔓延都不会遇到"墙"。
 *  - 背景星空与网格用「世界坐标哈希 + 可视区裁剪」实时绘制，
 *    同样是无限的，缩放平移时星点会正确跟随。
 */

import {
  state, bus, setViewport, screenToWorld, worldToScreen,
  setSelection, clearSelection, selectedNodes, bringToFront, updateNode, createNode
} from './state.js';
import { el, clamp, on, throttle, boundingBox, makeCanvas } from '../ui/dom.js';

const stage = () => document.getElementById('stage');
const worldEl = () => document.getElementById('world');
const nodesEl = () => document.getElementById('nodes');
const bgCanvas = () => document.getElementById('bg-canvas');

/** id -> DOM 元素 */
const elements = new Map();
let bgCtx = null;
let bgRaf = 0;
let spaceDown = false;
let interaction = null;

/* ================================================================== *
 * 背景：无限星空 + 网格
 * ================================================================== */

/** 确定性哈希：同一世界格子里的星点永远在同一位置，实现"无限且稳定" */
function hash2(ix, iy, seed = 0) {
  let h = ix * 374761393 + iy * 668265263 + seed * 1442695040;
  h = (h ^ (h >> 13)) * 1274126177;
  h = h ^ (h >> 16);
  return ((h >>> 0) % 100000) / 100000;
}

function drawBackground() {
  const canvas = bgCanvas();
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = stage().clientWidth;
  const h = stage().clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const ctx = bgCtx || (bgCtx = canvas.getContext('2d'));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { x: vx, y: vy, scale } = state.viewport;
  const isDark = state.settings.theme !== 'light';
  const accent = isDark ? [76, 201, 240] : [26, 115, 232];

  /* --- 网格（世界坐标对齐，两级密度） --- */
  const drawGrid = (step, color, lineWidth) => {
    const s = step * scale;
    if (s < 7) return; // 太密就不画，避免摩尔纹
    const startX = ((vx % s) + s) % s;
    const startY = ((vy % s) + s) % s;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (let gx = startX; gx <= w; gx += s) { ctx.moveTo(Math.round(gx) + 0.5, 0); ctx.lineTo(Math.round(gx) + 0.5, h); }
    for (let gy = startY; gy <= h; gy += s) { ctx.moveTo(0, Math.round(gy) + 0.5); ctx.lineTo(w, Math.round(gy) + 0.5); }
    ctx.stroke();
  };
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--grid').trim() || 'rgba(120,170,255,0.055)';
  const gridStrong = getComputedStyle(document.documentElement).getPropertyValue('--grid-strong').trim() || 'rgba(120,170,255,0.11)';
  if (state.settings.canvas.showGrid !== false) {
    drawGrid(state.settings.canvas.gridSize, gridColor, 1);
    drawGrid(state.settings.canvas.gridSize * 5, gridStrong, 1);
  }

  /* --- 星空 --- */
  if (state.settings.canvas.starfield) {
    const density = clamp(state.settings.canvas.starDensity, 0.3, 2.5);
    const cell = 200; // 世界坐标下每 200px 一格
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(w, h);
    const i0 = Math.floor(tl.x / cell) - 1;
    const i1 = Math.ceil(br.x / cell) + 1;
    const j0 = Math.floor(tl.y / cell) - 1;
    const j1 = Math.ceil(br.y / cell) + 1;
    const count = (i1 - i0) * (j1 - j0);
    if (count > 0 && count < 60000) {
      const perCell = Math.max(1, Math.round(3 * density));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          for (let k = 0; k < perCell; k++) {
            const r1 = hash2(i, j, k * 7 + 1);
            const r2 = hash2(i, j, k * 13 + 2);
            const r3 = hash2(i, j, k * 29 + 3);
            const wx = (i + r1) * cell;
            const wy = (j + r2) * cell;
            const sx = wx * scale + vx;
            const sy = wy * scale + vy;
            if (sx < -4 || sy < -4 || sx > w + 4 || sy > h + 4) continue;
            const mag = r3;
            const radius = (0.35 + mag * 1.25) * clamp(Math.sqrt(scale), 0.5, 1.7);
            const alpha = (isDark ? 0.22 + mag * 0.62 : 0.1 + mag * 0.3);
            // 少数亮星带青/紫色调，形成科技感
            const tinted = mag > 0.93;
            if (tinted) {
              const c = hash2(i, j, 99) > 0.5 ? accent : [160, 107, 255];
              ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
              ctx.beginPath(); ctx.arc(sx, sy, radius * 1.5, 0, Math.PI * 2); ctx.fill();
              if (scale > 0.4) {
                ctx.strokeStyle = `rgba(${c[0]},${c[1]},${c[2]},${alpha * 0.45})`;
                ctx.lineWidth = 0.7;
                const len = radius * 4.5;
                ctx.beginPath();
                ctx.moveTo(sx - len, sy); ctx.lineTo(sx + len, sy);
                ctx.moveTo(sx, sy - len); ctx.lineTo(sx, sy + len);
                ctx.stroke();
              }
            } else {
              ctx.fillStyle = isDark ? `rgba(214,228,255,${alpha})` : `rgba(60,90,150,${alpha})`;
              ctx.beginPath(); ctx.arc(sx, sy, radius, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }
    }
  }

  /* --- 世界原点十字 --- */
  const o = worldToScreen(0, 0);
  if (o.x > -60 && o.x < w + 60 && o.y > -60 && o.y < h + 60) {
    ctx.strokeStyle = `rgba(${accent.join(',')},0.5)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(o.x - 11, o.y); ctx.lineTo(o.x + 11, o.y);
    ctx.moveTo(o.x, o.y - 11); ctx.lineTo(o.x, o.y + 11);
    ctx.stroke();
  }
}

export const requestBackgroundRedraw = () => {
  if (bgRaf) return;
  bgRaf = requestAnimationFrame(() => { bgRaf = 0; drawBackground(); });
};

/* ================================================================== *
 * 视口
 * ================================================================== */

function applyTransform() {
  const { x, y, scale } = state.viewport;
  const w = worldEl();
  if (w) w.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  const zv = document.getElementById('zoom-value');
  if (zv) zv.textContent = `${Math.round(scale * 100)}%`;
  const hp = document.getElementById('hud-pos');
  if (hp) hp.textContent = `x ${Math.round(-x / scale)} · y ${Math.round(-y / scale)}`;
  requestBackgroundRedraw();
}

export function zoomAt(factor, cx, cy) {
  const st = stage();
  const px = cx ?? st.clientWidth / 2;
  const py = cy ?? st.clientHeight / 2;
  const { minScale, maxScale } = state.settings.canvas;
  const before = state.viewport.scale;
  const after = clamp(before * factor, minScale, maxScale);
  if (after === before) return;
  const wx = (px - state.viewport.x) / before;
  const wy = (py - state.viewport.y) / before;
  setViewport({
    scale: after,
    x: px - wx * after,
    y: py - wy * after
  });
  applyTransform();
}

export function setZoom(scale, cx, cy) {
  const st = stage();
  const px = cx ?? st.clientWidth / 2;
  const py = cy ?? st.clientHeight / 2;
  const { minScale, maxScale } = state.settings.canvas;
  const target = clamp(scale, minScale, maxScale);
  const before = state.viewport.scale;
  const wx = (px - state.viewport.x) / before;
  const wy = (py - state.viewport.y) / before;
  setViewport({ scale: target, x: px - wx * target, y: py - wy * target });
  applyTransform();
}

export function fitToContent(padding = 90, animate = true) {
  const nodes = state.nodes.size ? Array.from(state.nodes.values()).filter((n) => !n.hidden) : [];
  const st = stage();
  if (!nodes.length) {
    setViewport({ x: st.clientWidth / 2, y: st.clientHeight / 2, scale: 1 });
    applyTransform();
    return;
  }
  const bb = boundingBox(nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
  const availW = Math.max(80, st.clientWidth - padding * 2);
  const availH = Math.max(80, st.clientHeight - padding * 2);
  const scale = clamp(Math.min(availW / bb.w, availH / bb.h), state.settings.canvas.minScale, 2);
  const target = {
    scale,
    x: st.clientWidth / 2 - (bb.x + bb.w / 2) * scale,
    y: st.clientHeight / 2 - (bb.y + bb.h / 2) * scale
  };
  if (animate) animateViewport(target);
  else { setViewport(target); applyTransform(); }
}

export function centerOnWorld(wx, wy, scale) {
  const st = stage();
  const target = {
    scale: scale ?? state.viewport.scale,
    x: st.clientWidth / 2 - wx * (scale ?? state.viewport.scale),
    y: st.clientHeight / 2 - wy * (scale ?? state.viewport.scale)
  };
  animateViewport(target);
}

export function focusNode(id, scale) {
  const n = state.nodes.get(id);
  if (!n) return;
  centerOnWorld(n.x + n.w / 2, n.y + n.h / 2, scale);
}

function animateViewport(target, duration = 320) {
  const from = { ...state.viewport };
  const t0 = performance.now();
  const step = (now) => {
    const p = clamp((now - t0) / duration, 0, 1);
    const e = 1 - Math.pow(1 - p, 3);
    setViewport({
      scale: from.scale + (target.scale - from.scale) * e,
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e
    });
    applyTransform();
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 把内容放到视口中心附近（新建节点时用） */
export function viewportCenterWorld() {
  const st = stage();
  return screenToWorld(st.clientWidth / 2, st.clientHeight / 2);
}

/** 找一个不重叠的落点：以中心为起点螺旋外扩 */
export function findFreeSpot(w, h, near) {
  const c = near || viewportCenterWorld();
  const base = { x: c.x - w / 2, y: c.y - h / 2 };
  const occupied = Array.from(state.nodes.values());
  const hit = (x, y) => occupied.some((n) => x < n.x + n.w && x + w > n.x && y < n.y + n.h && y + h > n.y);
  if (!hit(base.x, base.y)) return base;
  for (let ring = 1; ring < 24; ring++) {
    const step = 34 * ring;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step], [step, step], [-step, -step], [step, -step], [-step, step]]) {
      const x = base.x + dx;
      const y = base.y + dy;
      if (!hit(x, y)) return { x, y };
    }
  }
  return { x: base.x + Math.random() * 300, y: base.y + Math.random() * 300 };
}

/* ================================================================== *
 * 节点 DOM
 * ================================================================== */

const NODE_TOOLBAR = [
  { id: 'zoom', ico: '⤢', title: '适应屏幕' },
  { id: 'tools', ico: '✨', title: 'AI 工具（双击也可唤出）' },
  { id: 'dup', ico: '⧉', title: '复制一份（Ctrl D）' },
  { id: 'download', ico: '⬇', title: '下载' },
  { id: 'del', ico: '🗑', title: '删除', cls: 'danger' }
];

function buildToolbar(node) {
  const bar = el('div.node-toolbar');
  const items = node.type === 'image' || node.type === 'video'
    ? NODE_TOOLBAR
    : NODE_TOOLBAR.filter((t) => !['tools'].includes(t.id));
  items.forEach((t, i) => {
    if (i > 0 && (t.id === 'dup' || t.id === 'del')) bar.appendChild(el('span.ntb-sep'));
    bar.appendChild(el(`button.ntb${t.cls ? `.${t.cls}` : ''}`, {
      text: t.ico, title: t.title, dataset: { act: t.id },
      onclick: (e) => { e.stopPropagation(); bus.emit('node:action', { id: node.id, action: t.id }); }
    }));
  });
  return bar;
}

function buildHandles() {
  const wrap = el('div.handles');
  for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    wrap.appendChild(el(`div.handle.${dir}`, { dataset: { dir } }));
  }
  return wrap;
}

export function createNodeElement(node) {
  const root = el(`div.node.node-${node.type}`, { dataset: { id: node.id } });

  if (node.type === 'image' || node.type === 'video') {
    const frame = el('div.node-frame');
    const media = node.type === 'video'
      ? el('video', { muted: true, loop: true, playsinline: true, controls: false })
      : el('img', { draggable: false, alt: node.meta.title || '画布图片' });
    if (node.data.src) media.src = node.data.src;
    frame.appendChild(media);
    root.appendChild(frame);
    root.appendChild(el('div.node-badge'));
    if (node.type === 'video') { media.addEventListener('mouseenter', () => media.play().catch(() => {})); media.addEventListener('mouseleave', () => media.pause()); }
  } else {
    const body = el('div.text-body', {
      text: node.data.text || '',
      contenteditable: 'false',
      spellcheck: 'false'
    });
    if (node.type === 'prompt') {
      root.appendChild(el('div.prompt-head', {}, [el('span', { text: '⌘ 提示词' })]));
    }
    root.appendChild(body);
    body.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      body.setAttribute('contenteditable', 'true');
      root.classList.add('editing');
      body.focus();
      const range = document.createRange();
      range.selectNodeContents(body);
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
      sel.collapseToEnd();
    });
    body.addEventListener('blur', () => {
      body.setAttribute('contenteditable', 'false');
      root.classList.remove('editing');
      updateNode(node.id, { data: { text: body.textContent } });
      bus.emit('history:push', { label: '编辑文本' });
    });
    body.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') body.blur();
    });
  }

  root.appendChild(el('div.node-meta'));
  root.appendChild(buildToolbar(node));
  root.appendChild(buildHandles());
  paintNode(root, node);
  return root;
}

export function paintNode(root, node) {
  root.style.left = `${node.x}px`;
  root.style.top = `${node.y}px`;
  root.style.width = `${node.w}px`;
  root.style.height = `${node.h}px`;
  root.style.zIndex = String(100 + Math.round(node.z));
  root.style.transform = node.rotation ? `rotate(${node.rotation}deg)` : '';
  root.classList.toggle('selected', state.selection.has(node.id));
  root.classList.toggle('hidden-node', !!node.hidden);
  root.classList.toggle('no-checker', !!node.data.whiteBackground);

  const media = root.querySelector('.node-frame > img, .node-frame > video');
  if (media && node.data.src && media.src !== node.data.src) media.src = node.data.src;

  const body = root.querySelector('.text-body');
  if (body && body.getAttribute('contenteditable') !== 'true' && body.textContent !== (node.data.text || '')) {
    body.textContent = node.data.text || '';
  }

  // 角标信息
  const badge = root.querySelector('.node-badge');
  if (badge) {
    badge.textContent = '';
    const tags = [];
    if (node.data.natW && node.data.natH) tags.push(`${node.data.natW}×${node.data.natH}`);
    else if (node.type !== 'image') tags.push(`${Math.round(node.w)}×${Math.round(node.h)}`);
    if (node.data.mode) tags.push(node.data.modeLabel || node.data.mode);
    if (node.data.matted) tags.push('已抠图');
    if (node.data.upscaled) tags.push(`×${node.data.upscaleFactor || 2}`);
    // 引擎名放最后并截短，避免角标被长文本挤爆
    if (node.data.engine && tags.length < 3) {
      tags.push(String(node.data.engine).split('·')[0].replace(/（[^）]*）/g, '').trim().slice(0, 8));
    }
    tags.slice(0, 3).forEach((t, i) => badge.appendChild(el(`span.badge${i === 0 ? '' : '.accent'}`, { text: t })));
  }

  const meta = root.querySelector('.node-meta');
  if (meta) {
    meta.style.display = state.settings.canvas.showMeta ? '' : 'none';
    meta.textContent = node.meta.title || '';
  }

  // 处理中覆盖层
  let overlay = root.querySelector('.node-overlay');
  if (node.data.status === 'working') {
    if (!overlay) { overlay = el('div.node-overlay'); root.appendChild(overlay); }
    overlay.className = 'node-overlay';
    overlay.textContent = '';
    overlay.append(
      el('div.ov-ring'),
      el('div.ov-title', { text: node.data.statusTitle || 'AI 正在创作…' }),
      el('div.ov-sub', { text: node.data.statusSub || '' }),
      el('div.ov-bar', {}, el('i'))
    );
  } else if (node.data.status === 'error') {
    if (!overlay) { overlay = el('div.node-overlay'); root.appendChild(overlay); }
    overlay.className = 'node-overlay err';
    overlay.textContent = '';
    overlay.append(
      el('div.ov-title', { text: node.data.statusTitle || '生成失败' }),
      el('div.ov-sub', { text: node.data.statusSub || '' })
    );
  } else if (overlay) {
    overlay.remove();
  }
}

export function renderNode(id) {
  const node = state.nodes.get(id);
  if (!node) return;
  let root = elements.get(id);
  if (!root) {
    root = createNodeElement(node);
    elements.set(id, root);
    nodesEl().appendChild(root);
  }
  paintNode(root, root.__node === node ? node : (root.__node = node, node));
}

export function renderAllNodes() {
  const host = nodesEl();
  const alive = new Set(state.nodes.keys());
  for (const [id, elm] of Array.from(elements)) {
    if (!alive.has(id)) { elm.remove(); elements.delete(id); }
  }
  const sorted = Array.from(state.nodes.values()).sort((a, b) => a.z - b.z);
  for (const node of sorted) {
    let root = elements.get(node.id);
    if (!root) {
      root = createNodeElement(node);
      elements.set(node.id, root);
      host.appendChild(root);
    }
    root.__node = node;
    paintNode(root, node);
  }
  updateHud();
}

export function nodeElement(id) { return elements.get(id); }

function updateHud() {
  const c = document.getElementById('hud-count');
  if (c) c.textContent = `${state.nodes.size} 个节点`;
  const hint = document.getElementById('hint-empty');
  if (hint) hint.classList.toggle('gone', state.nodes.size > 0);
}

/* ================================================================== *
 * 交互
 * ================================================================== */

function hitNode(target) {
  const elm = target?.closest?.('.node');
  return elm ? elm.dataset.id : null;
}

/**
 * 按坐标命中节点。
 * pointerdown 时会 setSelection/bringToFront → renderAllNodes 重排 DOM（z 序变化会 appendChild 搬移元素），
 * 导致随后 click/dblclick 的 e.target 变成公共祖先容器而命中失败，这里用 elementFromPoint 兜底。
 */
function hitNodeAt(e) {
  const direct = hitNode(e.target);
  if (direct) return direct;
  return hitNode(document.elementFromPoint(e.clientX, e.clientY));
}

function bindPointer() {
  const st = stage();

  st.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return; // 右键交给 contextmenu
    st.focus({ preventScroll: true });
    closeToolMenu();

    const handle = e.target.closest?.('.handle');
    const nodeId = hitNode(e.target);
    const editable = e.target.closest?.('.text-body[contenteditable="true"]');
    if (editable) return; // 文本编辑中不拦截
    if (e.target.closest?.('.node-toolbar')) return;

    const wantPan = spaceDown || state.tool === 'pan' || e.button === 1;

    if (handle && nodeId) {
      startResize(e, nodeId, handle.dataset.dir);
      return;
    }
    if (wantPan) {
      startPan(e);
      return;
    }
    if (nodeId) {
      startNodeDrag(e, nodeId);
      return;
    }
    startMarquee(e);
  });

  st.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = st.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
      setViewport({ x: state.viewport.x - e.deltaY, y: state.viewport.y });
      applyTransform();
      return;
    }
    // 触控板捏合会带 ctrlKey；普通滚轮也按缩放处理（符合无限画布直觉）
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const delta = (e.ctrlKey || e.metaKey ? e.deltaY : e.deltaY) * unit;
    const factor = Math.exp(-delta * (e.ctrlKey || e.metaKey ? 0.012 : 0.0022));
    zoomAt(factor, cx, cy);
  }, { passive: false });

  st.addEventListener('dblclick', (e) => {
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const bodyEl = e.target.closest?.('.text-body') || under?.closest?.('.text-body');
    // 仅在文本已处于编辑态时放行（允许在编辑器内定位光标/选词）
    if (bodyEl && bodyEl.getAttribute('contenteditable') === 'true') return;
    const nodeId = hitNodeAt(e);
    if (nodeId) {
      bus.emit('node:dblclick', { id: nodeId, clientX: e.clientX, clientY: e.clientY });
    } else {
      const rect = st.getBoundingClientRect();
      const p = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
      const node = createNode({
        type: 'text', x: p.x - 110, y: p.y - 26, w: 220, h: 92,
        data: { text: '' }, meta: { source: 'canvas', title: '文本卡片' }
      });
      setSelection([node.id]);
      renderAllNodes();
      bus.emit('history:push', { label: '新建文本' });
      setTimeout(() => {
        const body = elements.get(node.id)?.querySelector('.text-body');
        if (body) body.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      }, 20);
    }
  });

  // 拖拽文件进画布
  let dragDepth = 0;
  st.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault(); dragDepth++; st.classList.add('dropping');
  });
  st.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  st.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) st.classList.remove('dropping'); });
  st.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0; st.classList.remove('dropping');
    const rect = st.getBoundingClientRect();
    const p = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    bus.emit('files:dropped', { files: Array.from(e.dataTransfer.files), world: p });
  });

  st.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const nodeId = hitNodeAt(e);
    if (nodeId) {
      if (!state.selection.has(nodeId)) { setSelection([nodeId]); renderAllNodes(); }
      bus.emit('node:contextmenu', { id: nodeId, clientX: e.clientX, clientY: e.clientY });
    } else {
      const rect = st.getBoundingClientRect();
      bus.emit('canvas:contextmenu', { clientX: e.clientX, clientY: e.clientY, world: screenToWorld(e.clientX - rect.left, e.clientY - rect.top) });
    }
  });
}

function startPan(e) {
  const st = stage();
  st.classList.add('panning');
  const startX = e.clientX;
  const startY = e.clientY;
  const origin = { ...state.viewport };
  st.setPointerCapture(e.pointerId);
  const move = (ev) => {
    setViewport({ x: origin.x + (ev.clientX - startX), y: origin.y + (ev.clientY - startY) });
    applyTransform();
  };
  const up = () => {
    st.classList.remove('panning');
    st.removeEventListener('pointermove', move);
    st.removeEventListener('pointerup', up);
    st.removeEventListener('pointercancel', up);
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
}

function startNodeDrag(e, nodeId) {
  const additive = e.shiftKey || e.metaKey || e.ctrlKey;
  if (!state.selection.has(nodeId)) setSelection([nodeId], { additive: false });
  else if (additive) setSelection([nodeId], { additive: true });
  else bringToFront(Array.from(state.selection));
  renderAllNodes();

  const scale = state.viewport.scale;
  const startX = e.clientX;
  const startY = e.clientY;
  const snapshot = selectedNodes().map((n) => ({ id: n.id, x: n.x, y: n.y }));
  if (!snapshot.length) return;
  let moved = false;
  snapshot.forEach(({ id }) => elements.get(id)?.classList.add('dragging'));

  const move = (ev) => {
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 1.5) moved = true;
    for (const s of snapshot) {
      let nx = s.x + dx;
      let ny = s.y + dy;
      if (state.settings.canvas.gridSnap) {
        const g = state.settings.canvas.gridSize;
        nx = Math.round(nx / g) * g;
        ny = Math.round(ny / g) * g;
      }
      const node = state.nodes.get(s.id);
      if (!node || node.locked) continue;
      node.x = nx; node.y = ny;
      paintNode(elements.get(s.id), node);
    }
  };
  const up = () => {
    snapshot.forEach(({ id }) => elements.get(id)?.classList.remove('dragging'));
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    if (moved) {
      bus.emit('nodes:changed');
      bus.emit('history:push', { label: '移动节点' });
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
}

function startResize(e, nodeId, dir) {
  e.stopPropagation();
  const node = state.nodes.get(nodeId);
  if (!node || node.locked) return;
  const st = stage();
  const scale = state.viewport.scale;
  const startX = e.clientX;
  const startY = e.clientY;
  const box = { x: node.x, y: node.y, w: node.w, h: node.h };
  const isImage = node.type === 'image' || node.type === 'video';
  const lockRatio = isImage && !e.altKey; // 图片默认等比，按住 Alt 自由拉伸
  const ratio = box.w / box.h || 1;
  st.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dx = (ev.clientX - startX) / scale;
    const dy = (ev.clientY - startY) / scale;
    let { x, y, w, h } = box;
    if (dir.includes('e')) w = box.w + dx;
    if (dir.includes('s')) h = box.h + dy;
    if (dir.includes('w')) { w = box.w - dx; x = box.x + dx; }
    if (dir.includes('n')) { h = box.h - dy; y = box.y + dy; }
    const minW = isImage ? 40 : 80;
    const minH = isImage ? 40 : 40;
    if (w < minW) { if (dir.includes('w')) x -= minW - w; w = minW; }
    if (h < minH) { if (dir.includes('n')) y -= minH - h; h = minH; }
    if (lockRatio) {
      // 以主导轴为准换算另一轴，保证不变形
      if (Math.abs(dx) * ratio > Math.abs(dy)) { h = w / ratio; if (dir.includes('n')) y = box.y + box.h - h; }
      else { w = h * ratio; if (dir.includes('w')) x = box.x + box.w - w; }
      w = Math.max(minW, w); h = Math.max(minH, h);
    }
    Object.assign(node, { x, y, w: Math.round(w), h: Math.round(h) });
    paintNode(elements.get(nodeId), node);
  };
  const up = () => {
    st.removeEventListener('pointermove', move);
    st.removeEventListener('pointerup', up);
    st.removeEventListener('pointercancel', up);
    bus.emit('node:updated', node);
    bus.emit('nodes:changed');
    bus.emit('history:push', { label: '调整尺寸' });
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
}

function startMarquee(e) {
  const st = stage();
  if (!e.shiftKey) { clearSelection(); renderAllNodes(); }
  const rect = st.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  const box = document.getElementById('marquee');
  box.classList.remove('hidden');
  box.style.left = `${sx}px`; box.style.top = `${sy}px`; box.style.width = '0px'; box.style.height = '0px';
  st.setPointerCapture(e.pointerId);
  let picked = [];

  const move = (ev) => {
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const x = Math.min(sx, cx), y = Math.min(sy, cy);
    const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
    box.style.left = `${x}px`; box.style.top = `${y}px`;
    box.style.width = `${w}px`; box.style.height = `${h}px`;
    const tl = screenToWorld(x, y);
    const br = screenToWorld(x + w, y + h);
    picked = Array.from(state.nodes.values())
      .filter((n) => !n.hidden && n.x < br.x && n.x + n.w > tl.x && n.y < br.y && n.y + n.h > tl.y)
      .map((n) => n.id);
    setSelection(picked, { additive: e.shiftKey });
    for (const [id, elm] of elements) elm.classList.toggle('selected', state.selection.has(id));
  };
  const up = () => {
    box.classList.add('hidden');
    st.removeEventListener('pointermove', move);
    st.removeEventListener('pointerup', up);
    st.removeEventListener('pointercancel', up);
    if (picked.length) bus.emit('selection:changed', picked);
  };
  st.addEventListener('pointermove', move);
  st.addEventListener('pointerup', up);
  st.addEventListener('pointercancel', up);
}

function closeToolMenu() {
  const m = document.getElementById('tool-menu');
  if (m) m.classList.add('hidden');
}

function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !isTyping(e.target)) {
      if (!spaceDown) { spaceDown = true; stage().classList.add('space-pan'); e.preventDefault(); }
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'Space') { spaceDown = false; stage().classList.remove('space-pan'); }
  });
  window.addEventListener('blur', () => { spaceDown = false; stage().classList.remove('space-pan'); });
}

export function isTyping(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/* ================================================================== *
 * 初始化
 * ================================================================== */

export function initEngine() {
  const st = stage();
  bindPointer();
  bindKeys();
  applyTransform();
  renderAllNodes();

  const onResize = throttle(() => { requestBackgroundRedraw(); }, 80);
  on(window, 'resize', onResize);

  bus.on('viewport:changed', () => { requestBackgroundRedraw(); updateLocator(); });
  bus.on('theme:changed', () => { bgCtx = null; requestBackgroundRedraw(); });
  bus.on('nodes:changed', () => { renderAllNodes(); updateLocator(); state.saveProject?.(); saveProjectNow(); });
  bus.on('node:updated', (n) => renderNode(n.id));
  bus.on('selection:changed', () => {
    for (const [id, elm] of elements) elm.classList.toggle('selected', state.selection.has(id));
  });
  bus.on('settings:changed', () => { requestBackgroundRedraw(); renderAllNodes(); });

  // 首帧：把视口摆到世界原点居中
  requestAnimationFrame(() => {
    const { x, y, scale } = state.viewport;
    if (!x && !y && scale === 1) {
      setViewport({ x: st.clientWidth / 2, y: st.clientHeight / 2 });
    }
    applyTransform();
    requestBackgroundRedraw();
  });

  return { applyTransform, renderAllNodes };
}

/* ================================================================== *
 * 定位面板
 * ================================================================== */

export function updateLocator() {
  const panel = document.getElementById('locator-panel');
  if (!panel || panel.classList.contains('hidden')) return;

  const centerEl = document.getElementById('locator-center');
  const nearestEl = document.getElementById('locator-nearest');
  const dirEl = document.getElementById('locator-dir');
  const countEl = document.getElementById('locator-count');

  // 视口中心的世界坐标
  const st = stage();
  const cx = -(state.viewport.x - st.clientWidth / 2) / state.viewport.scale;
  const cy = -(state.viewport.y - st.clientHeight / 2) / state.viewport.scale;
  if (centerEl) centerEl.textContent = `x ${Math.round(cx)} · y ${Math.round(cy)}`;

  // 节点总数
  if (countEl) countEl.textContent = `${state.nodes.size}`;

  // 最近节点
  if (!state.nodes.size) {
    if (nearestEl) nearestEl.textContent = '—';
    if (dirEl) dirEl.textContent = '—';
    return;
  }

  let best = null;
  let bestDist = Infinity;
  for (const n of state.nodes.values()) {
    if (n.hidden) continue;
    const nx = n.x + n.w / 2;
    const ny = n.y + n.h / 2;
    const dx = nx - cx;
    const dy = ny - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) { bestDist = dist; best = { dx, dy, dist, n }; }
  }

  if (!best) {
    if (nearestEl) nearestEl.textContent = '—';
    if (dirEl) dirEl.textContent = '—';
    return;
  }

  if (nearestEl) nearestEl.textContent = `${Math.round(best.dist)}px`;
  // 方向：角度 → 8 向文字
  const angle = Math.atan2(best.dy, best.dx) * (180 / Math.PI);
  const dirs = ['→ 东', '↗ 东北', '↑ 北', '↖ 西北', '← 西', '↙ 西南', '↓ 南', '↘ 东南'];
  const idx = Math.round(((angle + 360) % 360) / 45) % 8;
  if (dirEl) dirEl.textContent = dirs[idx];
}

let saveTimer = null;
function saveProjectNow() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => bus.emit('project:save-request'), 900);
}

export { applyTransform, spaceDown };
