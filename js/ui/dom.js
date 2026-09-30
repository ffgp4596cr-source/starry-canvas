/**
 * 星空画布 · DOM 与通用工具
 * 只放无业务语义的基础能力：元素构造、事件、Toast、模态框、
 * 图片/文件编解码、下载、剪贴板、节流防抖。
 */

/* ------------------------------------------------------------------ *
 * 基础
 * ------------------------------------------------------------------ */

let seq = 0;
export function uid(prefix = 'n') {
  seq = (seq + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${seq.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export const clamp = (v, min, max) => Math.min(max, Math.max(min, Number.isFinite(+v) ? +v : min));

export function debounce(fn, wait = 220) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, wait);
  };
  wrapped.cancel = () => clearTimeout(t);
  wrapped.flush = (...args) => { clearTimeout(t); t = null; fn(...args); };
  return wrapped;
}

export function throttle(fn, wait = 16) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  return (...args) => {
    const now = Date.now();
    lastArgs = args;
    if (now - last >= wait) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs); }, wait - (now - last));
    }
  };
}

/** 极简 DOM 构造：el('div.cls#id', {onclick}, [children]) */
export function el(spec, props = {}, children = null) {
  let tag = 'div';
  let cls = '';
  let id = '';
  const m = /^([a-zA-Z0-9-]*)/.exec(spec);
  if (m && m[1]) tag = m[1];
  const clsMatch = spec.match(/\.([^.#]+)/g);
  if (clsMatch) cls = clsMatch.map((s) => s.slice(1)).join(' ');
  const idMatch = spec.match(/#([^.#]+)/);
  if (idMatch) id = idMatch[1];

  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (id) node.id = id;

  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = `${node.className} ${v}`.trim();
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in node && typeof v !== 'object') { try { node[k] = v; } catch (_) { node.setAttribute(k, v); } }
    else node.setAttribute(k, v);
  }

  appendChildren(node, children);
  return node;
}

export function appendChildren(parent, children) {
  if (children === null || children === undefined || children === false) return parent;
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return parent;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function on(target, events, fn, opts) {
  const list = String(events).split(/\s+/).filter(Boolean);
  for (const ev of list) target.addEventListener(ev, fn, opts);
  return () => list.forEach((ev) => target.removeEventListener(ev, fn, opts));
}

/* ------------------------------------------------------------------ *
 * Toast
 * ------------------------------------------------------------------ */

const TOAST_ICONS = { ok: '✓', err: '✕', warn: '⚠', info: '✦' };

export function toast(message, opts = {}) {
  const { type = 'info', hint = '', timeout = type === 'err' ? 7000 : 3200 } = opts;
  const host = document.getElementById('toasts');
  if (!host) { console.log(`[${type}] ${message}`); return null; }

  const node = el(`div.toast.${type}`, {}, [
    el('span.t-ico', { text: TOAST_ICONS[type] || '✦' }),
    el('div.t-body', {}, [
      el('div.t-msg', { text: message }),
      hint ? el('div.t-hint', { text: hint }) : null
    ])
  ]);
  host.appendChild(node);

  const remove = () => {
    if (!node.isConnected) return;
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 240);
  };
  node.addEventListener('click', remove);
  if (timeout > 0) setTimeout(remove, timeout);
  while (host.children.length > 5) host.firstElementChild.remove();
  return { close: remove, node };
}

/* ------------------------------------------------------------------ *
 * 模态框
 * ------------------------------------------------------------------ */

/**
 * @returns {{close:Function, root:HTMLElement, body:HTMLElement}}
 */
export function modal({ title = '', sub = '', body = null, footer = null, size = '', onClose = null, dismissable = true } = {}) {
  const host = document.getElementById('modal-root');
  const bodyEl = el('div.modal-body', {}, body);
  const panel = el(`div.modal${size ? `.${size}` : ''}`, {}, [
    el('div.modal-head', {}, [
      el('div.grow', {}, [
        el('div.modal-title', { text: title }),
        sub ? el('div.modal-sub', { text: sub }) : null
      ]),
      el('button.icon-btn', { text: '✕', title: '关闭（Esc）', onclick: () => close() })
    ]),
    bodyEl,
    footer ? el('div.modal-foot', {}, footer) : null
  ]);
  const mask = el('div.modal-mask', {}, panel);

  const close = () => {
    if (!mask.isConnected) return;
    mask.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
  };
  function onKey(e) {
    if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(); }
  }
  if (dismissable) {
    mask.addEventListener('pointerdown', (e) => { if (e.target === mask) close(); });
    document.addEventListener('keydown', onKey, true);
  }
  host.appendChild(mask);
  return { close, root: mask, body: bodyEl, panel };
}

export function confirmDialog({ title = '确认操作', message = '', okText = '确认', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v); m.close(); };
    const m = modal({
      title,
      size: 'narrow',
      body: el('div', { style: { fontSize: '13px', lineHeight: '1.7', color: 'var(--text-2)' }, html: message }),
      footer: [
        el('button.btn.ghost', { text: cancelText, onclick: () => finish(false) }),
        el(`button.btn${danger ? '.danger' : '.primary'}`, { text: okText, onclick: () => finish(true) })
      ],
      onClose: () => finish(false)
    });
    setTimeout(() => { const b = m.panel.querySelector('.modal-foot .btn:last-child'); if (b) b.focus(); }, 30);
  });
}

/** 全屏遮罩式忙碌提示，返回关闭函数 */
export function busyVeil(text = '处理中…') {
  const card = el('div.bv-card', {}, [
    el('div.spinner', { style: { width: '26px', height: '26px', borderWidth: '3px' } }),
    el('div.bv-text', { text })
  ]);
  const veil = el('div.busy-veil', {}, card);
  document.body.appendChild(veil);
  let closed = false;
  return {
    update(t) { card.querySelector('.bv-text').textContent = t; },
    close() { if (closed) return; closed = true; veil.remove(); }
  };
}

/* ------------------------------------------------------------------ *
 * 图片 / 文件编解码
 * ------------------------------------------------------------------ */

export function readImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败，可能已损坏或格式不支持'));
    img.src = src;
  });
}

export function loadImageSize(src) {
  return readImage(src).then((img) => ({ width: img.naturalWidth, height: img.naturalHeight, img }));
}

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(blob);
  });
}

export function dataUrlToBlob(dataUrl) {
  const [head, body] = String(dataUrl).split(',');
  const mime = /data:([^;]+)/.exec(head)?.[1] || 'application/octet-stream';
  const isB64 = /;base64/i.test(head);
  const bin = isB64 ? atob(body) : decodeURIComponent(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export function canvasToDataUrl(canvas, mime = 'image/png', quality = 0.92) {
  if (mime === 'image/png') return canvas.toDataURL('image/png');
  return canvas.toDataURL(mime, quality);
}

export function canvasToBlob(canvas, mime = 'image/png', quality = 0.92) {
  return new Promise((resolve) => {
    // Safari 对部分 mime 会回调 null，做降级
    canvas.toBlob((b) => resolve(b || dataUrlToBlob(canvasToDataUrl(canvas, mime, quality))), mime, quality);
  });
}

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function humanSize(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    fr.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  setTimeout(() => URL.revokeObjectURL(url), 20000);
}

export function downloadDataUrl(dataUrl, filename) {
  triggerDownload(dataUrl, filename);
}

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = sanitizeFilename(filename);
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function sanitizeFilename(name) {
  return String(name || 'starry-canvas')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'starry-canvas';
}

export function timestampName(prefix = '星空画布', ext = 'png') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}

/* ------------------------------------------------------------------ *
 * 剪贴板
 * ------------------------------------------------------------------ */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // 降级：隐藏 textarea + execCommand
    try {
      const ta = el('textarea', { style: { position: 'fixed', left: '-9999px', top: '0' }, value: text });
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (__) { return false; }
  }
}

/** 把图片写入系统剪贴板（需 https 或 localhost 环境） */
export async function copyImageToClipboard(dataUrl) {
  if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') {
    throw new Error('当前浏览器不支持写入图片剪贴板（需 Chrome/Edge 且在 https 或 localhost 下）');
  }
  // ClipboardItem 对 PNG 支持最稳，统一转 PNG
  const png = await convertToPng(dataUrl);
  const blob = dataUrlToBlob(png);
  await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
  return true;
}

export async function convertToPng(dataUrl) {
  const img = await readImage(dataUrl);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

/* ------------------------------------------------------------------ *
 * 其它
 * ------------------------------------------------------------------ */

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function escapeAttr(s) { return escapeHtml(s); }

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 计算包含所有矩形的包围盒 */
export function boundingBox(rects) {
  if (!rects.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function gcd(a, b) { return b ? gcd(b, a % b) : Math.abs(a); }

export function ratioLabel(w, h) {
  if (!w || !h) return '';
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  return `${Math.round(w) / g}:${Math.round(h) / g}`;
}
