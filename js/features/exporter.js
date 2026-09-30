/**
 * 星空画布 · 导出与下载
 * ------------------------------------------------------------------
 * 支持格式：PNG / JPEG / WebP / SVG / JSON 工程存档 / WebM 视频
 * 导出范围：选中节点（多选自动合并包围盒）或整个画布
 * 可控项：倍率（1x/2x/3x/4x）、质量、背景（透明/白/黑/自定义）、文件名
 * 视频：把画布上的图片按运镜动画录制为 WebM，不需要任何云端接口
 */

import { state, bus, allNodes, selectedNodes, serializeProject, modeById } from '../core/state.js';
import {
  el, modal, toast, makeCanvas, readImage, canvasToBlob, downloadBlob,
  downloadDataUrl, timestampName, sanitizeFilename, clamp, humanSize, boundingBox, escapeHtml
} from '../ui/dom.js';

/* ================================================================== *
 * 渲染：节点 / 画布 → canvas
 * ================================================================== */

function fillBackground(ctx, w, h, background) {
  if (!background || background === 'transparent') return;
  ctx.fillStyle = background === 'checker' ? '#ffffff' : background;
  ctx.fillRect(0, 0, w, h);
}

export async function renderNodesToCanvas(nodes, opts = {}) {
  const { scale = 2, background = 'transparent', padding = 0 } = opts;
  if (!nodes.length) throw new Error('没有可导出的内容');
  const bb = boundingBox(nodes.map((n) => ({ x: n.x, y: n.y, w: n.w, h: n.h })));
  const W = Math.max(1, Math.round((bb.w + padding * 2) * scale));
  const H = Math.max(1, Math.round((bb.h + padding * 2) * scale));
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  fillBackground(ctx, W, H, background);

  const sorted = nodes.slice().sort((a, b) => a.z - b.z);
  for (const node of sorted) {
    const dx = (node.x - bb.x + padding) * scale;
    const dy = (node.y - bb.y + padding) * scale;
    const dw = node.w * scale;
    const dh = node.h * scale;
    ctx.save();
    if (node.rotation) {
      ctx.translate(dx + dw / 2, dy + dh / 2);
      ctx.rotate((node.rotation * Math.PI) / 180);
      ctx.translate(-dw / 2, -dh / 2);
    } else {
      ctx.translate(dx, dy);
    }
    if (node.data.src && (node.type === 'image' || node.type === 'video')) {
      try {
        const img = await readImage(node.type === 'video' && node.data.poster ? node.data.poster : node.data.src);
        // contain 适配，保持比例
        const k = Math.min(dw / img.naturalWidth, dh / img.naturalHeight);
        const w2 = img.naturalWidth * k;
        const h2 = img.naturalHeight * k;
        ctx.drawImage(img, (dw - w2) / 2, (dh - h2) / 2, w2, h2);
      } catch (_) { /* 单张失败不影响整体导出 */ }
    } else {
      const isNote = node.type === 'note';
      ctx.fillStyle = isNote ? 'rgba(255,205,90,0.95)' : (state.settings.theme === 'light' ? '#ffffff' : 'rgba(16,23,41,0.92)');
      roundRect(ctx, 0, 0, dw, dh, 10 * scale);
      ctx.fill();
      ctx.strokeStyle = isNote ? 'rgba(220,160,20,0.7)' : 'rgba(140,180,255,0.22)';
      ctx.lineWidth = 1 * scale;
      ctx.stroke();
      const text = node.data.text || '';
      if (text) {
        ctx.fillStyle = isNote ? '#3a2a00' : (state.settings.theme === 'light' ? '#0d1526' : '#eaf0ff');
        ctx.font = `${13 * scale}px "PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
        ctx.textBaseline = 'top';
        wrapText(ctx, text, 12 * scale, 12 * scale, dw - 24 * scale, 21 * scale);
      }
    }
    ctx.restore();
  }
  return { canvas, width: W, height: H, box: bb };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const paragraphs = String(text).split('\n');
  let cy = y;
  for (const para of paragraphs) {
    let line = '';
    for (const ch of para) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, x, cy);
        cy += lineH;
        line = ch;
      } else line = test;
    }
    ctx.fillText(line, x, cy);
    cy += lineH;
    if (cy > 4000) break;
  }
}

/* ================================================================== *
 * SVG 导出：光栅图层 + 矢量文本层
 * ================================================================== */

export async function renderNodesToSvg(nodes, opts = {}) {
  const { scale = 1, background = 'transparent', padding = 0 } = opts;
  const { canvas, width, height, box } = await renderNodesToCanvas(nodes, { scale, background, padding });
  const png = canvas.toDataURL('image/png');
  const textLayers = nodes
    .filter((n) => n.data.text)
    .map((n) => {
      const x = (n.x - box.x + padding) * scale + 12 * scale;
      const y = (n.y - box.y + padding) * scale + 22 * scale;
      const lines = String(n.data.text).split('\n').slice(0, 40);
      const tspans = lines
        .map((l, i) => `<tspan x="${x.toFixed(1)}" dy="${i === 0 ? 0 : 20 * scale}">${escapeHtml(l)}</tspan>`)
        .join('');
      return `<text font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="${(13 * scale).toFixed(1)}" fill="${n.type === 'note' ? '#3a2a00' : '#eaf0ff'}">${tspans}</text>`;
    })
    .join('\n  ');

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>星空画布导出</title>
  <image xlink:href="${png}" width="${width}" height="${height}"/>
  ${textLayers}
</svg>`;
  return { svg, width, height, bytes: svg.length };
}

/* ================================================================== *
 * 视频录制（本地运镜合成，无需云端）
 * ================================================================== */

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4'
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const c of candidates) {
    try { if (MediaRecorder.isTypeSupported(c)) return c; } catch (_) { /* 继续尝试 */ }
  }
  return null;
}

/**
 * @param {object} cfg {images:[dataUrl], width, height, secondsPerImage, effect:'kenburns'|'crossfade'|'zoom', fps, onProgress}
 * @returns {Promise<{blob:Blob, mime:string, durationMs:number, width:number, height:number}>}
 */
export async function recordVideo(cfg) {
  const {
    images = [], width = 720, height = 1280, secondsPerImage = 3,
    effect = 'kenburns', fps = 30, onProgress = null
  } = cfg;
  if (!images.length) throw new Error('没有可用于合成视频的图片');
  const mime = pickMime();
  if (!mime) {
    throw new Error('当前浏览器不支持 MediaRecorder，无法在本地合成视频。请使用 Chrome / Edge，或在设置里为「视频」配置云端接口（如通义万相）。');
  }
  const imgs = [];
  for (const src of images) imgs.push(await readImage(src));

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  const stream = canvas.captureStream(fps);
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: clamp(width * height * fps * 0.14, 800000, 12000000) });
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };

  const totalMs = images.length * secondsPerImage * 1000;
  const started = performance.now();

  const drawFrame = (progressGlobal) => {
    const perImage = 1 / images.length;
    const idx = Math.min(images.length - 1, Math.floor(progressGlobal / perImage));
    const local = (progressGlobal - idx * perImage) / perImage; // 0..1
    const img = imgs[idx];
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);

    // 交叉淡入淡出
    const fade = 0.12;
    let alpha = 1;
    if (local < fade) alpha = local / fade;
    else if (local > 1 - fade && idx < images.length - 1) alpha = (1 - local) / fade;
    ctx.globalAlpha = clamp(alpha, 0, 1);

    // 运镜：cover 基础上做缓慢缩放/平移
    const coverK = Math.max(width / img.naturalWidth, height / img.naturalHeight);
    let z = coverK;
    let ox = 0, oy = 0;
    const ease = 0.5 - Math.cos(Math.PI * clamp(local, 0, 1)) / 2;
    if (effect === 'kenburns') { z = coverK * (1.04 + 0.16 * ease); ox = (0.5 - ease) * width * 0.05; oy = (ease - 0.5) * height * 0.04; }
    else if (effect === 'zoom') { z = coverK * (1.02 + 0.24 * ease); }
    else if (effect === 'pan') { z = coverK * 1.18; ox = (0.5 - ease) * width * 0.16; }
    else { z = coverK * 1.06; }

    const dw = img.naturalWidth * z;
    const dh = img.naturalHeight * z;
    ctx.drawImage(img, (width - dw) / 2 + ox, (height - dh) / 2 + oy, dw, dh);
    ctx.globalAlpha = 1;
  };

  return new Promise((resolve, reject) => {
    recorder.onerror = (e) => reject(new Error(`录制失败：${e.error?.name || '未知错误'}`));
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime });
      resolve({ blob, mime, durationMs: totalMs, width, height, bytes: blob.size });
    };
    recorder.start(120);
    const tick = () => {
      const elapsed = performance.now() - started;
      const p = clamp(elapsed / totalMs, 0, 1);
      drawFrame(p);
      onProgress?.(p);
      if (p < 1) requestAnimationFrame(tick);
      else setTimeout(() => { try { recorder.stop(); } catch (_) { /* 已停止 */ } stream.getTracks().forEach((t) => t.stop()); }, 120);
    };
    requestAnimationFrame(tick);
  });
}

/* ================================================================== *
 * 导出对话框
 * ================================================================== */

const SCALE_OPTIONS = [1, 2, 3, 4];
const BG_OPTIONS = [
  { id: 'transparent', label: '透明' },
  { id: '#ffffff', label: '白底' },
  { id: '#000000', label: '黑底' },
  { id: 'theme', label: '跟随主题' }
];

export function openExportDialog(presetNodeId = null) {
  const hasSelection = selectedNodes().length > 0;
  const s = state.settings.export;
  const st = {
    format: s.format || 'png',
    scope: presetNodeId ? 'node' : (hasSelection ? (s.scope || 'node') : 'canvas'),
    scale: s.scale || 2,
    quality: s.quality ?? 0.92,
    background: s.background || 'transparent',
    filename: timestampName('星空画布', s.format || 'png'),
    padding: 0,
    videoSeconds: 3,
    videoEffect: 'kenburns'
  };
  const formats = state.catalog?.exportFormats || [];

  const previewBox = el('div.exp-preview', {}, el('div.ep-empty', { text: '选择格式与范围后生成预览' }));
  const metaLine = el('div.muted', { style: { marginTop: '8px', fontFamily: 'var(--font-mono)', fontSize: '11px' }, text: '—' });

  const formatList = el('div.format-list');
  const scopeRow = el('div.exp-scope');
  const scaleRow = el('div.chip-row');
  const bgRow = el('div.chip-row');
  const qualityRow = el('div.field', { style: { display: st.format === 'png' || st.format === 'json' || st.format === 'svg' ? 'none' : '' } });
  const videoOpts = el('div.field');
  const nameInput = el('input.input', { value: st.filename, placeholder: '文件名' });

  function targetNodes() {
    if (st.scope === 'node') {
      if (presetNodeId) {
        const n = state.nodes.get(presetNodeId);
        return n ? [n] : [];
      }
      const sel = selectedNodes();
      return sel.length ? sel : allNodes().filter((n) => !n.hidden);
    }
    return allNodes().filter((n) => !n.hidden);
  }

  async function refreshPreview() {
    const nodes = targetNodes();
    if (!nodes.length) {
      previewBox.textContent = '';
      previewBox.appendChild(el('div.ep-empty', { text: st.scope === 'node' ? '当前没有选中节点，将导出整个画布' : '画布是空的' }));
      metaLine.textContent = '—';
      return;
    }
    const bg = st.background === 'theme' ? (state.settings.theme === 'light' ? '#f4f7fc' : '#05070f') : st.background;
    try {
      if (st.format === 'json') {
        const json = JSON.stringify(serializeProject(), null, 2);
        const total = allNodes().length;
        metaLine.textContent = `工程存档 · 全部 ${total} 个节点 · ${humanSize(json.length)}`;
        previewBox.textContent = '';
        previewBox.appendChild(el('div.ep-empty', { text: `将导出可重新载入的 JSON 工程文件（含全部 ${total} 个节点、视口位置与图片数据；工程存档始终包含整个画布，范围选项不生效）` }));
        return;
      }
      if (st.format === 'webm') {
        metaLine.textContent = `视频 · ${nodes.filter((n) => n.data.src).length} 帧素材 · 每帧 ${st.videoSeconds}s`;
        previewBox.textContent = '';
        previewBox.appendChild(el('div.ep-empty', { text: '将把画布上的图片按运镜动画合成为 WebM 视频（本地录制，不消耗任何额度）' }));
        return;
      }
      if (st.format === 'svg') {
        const { width, height, bytes } = await renderNodesToSvg(nodes, { scale: 1, background: bg, padding: st.padding });
        metaLine.textContent = `SVG · ${width}×${height} · 约 ${humanSize(bytes)}`;
        previewBox.textContent = '';
        const { canvas } = await renderNodesToCanvas(nodes, { scale: Math.min(st.scale, 2), background: bg, padding: st.padding });
        const img = el('img');
        img.src = canvas.toDataURL('image/png');
        previewBox.appendChild(img);
        return;
      }
      const effScale = st.format === 'png' || st.format === 'jpeg' || st.format === 'webp' ? st.scale : 1;
      const { canvas, width, height } = await renderNodesToCanvas(nodes, { scale: effScale, background: bg, padding: st.padding });
      const blob = await canvasToBlob(canvas, mimeOf(st.format), st.quality);
      metaLine.textContent = `${st.format.toUpperCase()} · ${width}×${height} · ${humanSize(blob.size)} · ${st.scale}x`;
      previewBox.textContent = '';
      const img = el('img');
      img.src = canvas.toDataURL('image/png');
      previewBox.appendChild(img);
    } catch (err) {
      metaLine.textContent = `预览失败：${err.message}`;
    }
  }

  function mimeOf(fmt) {
    return formats.find((f) => f.id === fmt)?.mime || 'image/png';
  }

  function rebuildFormatList() {
    formatList.textContent = '';
    for (const f of formats) {
      const disabled = (f.id === 'webm' && !targetNodes().some((n) => n.data.src));
      formatList.appendChild(el(`button.format-item${st.format === f.id ? '.active' : ''}`, {
        disabled,
        onclick: () => { st.format = f.id; st.filename = swapExt(st.filename, f.id === 'json' ? 'json' : f.id === 'webm' ? 'webm' : f.id === 'svg' ? 'svg' : f.id === 'jpeg' ? 'jpg' : f.id); nameInput.value = st.filename; rebuildFormatList(); syncVisibility(); refreshPreview(); }
      }, [
        el('span.fi-ext', { text: f.id === 'jpeg' ? 'jpg' : f.id }),
        el('div.fi-body', {}, [
          el('div.fi-name', { text: f.label.split('（')[0] }),
          el('div.fi-desc', { text: f.label.includes('（') ? f.label.split('（')[1].replace('）', '') : '' })
        ])
      ]));
    }
  }

  function rebuildChips() {
    scopeRow.textContent = '';
    for (const [id, label] of [['node', presetNodeId ? '当前图片' : (hasSelection ? `选中节点（${selectedNodes().length}）` : '单个节点')], ['canvas', '整个画布']]) {
      scopeRow.appendChild(el(`button.chip${st.scope === id ? '.active' : ''}`, { text: label, onclick: () => { st.scope = id; rebuildChips(); refreshPreview(); } }));
    }
    scaleRow.textContent = '';
    for (const sc of SCALE_OPTIONS) {
      scaleRow.appendChild(el(`button.chip${st.scale === sc ? '.active' : ''}`, { text: `${sc}x`, onclick: () => { st.scale = sc; rebuildChips(); refreshPreview(); } }));
    }
    bgRow.textContent = '';
    for (const b of BG_OPTIONS) {
      bgRow.appendChild(el(`button.chip${st.background === b.id ? '.active' : ''}`, { text: b.label, onclick: () => { st.background = b.id; rebuildChips(); refreshPreview(); } }));
    }
  }

  function syncVisibility() {
    const isRaster = ['png', 'jpeg', 'webp'].includes(st.format);
    qualityRow.style.display = ['jpeg', 'webp'].includes(st.format) ? '' : 'none';
    if (scaleRow.parentElement) scaleRow.parentElement.style.display = isRaster || st.format === 'svg' ? '' : 'none';
    if (bgRow.parentElement) bgRow.parentElement.style.display = isRaster || st.format === 'svg' ? '' : 'none';
    videoOpts.style.display = st.format === 'webm' ? '' : 'none';
  }

  const qualityRange = el('input', { type: 'range', min: '0.4', max: '1', step: '0.01', value: String(st.quality) });
  const qualityVal = el('span.slider-val', { text: `${Math.round(st.quality * 100)}%` });
  qualityRange.addEventListener('input', () => {
    st.quality = Number(qualityRange.value);
    qualityVal.textContent = `${Math.round(st.quality * 100)}%`;
    refreshPreview();
  });
  qualityRow.append(el('label.lbl', { text: '压缩质量' }), el('div.slider-row', {}, qualityRange, qualityVal));

  const secRange = el('input', { type: 'range', min: '1', max: '8', step: '0.5', value: String(st.videoSeconds) });
  const secVal = el('span.slider-val', { text: `${st.videoSeconds}s` });
  secRange.addEventListener('input', () => { st.videoSeconds = Number(secRange.value); secVal.textContent = `${st.videoSeconds}s`; refreshPreview(); });
  const effectSelect = el('select.select', {}, ['kenburns', 'zoom', 'pan', 'crossfade'].map((e2) => el('option', { value: e2, text: { kenburns: 'Ken Burns 缓慢推近', zoom: '正面推近', pan: '横向平移', crossfade: '交叉淡化' }[e2], selected: st.videoEffect === e2 })));
  effectSelect.addEventListener('change', () => { st.videoEffect = effectSelect.value; });
  videoOpts.append(
    el('label.lbl', { text: '每张图片时长' }),
    el('div.slider-row', {}, secRange, secVal),
    el('label.lbl', { text: '运镜效果' }),
    effectSelect
  );

  const doExport = async () => {
    const nodes = targetNodes();
    if (!nodes.length && st.format !== 'json') { toast('没有可导出的内容', { type: 'warn' }); return; }
    const bg = st.background === 'theme' ? (state.settings.theme === 'light' ? '#f4f7fc' : '#05070f') : st.background;
    try {
      if (st.format === 'json') {
        const json = JSON.stringify(serializeProject(), null, 2);
        downloadBlob(new Blob([json], { type: 'application/json' }), st.filename.endsWith('.json') ? st.filename : `${st.filename}.json`);
        toast('工程存档已下载', { type: 'ok', hint: '可直接拖回画布重新载入' });
      } else if (st.format === 'webm') {
        const imgs = nodes.filter((n) => n.data.src).map((n) => n.data.src);
        if (!imgs.length) { toast('没有图片可用于合成视频', { type: 'warn' }); return; }
        const first = await readImage(imgs[0]);
        const ratio = first.naturalWidth / first.naturalHeight;
        let W = 720, H = 1280;
        if (ratio > 1.25) { W = 1280; H = 720; } else if (ratio >= 0.8 && ratio <= 1.25) { W = 1024; H = 1024; }
        const busy = showBusy('正在录制视频…');
        try {
          const out = await recordVideo({
            images: imgs, width: W, height: H,
            secondsPerImage: st.videoSeconds, effect: st.videoEffect, fps: 30,
            onProgress: (p) => busy.update(`正在录制视频… ${Math.round(p * 100)}%`)
          });
          downloadBlob(out.blob, st.filename.endsWith('.webm') || st.filename.endsWith('.mp4') ? st.filename : `${st.filename}.webm`);
          toast(`视频已导出（${humanSize(out.bytes)}）`, { type: 'ok', hint: `${W}×${H} · ${Math.round(out.durationMs / 1000)}s · 本地合成` });
          // 同时把视频落到画布，方便继续编辑（video.js 监听；这里传 blob，避免多建一个 object URL）
          bus.emit('video:created', {
            blob: out.blob, width: W, height: H, mime: out.mime,
            durationMs: out.durationMs, bytes: out.bytes,
            title: `导出视频 ${W}×${H}`
          });
        } finally { busy.close(); }
      } else if (st.format === 'svg') {
        const { svg } = await renderNodesToSvg(nodes, { scale: st.scale, background: bg, padding: st.padding });
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), st.filename.endsWith('.svg') ? st.filename : `${st.filename}.svg`);
        toast('SVG 已导出', { type: 'ok' });
      } else {
        const { canvas, width, height } = await renderNodesToCanvas(nodes, { scale: st.scale, background: bg, padding: st.padding });
        const mime = mimeOf(st.format);
        const blob = await canvasToBlob(canvas, mime, st.quality);
        const ext = st.format === 'jpeg' ? 'jpg' : st.format;
        downloadBlob(blob, st.filename.endsWith(`.${ext}`) ? st.filename : `${st.filename}.${ext}`);
        toast(`${st.format.toUpperCase()} 已导出`, { type: 'ok', hint: `${width}×${height} · ${humanSize(blob.size)}` });
      }
      Object.assign(state.settings.export, { format: st.format, scope: st.scope, scale: st.scale, quality: st.quality, background: st.background });
      bus.emit('settings:changed', state.settings);
      m.close();
    } catch (err) {
      toast('导出失败', { type: 'err', hint: String(err.message || err) });
    }
  };

  const m = modal({
    title: '导出下载',
    sub: '自由选择格式、范围、倍率与背景',
    size: 'wide',
    body: el('div.exp-layout', {}, [
      el('div', {}, [
        previewBox,
        metaLine
      ]),
      el('div.stack', {}, [
        el('div.field', {}, [el('label.lbl', { text: '格式' }), formatList]),
        el('div.field', {}, [el('label.lbl', { text: '范围' }), scopeRow]),
        el('div.field', {}, [el('label.lbl', { text: '导出倍率' }), scaleRow]),
        el('div.field', {}, [el('label.lbl', { text: '背景' }), bgRow]),
        qualityRow,
        videoOpts,
        el('div.field', {}, [el('label.lbl', { text: '文件名' }), nameInput])
      ])
    ]),
    footer: [
      el('button.btn.ghost', { text: '取消', onclick: () => m.close() }),
      el('button.btn.primary', { text: '⬇ 导出', onclick: doExport })
    ]
  });
  nameInput.addEventListener('input', () => { st.filename = nameInput.value || 'starry-canvas'; });
  // 初始化必须放在 modal 挂载之后：syncVisibility 要读 scaleRow/bgRow 的 parentElement
  rebuildFormatList();
  rebuildChips();
  syncVisibility();
  refreshPreview();
  return m;
}

function showBusy(text) {
  const card = el('div.bv-card', {}, [
    el('div.spinner', { style: { width: '26px', height: '26px', borderWidth: '3px' } }),
    el('div.bv-text', { text })
  ]);
  const veil = el('div.busy-veil', {}, card);
  document.body.appendChild(veil);
  return {
    update(t) { const n = card.querySelector('.bv-text'); if (n) n.textContent = t; },
    close() { veil.remove(); }
  };
}

function swapExt(name, ext) {
  const base = String(name).replace(/\.[a-z0-9]+$/i, '');
  return `${base}.${ext}`;
}

/** 快速下载单个节点（工具栏下载按钮用） */
export async function quickDownloadNode(nodeId, format = null) {
  const node = state.nodes.get(nodeId);
  if (!node) return;
  if (node.data.src && (node.type === 'image' || node.type === 'video') && !format) {
    // 原图直出，保留最高质量
    const ext = node.type === 'video' ? 'webm' : (/image\/jpeg/.test(node.data.mime || '') ? 'jpg' : (/image\/webp/.test(node.data.mime || '') ? 'webp' : 'png'));
    if (node.data.src.startsWith('blob:')) {
      try {
        const res = await fetch(node.data.src);
        downloadBlob(await res.blob(), timestampName(node.meta.title || '星空画布', ext));
        toast('已下载原始文件', { type: 'ok' });
        return;
      } catch (_) { /* 回退到重绘 */ }
    }
    downloadDataUrl(node.data.src, timestampName(node.meta.title || '星空画布', ext));
    toast('已下载原图', { type: 'ok', hint: `${node.data.natW || '?'}×${node.data.natH || '?'}` });
    return;
  }
  openExportDialog(nodeId);
}

export { showBusy };
