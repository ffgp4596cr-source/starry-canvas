/**
 * 星空画布 · 复制 / 粘贴 / 拖入
 * ------------------------------------------------------------------
 * 三条独立通道，互不干扰：
 *   1. 系统剪贴板 → 画布：Ctrl V 粘贴截图、复制的图片文件、文本
 *   2. 画布 → 系统剪贴板：Ctrl C 把选中图片写入剪贴板（PNG），可直接粘到聊天/PS
 *   3. 画布内部：Ctrl C / Ctrl V 复制节点（含多选），Ctrl D 就地复制一份
 * 另外处理文件拖拽与文件选择器。
 */

import { state, bus, createNode, setSelection, updateNode, selectedNodes } from '../core/state.js';
import { findFreeSpot, viewportCenterWorld, renderAllNodes } from '../core/engine.js';
import {
  blobToDataUrl, fileToDataUrl, readImage, toast, copyText,
  copyImageToClipboard, uid, clamp
} from '../ui/dom.js';

const MAX_PASTE_EDGE = 6000;

/** 依据图片真实尺寸决定节点大小（大图收敛到合理视觉尺寸，原始像素保留在 data.natW/natH） */
export function nodeSizeForImage(natW, natH, maxBox = 460) {
  const k = Math.min(1, maxBox / Math.max(natW, natH));
  return { w: Math.max(60, Math.round(natW * k)), h: Math.max(60, Math.round(natH * k)) };
}

/** 从 dataURL 建一个图片节点；world 为世界坐标落点（左上角） */
export async function addImageNode(dataUrl, opts = {}) {
  const { world = null, title = '', source = 'paste', selectIt = true, maxBox = 460 } = opts;
  let natW = 0, natH = 0;
  try {
    const img = await readImage(dataUrl);
    natW = img.naturalWidth; natH = img.naturalHeight;
  } catch (err) {
    toast('图片无法解析，已跳过', { type: 'err', hint: String(err.message || err) });
    return null;
  }
  const size = nodeSizeForImage(natW, natH, maxBox);
  const spot = world ? { x: world.x - size.w / 2, y: world.y - size.h / 2 } : findFreeSpot(size.w, size.h);
  const node = createNode({
    type: 'image',
    x: Math.round(spot.x), y: Math.round(spot.y),
    w: size.w, h: size.h,
    data: {
      src: dataUrl,
      natW, natH,
      mime: /^data:([^;]+)/.exec(dataUrl)?.[1] || 'image/png',
      bytes: Math.round(dataUrl.length * 0.75)
    },
    meta: { source, title: title || `图片 ${natW}×${natH}` }
  });
  if (selectIt) setSelection([node.id]);
  renderAllNodes();
  bus.emit('history:push', { label: '添加图片' });
  bus.emit('project:save-request');
  return node;
}

export async function addImageFiles(files, world = null) {
  const list = Array.from(files || []);
  if (!list.length) return [];
  const created = [];
  let offsetIdx = 0;
  for (const file of list) {
    const isImage = /^image\//.test(file.type) || /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name || '');
    const isVideo = /^video\//.test(file.type);
    if (file.type === 'application/json' || /\.json$/i.test(file.name || '')) {
      try {
        const text = await file.text();
        const obj = JSON.parse(text);
        if (obj?.app === '星空画布' || Array.isArray(obj?.nodes)) {
          bus.emit('project:import', { project: obj, source: file.name });
          continue;
        }
        const node = createNode({
          type: 'text', w: 320, h: 200,
          data: { text: text.slice(0, 20000) },
          meta: { source: 'file', title: file.name }
        });
        created.push(node);
      } catch (err) {
        toast(`解析 ${file.name} 失败`, { type: 'err', hint: String(err.message || err) });
      }
      continue;
    }
    if (!isImage && !isVideo) {
      toast(`已跳过 ${file.name}`, { type: 'warn', hint: '画布目前接受图片、视频与 JSON 工程文件' });
      continue;
    }
    if (file.size > 40 * 1024 * 1024) {
      toast(`${file.name} 超过 40MB，已跳过`, { type: 'warn' });
      continue;
    }
    const dataUrl = await fileToDataUrl(file);
    if (isVideo) {
      const spot = world ? { x: world.x + offsetIdx * 34, y: world.y + offsetIdx * 34 } : findFreeSpot(420, 240);
      const node = createNode({
        type: 'video', x: Math.round(spot.x), y: Math.round(spot.y), w: 420, h: 240,
        data: { src: dataUrl, mime: file.type },
        meta: { source: 'file', title: file.name }
      });
      created.push(node);
    } else {
      const spot = world ? { x: world.x + offsetIdx * 34, y: world.y + offsetIdx * 34 } : null;
      const node = await addImageNode(dataUrl, { world: spot, title: file.name, source: 'file' });
      if (node) created.push(node);
    }
    offsetIdx++;
  }
  if (created.length) {
    setSelection(created.map((n) => n.id));
    renderAllNodes();
    bus.emit('history:push', { label: '导入文件' });
    toast(`已载入 ${created.length} 个文件到画布`, { type: 'ok' });
  }
  return created;
}

/* ------------------------------------------------------------------ *
 * 内部剪贴板（节点快照）
 * ------------------------------------------------------------------ */

function snapshotNodes(nodes) {
  return nodes.map((n) => ({
    type: n.type, w: n.w, h: n.h, rotation: n.rotation,
    data: { ...n.data },
    meta: { ...n.meta, source: 'copy' }
  }));
}

export function copySelectionToInternal() {
  const nodes = selectedNodes();
  if (!nodes.length) return false;
  state.clipboard = snapshotNodes(nodes);
  return true;
}

export function pasteInternal(offset = 26) {
  if (!state.clipboard?.length) return [];
  const base = viewportCenterWorld();
  const created = [];
  state.clipboard.forEach((snap, i) => {
    const spot = findFreeSpot(snap.w, snap.h, { x: base.x + i * offset, y: base.y + i * offset });
    const node = createNode({
      type: snap.type,
      x: Math.round(spot.x), y: Math.round(spot.y),
      w: snap.w, h: snap.h, rotation: snap.rotation || 0,
      data: { ...snap.data },
      meta: { ...snap.meta, source: 'paste', title: snap.meta.title }
    });
    created.push(node);
  });
  setSelection(created.map((n) => n.id));
  renderAllNodes();
  bus.emit('history:push', { label: '粘贴节点' });
  return created;
}

export function duplicateSelection(offset = 28) {
  const nodes = selectedNodes();
  if (!nodes.length) return [];
  const created = [];
  for (const n of nodes) {
    const spot = { x: n.x + offset, y: n.y + offset };
    const node = createNode({
      type: n.type, x: Math.round(spot.x), y: Math.round(spot.y),
      w: n.w, h: n.h, rotation: n.rotation,
      data: { ...n.data },
      meta: { ...n.meta, source: 'duplicate', createdAt: Date.now() }
    });
    created.push(node);
  }
  setSelection(created.map((n) => n.id));
  renderAllNodes();
  bus.emit('history:push', { label: '复制节点' });
  return created;
}

/* ------------------------------------------------------------------ *
 * 系统剪贴板
 * ------------------------------------------------------------------ */

async function handlePasteEvent(e) {
  const cd = e.clipboardData;
  if (!cd) return;
  // 正在编辑文本时不拦截，让浏览器正常粘贴文字
  const t = e.target;
  if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;

  const items = Array.from(cd.items || []);
  const imageItems = items.filter((it) => it.kind === 'file' && /^image\//.test(it.type));
  if (imageItems.length) {
    e.preventDefault();
    const files = imageItems.map((it) => it.getAsFile()).filter(Boolean);
    const nodes = [];
    for (const f of files) {
      const dataUrl = await blobToDataUrl(f);
      const node = await addImageNode(dataUrl, { source: 'paste', title: '剪贴板图片' });
      if (node) nodes.push(node);
    }
    if (nodes.length) {
      setSelection(nodes.map((n) => n.id));
      toast(`已粘贴 ${nodes.length} 张图片`, { type: 'ok', timeout: 1800 });
    }
    return;
  }

  const files = Array.from(cd.files || []);
  if (files.length) {
    e.preventDefault();
    await addImageFiles(files, null);
    return;
  }

  const text = cd.getData('text/plain');
  if (text && text.trim()) {
    e.preventDefault();
    // 如果复制的是 dataURL 图片，直接当图片处理
    if (/^data:image\//.test(text.trim())) {
      const node = await addImageNode(text.trim(), { source: 'paste', title: '剪贴板图片' });
      if (node) { setSelection([node.id]); toast('已粘贴剪贴板图片', { type: 'ok', timeout: 1800 }); }
      return;
    }
    const c = viewportCenterWorld();
    const lines = text.split('\n').length;
    const node = createNode({
      type: 'text',
      x: Math.round(c.x - 160), y: Math.round(c.y - 40),
      w: 320, h: clamp(60 + lines * 22, 60, 420),
      data: { text },
      meta: { source: 'paste', title: '粘贴的文本' }
    });
    setSelection([node.id]);
    renderAllNodes();
    bus.emit('history:push', { label: '粘贴文本' });
    toast('已粘贴为文本卡片', { type: 'ok', timeout: 1800 });
  }
}

async function handleCopyEvent(e) {
  const t = e.target;
  if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return; // 让浏览器复制选中文本
  const nodes = selectedNodes();
  if (!nodes.length) return;
  copySelectionToInternal();

  const imgNode = nodes.filter((n) => n.type === 'image' && n.data.src).sort((a, b) => b.z - a.z)[0];
  if (imgNode) {
    e.preventDefault();
    try {
      await copyImageToClipboard(imgNode.data.src);
      toast('图片已复制到系统剪贴板', { type: 'ok', hint: '可直接粘贴到聊天窗口、PS 或其他应用', timeout: 2400 });
    } catch (err) {
      toast('已复制到画布内部剪贴板', { type: 'warn', hint: `${err.message}。画布内 Ctrl V 仍可使用`, timeout: 5200 });
    }
    return;
  }
  const textNode = nodes.find((n) => n.data.text);
  if (textNode) {
    e.preventDefault();
    const ok = await copyText(textNode.data.text);
    toast(ok ? '文本已复制到剪贴板' : '已复制到画布内部剪贴板', { type: ok ? 'ok' : 'warn', timeout: 2000 });
  }
}

async function handleCutEvent(e) {
  const t = e.target;
  if (t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const nodes = selectedNodes();
  if (!nodes.length) return;
  e.preventDefault();
  copySelectionToInternal();
  const imgNode = nodes.find((n) => n.type === 'image' && n.data.src);
  if (imgNode) {
    try { await copyImageToClipboard(imgNode.data.src); } catch (_) { /* 内部剪贴板已可用 */ }
  }
  bus.emit('nodes:delete', { ids: nodes.map((n) => n.id), reason: 'cut' });
}

/** 把图片写入系统剪贴板（供工具栏按钮调用） */
export async function copyNodeImageToSystem(id) {
  const node = state.nodes.get(id);
  if (!node?.data?.src) { toast('该节点没有图片内容', { type: 'warn' }); return false; }
  try {
    await copyImageToClipboard(node.data.src);
    toast('图片已复制到系统剪贴板', { type: 'ok', timeout: 2200 });
    return true;
  } catch (err) {
    toast('复制失败', { type: 'err', hint: err.message });
    return false;
  }
}

export function initClipboard() {
  window.addEventListener('paste', handlePasteEvent);
  window.addEventListener('copy', handleCopyEvent);
  window.addEventListener('cut', handleCutEvent);

  bus.on('files:dropped', ({ files, world }) => { addImageFiles(files, world); });

  // 文件选择器
  const input = document.getElementById('file-input');
  if (input) {
    input.addEventListener('change', async () => {
      if (input.files?.length) await addImageFiles(input.files, null);
      input.value = '';
    });
  }
}

export function pickFiles(accept = 'image/*') {
  const input = document.getElementById('file-input');
  if (!input) return;
  input.accept = accept;
  input.click();
}

export { MAX_PASTE_EDGE };
