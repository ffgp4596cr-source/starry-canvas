/**
 * 星空画布 · 本地图像引擎
 * ------------------------------------------------------------------
 * 不依赖任何云端接口，在浏览器里完成：
 *   变清晰（超分）  多阶段高质量重采样 + 可选降噪 + 反锐化掩模
 *   抠图（主体分离）背景色估计 + 边界连通域生长 + Alpha 羽化 + 去色溢
 *   白底图          抠图后合成纯白背景
 *   图像分析        主色 / 明度 / 对比 / 饱和 / 边缘密度 / 背景均匀度
 *                   —— 作为「反推提示词」在没有视觉模型时的可用通道
 * 所有函数都返回 dataURL，便于直接落到画布节点。
 */

import { readImage, makeCanvas, clamp } from '../ui/dom.js';

const MAX_PROCESS_EDGE = 4200; // 超过就先等比压到该尺寸，避免主线程长时间阻塞

/* ================================================================== *
 * 基础像素工具
 * ================================================================== */

function toImageData(src, maxEdge = MAX_PROCESS_EDGE) {
  return readImage(src).then((img) => {
    let w = img.naturalWidth || img.width;
    let h = img.naturalHeight || img.height;
    if (!w || !h) throw new Error('无法读取图片尺寸');
    const k = Math.min(1, maxEdge / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return { canvas, ctx, data: ctx.getImageData(0, 0, w, h), width: w, height: h, srcW: img.naturalWidth, srcH: img.naturalHeight };
  });
}

/** 可分离盒式模糊（对 RGB 或单通道 alpha 都适用） */
function boxBlur(src, w, h, radius, channels = 4, stride = 4) {
  if (radius <= 0) return src.slice();
  const out = new Uint8ClampedArray(src.length);
  const tmp = new Uint8ClampedArray(src.length);
  const win = radius * 2 + 1;
  // 横向
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      const rowStart = y * w * stride;
      for (let i = -radius; i <= radius; i++) {
        sum += src[rowStart + clamp(i, 0, w - 1) * stride + c];
      }
      for (let x = 0; x < w; x++) {
        tmp[rowStart + x * stride + c] = sum / win;
        const removeIdx = clamp(x - radius, 0, w - 1);
        const addIdx = clamp(x + radius + 1, 0, w - 1);
        sum += src[rowStart + addIdx * stride + c] - src[rowStart + removeIdx * stride + c];
      }
    }
  }
  // 纵向
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < channels; c++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) {
        sum += tmp[clamp(i, 0, h - 1) * w * stride + x * stride + c];
      }
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * stride + c] = sum / win;
        const removeIdx = clamp(y - radius, 0, h - 1);
        const addIdx = clamp(y + radius + 1, 0, h - 1);
        sum += tmp[addIdx * w * stride + x * stride + c] - tmp[removeIdx * w * stride + x * stride + c];
      }
    }
  }
  return out;
}

/** 3×3 中值滤波：去椒盐噪点，保边效果好 */
function median3x3(data, w, h) {
  const out = new Uint8ClampedArray(data.length);
  const win = new Uint8Array(9);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const yy = clamp(y + dy, 0, h - 1);
            const xx = clamp(x + dx, 0, w - 1);
            win[k++] = data[(yy * w + xx) * 4 + c];
          }
        }
        win.subarray(0, 9).sort();
        out[i + c] = win[4];
      }
      out[i + 3] = data[i + 3];
    }
  }
  return out;
}

/** 反锐化掩模：out = orig + amount * (orig - blur) */
function unsharpMask(data, w, h, radius, amount, threshold = 2) {
  const blurred = boxBlur(data, w, h, radius, 3, 4);
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const o = data[i + c];
      const diff = o - blurred[i + c];
      out[i + c] = Math.abs(diff) < threshold ? o : clamp(o + diff * amount, 0, 255);
    }
    out[i + 3] = data[i + 3];
  }
  return out;
}

function putAndExport(ctx, imageData, mime = 'image/png', quality = 0.95) {
  ctx.putImageData(imageData, 0, 0);
  return ctx.canvas.toDataURL(mime, quality);
}

/* ================================================================== *
 * 变清晰（本地超分）
 * ================================================================== */

/**
 * @param {string} src dataURL
 * @param {object} opts {factor:1-4, sharpen:0-2, denoise:0-2, maxEdge}
 * @returns {Promise<{dataUrl:string,width:number,height:number,srcWidth:number,srcHeight:number,factor:number}>}
 */
export async function localUpscale(src, opts = {}) {
  const factor = clamp(opts.factor ?? 2, 1, 4);
  const sharpen = clamp(opts.sharpen ?? 0.7, 0, 2);
  const denoise = clamp(opts.denoise ?? 0, 0, 2);
  const t0 = performance.now();

  const base = await toImageData(src, opts.maxEdge || MAX_PROCESS_EDGE);
  const targetW = Math.round(base.srcW * factor);
  const targetH = Math.round(base.srcH * factor);

  // 逐级 2 倍放大比一次性放大细节更好
  let cur = base.canvas;
  let cw = base.width;
  let ch = base.height;
  while (cw < targetW || ch < targetH) {
    const nw = Math.min(targetW, cw * 2);
    const nh = Math.min(targetH, ch * 2);
    const next = makeCanvas(nw, nh);
    const nctx = next.getContext('2d', { willReadFrequently: true });
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cur, 0, 0, nw, nh);
    cur = next; cw = nw; ch = nh;
  }

  const ctx = cur.getContext('2d', { willReadFrequently: true });
  let imageData = ctx.getImageData(0, 0, cw, ch);

  if (denoise > 0) {
    const passes = denoise >= 1.5 ? 2 : 1;
    let px = imageData.data;
    for (let i = 0; i < passes; i++) px = median3x3(px, cw, ch);
    imageData = new ImageData(px, cw, ch);
  }
  if (sharpen > 0) {
    const radius = Math.max(1, Math.round(Math.min(cw, ch) / 320));
    const px = unsharpMask(imageData.data, cw, ch, radius, sharpen, 2);
    imageData = new ImageData(px, cw, ch);
  }

  const dataUrl = putAndExport(ctx, imageData, 'image/png');
  return {
    dataUrl,
    width: cw,
    height: ch,
    srcWidth: base.srcW,
    srcHeight: base.srcH,
    factor,
    engine: `本地超分 ×${factor}`,
    costMs: Math.round(performance.now() - t0)
  };
}

/* ================================================================== *
 * 抠图（本地主体分离）
 * ================================================================== */

function borderColors(data, w, h, sampleStep = 2) {
  const pts = [];
  const push = (x, y) => {
    const i = (y * w + x) * 4;
    pts.push([data[i], data[i + 1], data[i + 2]]);
  };
  for (let x = 0; x < w; x += sampleStep) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y += sampleStep) { push(0, y); push(w - 1, y); }
  if (!pts.length) return { median: [255, 255, 255], variance: 0, samples: 0 };
  const chans = [0, 1, 2].map((c) => pts.map((p) => p[c]).sort((a, b) => a - b));
  const median = chans.map((arr) => arr[arr.length >> 1]);
  let variance = 0;
  for (const p of pts) variance += (p[0] - median[0]) ** 2 + (p[1] - median[1]) ** 2 + (p[2] - median[2]) ** 2;
  variance /= pts.length;
  return { median, variance, samples: pts.length };
}

/**
 * @param {string} src dataURL
 * @param {object} opts {tolerance:0-100, feather:0-8, despill:boolean, bgColors:[[r,g,b]], output:'transparent'|'white'|color}
 */
export async function localMatting(src, opts = {}) {
  const t0 = performance.now();
  const tolerance = clamp(opts.tolerance ?? 28, 2, 90);
  const feather = clamp(opts.feather ?? 1.6, 0, 8);
  const despill = opts.despill !== false;
  const output = opts.output || 'transparent';

  const base = await toImageData(src, opts.maxEdge || MAX_PROCESS_EDGE);
  const { data, width: w, height: h, ctx } = base;
  const px = data.data;

  // 1. 背景色：边界中值 + 用户指定取样点
  const bc = borderColors(px, w, h);
  const bgList = [bc.median, ...(opts.bgColors || [])];
  const tLow = tolerance * 2.4;          // 距离阈值（低）：低于则判为背景
  const tHigh = tLow * 1.85;              // 高于则判为确定前景

  const distToBg = (i) => {
    const r = px[i], g = px[i + 1], b = px[i + 2];
    let best = Infinity;
    for (const bg of bgList) {
      // 加权欧氏距离，贴近人眼对绿色更敏感的特性
      const dr = r - bg[0], dg = g - bg[1], db = b - bg[2];
      const d = Math.sqrt(2 * dr * dr + 4 * dg * dg + 3 * db * db) / 3;
      if (d < best) best = d;
    }
    return best;
  };

  // 2. 从图像边界做连通域生长：只有连到边界的相似色区域才算背景，
  //    这样主体内部与背景同色的部分（如白衬衫）不会被误删。
  const isBg = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const tryPush = (idx) => {
    if (isBg[idx]) return;
    const i = idx * 4;
    if (px[i + 3] === 0) { isBg[idx] = 1; return; } // 已透明的直接算背景
    if (distToBg(i) < tLow) { isBg[idx] = 1; queue[qt++] = idx; }
  };
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
  while (qh < qt) {
    const idx = queue[qh++];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) tryPush(idx - 1);
    if (x < w - 1) tryPush(idx + 1);
    if (y > 0) tryPush(idx - w);
    if (y < h - 1) tryPush(idx + w);
  }

  // 3. 生成 alpha 并羽化
  const alphaHard = new Uint8ClampedArray(w * h);
  for (let idx = 0; idx < w * h; idx++) {
    const i = idx * 4;
    const d = distToBg(i);
    if (isBg[idx]) {
      alphaHard[idx] = 0;
    } else if (d < tHigh) {
      // 过渡带：按距离给出软 alpha，消除硬边
      const t = (d - tLow) / Math.max(1e-6, tHigh - tLow);
      alphaHard[idx] = Math.round(clamp(t, 0, 1) * 255);
    } else {
      alphaHard[idx] = 255;
    }
    // 原本就半透明的像素保留其透明度
    if (px[i + 3] < 255) alphaHard[idx] = Math.min(alphaHard[idx], px[i + 3]);
  }
  const radius = Math.max(0, Math.round(feather));
  const alphaSoft = radius > 0 ? boxBlur(alphaHard, w, h, radius, 1, 1) : alphaHard;

  // 4. 合成：去色溢（把残留背景色从半透明边缘里除掉）+ 输出
  const outData = ctx.createImageData(w, h);
  const op = outData.data;
  // 白底/指定底色输出时必须铺满整幅（含被判为背景的像素），否则会留下透明角
  const solidBg = output !== 'transparent' ? (output === 'white' ? [255, 255, 255] : parseColor(output)) : null;
  const spillBg = bgList[0];
  let kept = 0;
  for (let idx = 0; idx < w * h; idx++) {
    const i = idx * 4;
    const a = alphaSoft[idx] / 255;
    if (a > 0.004) kept++;
    if (!solidBg) {
      if (a <= 0.004) { op[i + 3] = 0; continue; }
      let r = px[i], g = px[i + 1], b = px[i + 2];
      if (despill && a < 0.995) {
        r = clamp((r - (1 - a) * spillBg[0]) / a, 0, 255);
        g = clamp((g - (1 - a) * spillBg[1]) / a, 0, 255);
        b = clamp((b - (1 - a) * spillBg[2]) / a, 0, 255);
      }
      op[i] = r; op[i + 1] = g; op[i + 2] = b; op[i + 3] = Math.round(a * 255);
      continue;
    }
    if (a <= 0.004) {
      op[i] = solidBg[0]; op[i + 1] = solidBg[1]; op[i + 2] = solidBg[2]; op[i + 3] = 255;
      continue;
    }
    let r = px[i], g = px[i + 1], b = px[i + 2];
    if (despill && a < 0.995) {
      r = clamp((r - (1 - a) * spillBg[0]) / a, 0, 255);
      g = clamp((g - (1 - a) * spillBg[1]) / a, 0, 255);
      b = clamp((b - (1 - a) * spillBg[2]) / a, 0, 255);
    }
    op[i] = r * a + solidBg[0] * (1 - a);
    op[i + 1] = g * a + solidBg[1] * (1 - a);
    op[i + 2] = b * a + solidBg[2] * (1 - a);
    op[i + 3] = 255;
  }

  const coverage = kept / (w * h);
  const dataUrl = putAndExport(ctx, outData, 'image/png');
  return {
    dataUrl,
    width: w,
    height: h,
    engine: '本地抠图',
    background: bc.median,
    backgroundVariance: Math.round(bc.variance),
    coverage: Number(coverage.toFixed(4)),
    uniformBackground: bc.variance < 420,
    costMs: Math.round(performance.now() - t0)
  };
}

function parseColor(c) {
  if (Array.isArray(c)) return c;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(c).trim());
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 抠图 + 铺纯白背景（电商白底图） */
export async function localWhiteBackground(src, opts = {}) {
  const r = await localMatting(src, { ...opts, output: 'white' });
  return { ...r, engine: '本地白底合成', whiteBackground: true };
}

/** 把透明图铺到指定底色上 */
export async function compositeOnColor(src, color = '#ffffff') {
  const img = await readImage(src);
  const c = makeCanvas(img.naturalWidth, img.naturalHeight);
  const ctx = c.getContext('2d');
  ctx.fillStyle = typeof color === 'string' ? color : `rgb(${color.join(',')})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  return c.toDataURL('image/png');
}

/* ================================================================== *
 * 几何编辑
 * ================================================================== */

export async function cropImage(src, rect, rotationDeg = 0) {
  const img = await readImage(src);
  const sx = clamp(rect.x, 0, img.naturalWidth);
  const sy = clamp(rect.y, 0, img.naturalHeight);
  const sw = clamp(rect.w, 1, img.naturalWidth - sx);
  const sh = clamp(rect.h, 1, img.naturalHeight - sy);
  const c = makeCanvas(sw, sh);
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const cropped = c.toDataURL('image/png');
  if (!rotationDeg) return { dataUrl: cropped, width: sw, height: sh };
  const rotated = await rotateImage(cropped, rotationDeg);
  return rotated;
}

export async function rotateImage(src, deg) {
  const img = await readImage(src);
  const rad = (deg % 360) * Math.PI / 180;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const nw = Math.round(w * cos + h * sin);
  const nh = Math.round(w * sin + h * cos);
  const c = makeCanvas(nw, nh);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(rad);
  ctx.drawImage(img, -w / 2, -h / 2);
  return { dataUrl: c.toDataURL('image/png'), width: nw, height: nh, rotation: deg };
}

export async function resizeToBox(src, maxW, maxH) {
  const img = await readImage(src);
  const k = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  if (k >= 1) return { dataUrl: src, width: img.naturalWidth, height: img.naturalHeight };
  const c = makeCanvas(img.naturalWidth * k, img.naturalHeight * k);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
}

/**
 * 把图像精确对齐到目标像素尺寸。
 * 供应商常把宽高对齐到 64 的倍数（请求 800×800 实际返回 768×768），
 * 而电商白底图 / 详情页对像素尺寸有硬性规范，所以生成后统一归一到用户选择的尺寸。
 * @param {'contain'|'cover'|'stretch'} mode 完整容纳（留边）/ 裁切填满 / 拉伸变形
 * @param {string|null} bg 需要铺底色时传入（如白底图 '#ffffff'）
 */
export async function fitExact(src, width, height, opts = {}) {
  const w = clamp(Math.round(width || 0), 1, 8000);
  const h = clamp(Math.round(height || 0), 1, 8000);
  const img = await readImage(src);
  const sw = img.naturalWidth || w, sh = img.naturalHeight || h;
  if (sw === w && sh === h) return { dataUrl: src, width: w, height: h, changed: false };
  const mode = opts.mode || 'cover';
  const bg = opts.bg || null;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (bg) { ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); }
  if (mode === 'stretch') {
    ctx.drawImage(img, 0, 0, w, h);
  } else {
    const k = mode === 'contain' ? Math.min(w / sw, h / sh) : Math.max(w / sw, h / sh);
    const dw = Math.max(1, Math.round(sw * k)), dh = Math.max(1, Math.round(sh * k));
    ctx.drawImage(img, Math.round((w - dw) / 2), Math.round((h - dh) / 2), dw, dh);
  }
  const srcMime = /^data:(image\/[a-z0-9.+-]+);/i.exec(String(src));
  const wantJpeg = !!bg || !!(srcMime && /jpe?g/i.test(srcMime[1]));
  const mime = wantJpeg ? 'image/jpeg' : (srcMime ? srcMime[1] : 'image/png');
  let dataUrl;
  try { dataUrl = c.toDataURL(mime, 0.94); } catch (_) { dataUrl = c.toDataURL('image/png'); }
  return { dataUrl, width: w, height: h, changed: true };
}

/* ================================================================== *
 * 图像分析（反推提示词的本地通道）
 * ================================================================== */

const COLOR_NAMES = [
  ['黑色', [0, 0, 0]], ['白色', [255, 255, 255]], ['灰色', [128, 128, 128]],
  ['红色', [220, 38, 38]], ['橙色', [240, 130, 30]], ['黄色', [240, 200, 40]],
  ['绿色', [40, 170, 80]], ['青色', [40, 190, 200]], ['蓝色', [40, 90, 220]],
  ['紫色', [140, 60, 210]], ['粉色', [240, 140, 180]], ['棕色', [130, 90, 60]],
  ['米色', [235, 220, 195]], ['银色', [200, 205, 215]], ['金色', [210, 175, 80]]
];

function nearestColorName(rgb) {
  let best = COLOR_NAMES[0];
  let bd = Infinity;
  for (const [name, c] of COLOR_NAMES) {
    const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
    if (d < bd) { bd = d; best = [name, rgb]; }
  }
  return best[0];
}

/**
 * 分析图像视觉特征，产出可直接用于生成的提示词（无需任何模型）。
 * @returns {Promise<{dataUrl:string, analysis:object, promptZh:string, promptEn:string, tags:string[], swatches:Array}>}
 */
export async function analyzeImage(src) {
  const t0 = performance.now();
  const base = await toImageData(src, 900); // 分析用小图即可，速度快
  const { data, width: w, height: h } = base;
  const px = data.data;
  const total = w * h;

  // 主色统计（量化到 16 级）
  const buckets = new Map();
  let sumL = 0, sumL2 = 0, sumS = 0;
  let edgeSum = 0, edgeCount = 0;
  let weightX = 0, weightY = 0, weightTotal = 0;

  const bc = borderColors(px, w, h, 1);
  const bgKey = bc.median.map((v) => v >> 4).join(',');

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      buckets.set(key, (buckets.get(key) || 0) + 1);
      const l = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      sumL += l; sumL2 += l * l;
      const mx = Math.max(r, g, b) / 255;
      const mn = Math.min(r, g, b) / 255;
      sumS += mx === 0 ? 0 : (mx - mn) / mx;
      // 与背景差异越大越可能是主体 → 用于估计主体重心
      const dr = r - bc.median[0], dg = g - bc.median[1], db = b - bc.median[2];
      const sal = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / 180);
      weightX += x * sal; weightY += y * sal; weightTotal += sal;
      // 简化梯度（右邻 + 下邻）
      if (x < w - 1 && y < h - 1) {
        const i2 = i + 4;
        const i3 = i + w * 4;
        const gx = Math.abs(px[i2] - r) + Math.abs(px[i2 + 1] - g) + Math.abs(px[i2 + 2] - b);
        const gy = Math.abs(px[i3] - r) + Math.abs(px[i3 + 1] - g) + Math.abs(px[i3 + 2] - b);
        edgeSum += (gx + gy) / 2;
        edgeCount++;
      }
    }
  }

  const brightness = sumL / total;
  const contrast = Math.sqrt(Math.max(0, sumL2 / total - brightness * brightness));
  const saturation = sumS / total;
  const edgeDensity = edgeCount ? edgeSum / edgeCount / 255 : 0;

  const top = Array.from(buckets.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map((v) => (Number(v) << 4) + 8);
      return { rgb: [r, g, b], hex: `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`, name: nearestColorName([r, g, b]), ratio: count / total, isBg: key === bgKey };
    });
  const subjectColors = top.filter((c) => !c.isBg).slice(0, 4);
  const bgColor = top.find((c) => c.isBg) || top[0];

  const centroid = weightTotal > 0 ? { x: weightX / weightTotal / w, y: weightY / weightTotal / h } : { x: 0.5, y: 0.5 };
  const centered = Math.abs(centroid.x - 0.5) < 0.12 && Math.abs(centroid.y - 0.5) < 0.12;
  const uniformBg = bc.variance < 420;
  const isWhiteBg = uniformBg && bc.median.every((v) => v > 232);
  const ratio = w / h;

  // 组装标签
  const tags = [];
  tags.push(ratio > 1.25 ? '横版构图' : ratio < 0.8 ? '竖版构图' : '方形构图');
  if (isWhiteBg) tags.push('纯白背景');
  else if (uniformBg) tags.push(`${bgColor?.name || '纯色'}背景`);
  else tags.push('场景化背景');
  if (centered) tags.push('主体居中');
  else tags.push(centroid.x < 0.5 ? '主体偏左' : '主体偏右');
  tags.push(brightness > 0.68 ? '高调明亮' : brightness < 0.34 ? '低调暗调' : '中等亮度');
  tags.push(contrast > 0.22 ? '强对比' : contrast < 0.12 ? '柔和低对比' : '对比适中');
  tags.push(saturation > 0.45 ? '高饱和' : saturation < 0.14 ? '低饱和/近似灰阶' : '自然饱和');
  tags.push(edgeDensity > 0.16 ? '细节丰富' : edgeDensity < 0.06 ? '简洁干净' : '细节适中');
  if (isWhiteBg && centered) tags.push('电商产品图特征');

  const colorDesc = subjectColors.length ? subjectColors.map((c) => c.name).join('、') : (bgColor?.name || '中性色');
  const lightDesc = brightness > 0.68 ? '明亮均匀布光' : brightness < 0.34 ? '低照度氛围光' : '自然柔光';

  const promptZh = [
    `${isWhiteBg ? '纯白背景商品图' : centered ? '主体居中的产品视觉' : '场景化画面'}`,
    `主色调为${colorDesc}`,
    `${lightDesc}`,
    contrast > 0.22 ? '明暗对比强烈' : '影调柔和',
    saturation < 0.14 ? '低饱和高级灰质感' : saturation > 0.45 ? '色彩鲜明' : '色彩自然',
    edgeDensity > 0.16 ? '细节纹理丰富' : '画面简洁干净',
    ratio > 1.25 ? '横版构图' : ratio < 0.8 ? '竖版构图' : '方形构图',
    '商业摄影级画质，高清锐利'
  ].join('，');

  const promptEn = [
    isWhiteBg ? 'product photo on pure white background' : centered ? 'centered product hero shot' : 'lifestyle scene',
    `dominant ${subjectColors[0] ? englishColor(subjectColors[0].rgb) : 'neutral'} tones`,
    brightness > 0.68 ? 'bright even studio lighting' : brightness < 0.34 ? 'moody low-key lighting' : 'soft natural light',
    contrast > 0.22 ? 'high contrast' : 'gentle tonal range',
    saturation < 0.14 ? 'muted desaturated palette' : saturation > 0.45 ? 'vivid colors' : 'natural color grading',
    edgeDensity > 0.16 ? 'rich fine detail' : 'clean minimal composition',
    ratio > 1.25 ? 'landscape orientation' : ratio < 0.8 ? 'portrait orientation' : 'square format',
    'commercial photography, ultra sharp, 8k'
  ].join(', ');

  return {
    analysis: {
      width: base.srcW, height: base.srcH, ratio: Number(ratio.toFixed(3)),
      brightness: Number(brightness.toFixed(3)),
      contrast: Number(contrast.toFixed(3)),
      saturation: Number(saturation.toFixed(3)),
      edgeDensity: Number(edgeDensity.toFixed(4)),
      background: { rgb: bc.median, variance: Math.round(bc.variance), uniform: uniformBg, isWhite: isWhiteBg },
      centroid: { x: Number(centroid.x.toFixed(3)), y: Number(centroid.y.toFixed(3)) },
      palette: top,
      subjectColors
    },
    swatches: top.slice(0, 6).map((c) => c.hex),
    tags,
    promptZh,
    promptEn,
    engine: '本地图像分析',
    costMs: Math.round(performance.now() - t0)
  };
}

function englishColor(rgb) {
  const map = { '黑色': 'black', '白色': 'white', '灰色': 'gray', '红色': 'red', '橙色': 'orange', '黄色': 'yellow', '绿色': 'green', '青色': 'cyan', '蓝色': 'blue', '紫色': 'purple', '粉色': 'pink', '棕色': 'brown', '米色': 'beige', '银色': 'silver', '金色': 'gold' };
  return map[nearestColorName(rgb)] || 'neutral';
}

/* ================================================================== *
 * 应用云端返回的蒙版（百度 AI 人像分割返回灰度蒙版）
 * ================================================================== */

export async function applyMask(src, maskSrc, { feather = 1, output = 'transparent' } = {}) {
  const [img, mask] = await Promise.all([readImage(src), readImage(maskSrc)]);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const base = ctx.getImageData(0, 0, w, h);

  const mc = makeCanvas(w, h);
  const mctx = mc.getContext('2d', { willReadFrequently: true });
  mctx.drawImage(mask, 0, 0, w, h);
  const mdata = mctx.getImageData(0, 0, w, h).data;

  let alpha = new Uint8ClampedArray(w * h);
  for (let i = 0; i < w * h; i++) alpha[i] = mdata[i * 4]; // 灰度蒙版取 R 通道
  if (feather > 0) alpha = boxBlur(alpha, w, h, Math.round(feather), 1, 1);

  const out = ctx.createImageData(w, h);
  const bgc = output === 'white' ? [255, 255, 255] : null;
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i] / 255;
    const j = i * 4;
    if (bgc) {
      out.data[j] = base.data[j] * a + bgc[0] * (1 - a);
      out.data[j + 1] = base.data[j + 1] * a + bgc[1] * (1 - a);
      out.data[j + 2] = base.data[j + 2] * a + bgc[2] * (1 - a);
      out.data[j + 3] = 255;
    } else {
      out.data[j] = base.data[j];
      out.data[j + 1] = base.data[j + 1];
      out.data[j + 2] = base.data[j + 2];
      out.data[j + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(out, 0, 0);
  return { dataUrl: c.toDataURL('image/png'), width: w, height: h, engine: '云端蒙版合成' };
}
