/**
 * 星空画布 · 视频
 * ------------------------------------------------------------------
 * 两条路：
 *   A. 云端文生视频 / 图生视频 —— 配置了通义万相、可灵等接口时走接口
 *   B. 本地运镜合成 —— 用画布上的图片（或先用文生图生成多帧）在浏览器里
 *      通过 MediaRecorder 录制为 WebM，完全免费、离线、不上传素材
 * 生成结果作为 video 节点落到画布，可继续双击调用工具、可导出下载。
 */

import { state, bus, getNode, createNode, setSelection, imageNodes, providerLabel } from '../core/state.js';
import { renderAllNodes, focusNode, findFreeSpot } from '../core/engine.js';
import { ai, registerLocalEngine } from '../ai/client.js';
import { usableRoutes, runGenerate } from './generate.js';
import { recordVideo, showBusy } from './exporter.js';
import { el, modal, toast, clamp, humanSize, downloadBlob, timestampName } from '../ui/dom.js';

const RES_PRESETS = [
  { id: '9:16', label: '720×1280 竖屏', w: 720, h: 1280 },
  { id: '16:9', label: '1280×720 横屏', w: 1280, h: 720 },
  { id: '1:1', label: '1024×1024 方形', w: 1024, h: 1024 },
  { id: '3:4', label: '896×1152 竖图', w: 896, h: 1152 },
  { id: 'custom', label: '自定义', w: 0, h: 0 }
];

const EFFECTS = [
  { id: 'kenburns', label: 'Ken Burns 缓慢推近' },
  { id: 'zoom', label: '正面推近' },
  { id: 'pan', label: '横向平移' },
  { id: 'crossfade', label: '交叉淡化（近乎静帧）' }
];

const MAX_PERSIST_BYTES = 8 * 1024 * 1024;

/* ================================================================== *
 * 视频对话框
 * ================================================================== */

/** 当前打开的视频面板（供文件选择器回调注入帧） */
let activeVideoDialog = null;

export function openVideoDialog(opts = {}) {
  const { imageNodeIds = null, prompt = '', width = 0, height = 0, refImage = null, negative = '' } = opts;

  const initial = (imageNodeIds && imageNodeIds.length)
    ? imageNodeIds.map((id) => getNode(id)).filter((n) => n && n.data && n.data.src)
    : (Array.from(state.selection).map((id) => getNode(id)).filter((n) => n && n.data && n.data.src));

  const st = {
    frames: initial.map((n) => ({ id: n.id, src: n.data.src, title: (n.meta && n.meta.title) || '帧' })),
    prompt: prompt || '',
    negative: negative,
    resId: width && height ? 'custom' : '9:16',
    w: width || 720,
    h: height || 1280,
    seconds: 3,
    effect: 'kenburns',
    fps: 30,
    autoFrames: 0,
    useCloud: false,
    autoDownload: true,
    refImage: refImage || null
  };
  if (!st.frames.length && !st.prompt) st.autoFrames = 3;

  let m = null;
  const cloudRoutes = usableRoutes('video').filter((r) => r.provider !== 'local');

  const strip = el('div.result-strip');
  const stripInfo = el('div.muted', { style: { fontSize: '11px', marginTop: '6px' }, text: '' });
  function renderStrip() {
    strip.textContent = '';
    st.frames.forEach((f, i) => {
      const t = el('img.result-thumb', { title: f.title + '（点击移除）', onclick: () => { st.frames.splice(i, 1); renderStrip(); } });
      t.src = f.src;
      strip.appendChild(t);
    });
    const total = st.frames.length * st.seconds + (st.autoFrames ? st.autoFrames * st.seconds : 0);
    stripInfo.textContent = st.frames.length
      ? st.frames.length + ' 帧素材 · 预计 ' + total + ' 秒' + (st.autoFrames ? '（含 ' + st.autoFrames + ' 帧 AI 生成）' : '')
      : (st.autoFrames ? '将用提示词先生成 ' + st.autoFrames + ' 帧再合成' : '没有素材：请填写提示词或添加图片');
  }

  const resRow = el('div.chip-row');
  function renderRes() {
    resRow.textContent = '';
    RES_PRESETS.forEach((r) => {
      resRow.appendChild(el('button.chip' + (st.resId === r.id ? '.active' : ''), {
        type: 'button', text: r.label,
        onclick: () => {
          st.resId = r.id;
          if (r.id !== 'custom') { st.w = r.w; st.h = r.h; wInput.value = String(r.w); hInput.value = String(r.h); }
          renderRes();
        }
      }));
    });
  }
  const wInput = el('input.input', { type: 'number', min: '240', max: '3840', value: String(st.w) });
  const hInput = el('input.input', { type: 'number', min: '240', max: '3840', value: String(st.h) });
  wInput.addEventListener('input', () => { st.w = clamp(Number(wInput.value) || 720, 240, 3840); st.resId = 'custom'; renderRes(); });
  hInput.addEventListener('input', () => { st.h = clamp(Number(hInput.value) || 1280, 240, 3840); st.resId = 'custom'; renderRes(); });

  const secRange = el('input', { type: 'range', min: '1', max: '8', step: '0.5', value: String(st.seconds) });
  const secVal = el('span.slider-val', { text: st.seconds + 's' });
  secRange.addEventListener('input', () => { st.seconds = Number(secRange.value); secVal.textContent = st.seconds + 's'; renderStrip(); });

  const effectSelect = el('select.select', {}, EFFECTS.map((e) => el('option', { value: e.id, text: e.label, selected: st.effect === e.id })));
  effectSelect.addEventListener('change', () => { st.effect = effectSelect.value; });

  const autoRow = el('div.chip-row');
  [0, 2, 3, 4].forEach((n) => {
    autoRow.appendChild(el('button.chip' + (st.autoFrames === n ? '.active' : ''), {
      type: 'button', text: n === 0 ? '不生成' : n + ' 帧',
      onclick: () => { st.autoFrames = n; autoRow.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); autoRow.querySelector('.chip:nth-child(' + ([0, 2, 3, 4].indexOf(n) + 1) + ')').classList.add('active'); renderStrip(); }
    }));
  });

  const promptArea = el('textarea.textarea', { rows: '3', placeholder: '视频内容提示词（用于云端文生视频，或本地模式下先生成多帧图片）' });
  promptArea.value = st.prompt;
  promptArea.addEventListener('input', () => { st.prompt = promptArea.value; });

  const cloudBox = el('div.stack', { style: { gap: '6px' } });
  if (cloudRoutes.length) {
    const cloudChk = el('input', { type: 'checkbox' });
    cloudChk.checked = st.useCloud;
    cloudChk.addEventListener('change', () => { st.useCloud = cloudChk.checked; });
    cloudBox.append(
      el('label.chk-row', {}, cloudChk, el('span', { text: '优先用云端视频接口（' + providerLabel(cloudRoutes[0].provider) + '）' })),
      el('div.muted', { style: { fontSize: '11px' }, text: '云端接口失败会自动回退到本地运镜合成。' })
    );
  } else {
    cloudBox.appendChild(el('div.notice.info', {}, [
      el('span.n-ico', { text: 'ⓘ' }),
      el('div.n-body', { text: '未配置云端视频接口，将使用本地运镜合成（MediaRecorder 录制 WebM），免费、离线、素材不出本机。可在「设置 · AI 接口」配置通义万相获得真实文生视频。' })
    ]));
  }

  const dlChk = el('input', { type: 'checkbox' }); dlChk.checked = st.autoDownload;
  dlChk.addEventListener('change', () => { st.autoDownload = dlChk.checked; });

  renderRes();
  renderStrip();

  const goBtn = el('button.btn.primary', { text: '🎬 生成视频' });
  goBtn.addEventListener('click', async () => {
    if (m) m.close();
    await makeVideo(st);
  });

  m = modal({
    title: '生成视频',
    sub: '云端文生视频，或用画布图片本地合成运镜视频',
    size: 'wide',
    onClose: () => { activeVideoDialog = null; },
    body: el('div.exp-layout', {}, [
      el('div.stack', {}, [
        el('div.field', {}, [
          el('label.lbl', { text: '素材帧（点击缩略图移除）' }),
          strip, stripInfo,
          el('div.inline-row', { style: { marginTop: '7px' } }, [
            el('button.btn.sm.ghost', { text: '＋ 画布选中图', onclick: () => { addFromCanvas(false); } }),
            el('button.btn.sm.ghost', { text: '＋ 画布全部图', onclick: () => { addFromCanvas(true); } }),
            el('button.btn.sm.ghost', { text: '⬆ 上传图片', onclick: () => bus.emit('panel:pick-image', { for: 'video-frames' }) })
          ])
        ]),
        el('div.field', {}, [el('label.lbl', { text: '视频提示词' }), promptArea]),
        el('div.field', {}, [el('label.lbl', { text: 'AI 补帧数量（用提示词先生成几张图再合成）' }), autoRow])
      ]),
      el('div.stack', {}, [
        el('div.field', {}, [el('label.lbl', { text: '分辨率' }), resRow, el('div.custom-size', {}, wInput, el('span.cs-x', { text: '×' }), hInput, el('span'))]),
        el('div.field', {}, [el('label.lbl', { text: '每帧时长' }), el('div.slider-row', {}, secRange, secVal)]),
        el('div.field', {}, [el('label.lbl', { text: '运镜效果' }), effectSelect]),
        el('div.field', {}, [el('label.lbl', { text: '通道' }), cloudBox]),
        el('label.chk-row', {}, dlChk, el('span', { text: '生成后自动下载' }))
      ])
    ]),
    footer: [
      el('button.btn.ghost', { text: '取消', onclick: () => m.close() }),
      goBtn
    ]
  });
  activeVideoDialog = { st, renderStrip, close: () => m.close() };

  function addFromCanvas(all) {
    const list = all ? imageNodes() : Array.from(state.selection).map((id) => getNode(id)).filter((n) => n && n.data && n.data.src);
    const before = st.frames.length;
    list.forEach((n) => {
      if (!st.frames.some((f) => f.id === n.id)) st.frames.push({ id: n.id, src: n.data.src, title: (n.meta && n.meta.title) || '帧' });
    });
    renderStrip();
    toast(st.frames.length > before ? '已加入 ' + (st.frames.length - before) + ' 帧' : '没有新的图片可加入', { type: st.frames.length > before ? 'ok' : 'warn', timeout: 2000 });
  }

  return m;
}

/**
 * 供 main.js 的文件选择器回调追加帧。
 * 契约：面板内点击「⬆ 上传图片」→ bus.emit('panel:pick-image', { for: 'video-frames' })
 *      → main.js 打开文件选择器、建图片节点后调用本函数注入 src。
 */
export function addVideoFrame(dataUrl, title) {
  if (!activeVideoDialog) {
    toast('请先打开「生成视频」面板再上传素材帧', { type: 'warn', timeout: 3000 });
    return false;
  }
  const st = activeVideoDialog.st;
  if (!dataUrl || st.frames.some((f) => f.src === dataUrl)) return false;
  st.frames.push({ id: null, src: dataUrl, title: title || '上传帧' });
  activeVideoDialog.renderStrip();
  return true;
}

/** 面板是否打开（main.js 路由上传结果时判断用） */
export function isVideoDialogOpen() { return !!activeVideoDialog; }

/* ================================================================== *
 * 实际生成
 * ================================================================== */

export async function makeVideo(st) {
  const busy = showBusy('正在准备视频…');
  const t0 = performance.now();
  try {
    let frames = st.frames.map((f) => f.src);

    // 1) 需要 AI 补帧
    if (st.autoFrames > 0 && st.prompt.trim()) {
      busy.update('正在用提示词生成 ' + st.autoFrames + ' 帧…');
      const made = await runGenerate({
        subject: st.prompt, prompt: st.prompt, negative: st.negative || '',
        mode: 'free', width: st.w, height: st.h, sizeLabel: st.w + '×' + st.h,
        count: clamp(st.autoFrames, 1, 4), seed: null, enhance: true,
        refImage: st.refImage, refNodeId: null
      });
      if (made && made.length) frames = frames.concat(made.map((n) => n.data.src));
    }

    // 2) 云端视频接口
    if (st.useCloud && st.prompt.trim()) {
      const cloud = usableRoutes('video').filter((r) => r.provider !== 'local');
      if (cloud.length) {
        try {
          busy.update('云端视频接口生成中…');
          const res = await ai.call('video', {
            prompt: st.prompt,
            negativePrompt: st.negative || '',
            width: st.w, height: st.h,
            refImage: st.refImage || (frames[0] || null),
            duration: clamp(Math.round(frames.length * st.seconds) || 5, 2, 12)
          });
          const url = res && (res.videoUrl || res.video || (Array.isArray(res.videos) && res.videos[0]));
          if (url) {
            const node = await commitVideo(url, {
              title: '云端视频 ' + st.w + '×' + st.h,
              engine: providerLabel(res.__route ? res.__route.provider : cloud[0].provider) + (res.model ? ' · ' + res.model : ''),
              prompt: st.prompt, remote: true, mime: 'video/mp4'
            });
            if (st.autoDownload && !/^https?:/.test(url)) downloadBlob(await (await fetch(url)).blob(), timestampName('星空画布视频', 'webm'));
            toast('云端视频已生成', { type: 'ok', hint: node.meta.engine, timeout: 5200 });
            return node;
          }
          throw new Error((res && res.message) || '云端接口没有返回视频地址');
        } catch (err) {
          toast('云端视频失败，改用本地合成', { type: 'warn', hint: String(err.message || err).slice(0, 160), timeout: 6000 });
        }
      }
    }

    // 3) 本地运镜合成
    if (!frames.length) {
      if (!st.prompt.trim()) throw new Error('没有素材：请添加图片、上传图片，或填写提示词让 AI 先生成几帧');
      busy.update('用提示词生成帧…');
      const made = await runGenerate({
        subject: st.prompt, prompt: st.prompt, negative: st.negative || '',
        mode: 'free', width: st.w, height: st.h, sizeLabel: st.w + '×' + st.h,
        count: 3, seed: null, enhance: true, refImage: st.refImage, refNodeId: null
      });
      if (!made || !made.length) throw new Error('帧生成失败，无法合成视频');
      frames = made.map((n) => n.data.src);
    }

    const node = await recordAndCommit({
      frames: frames, width: st.w, height: st.h,
      secondsPerImage: st.seconds, effect: st.effect, fps: st.fps,
      autoDownload: st.autoDownload,
      onProgress: (p) => busy.update('正在录制视频… ' + Math.round(p * 100) + '%'),
      prompt: st.prompt, engine: '本地运镜合成 · ' + st.effect
    });
    toast('视频已生成', {
      type: 'ok',
      hint: st.w + '×' + st.h + ' · ' + Math.round(node.data.durationMs / 1000) + 's · ' + humanSize(node.data.bytes) + ' · ' + Math.round(performance.now() - t0) + 'ms',
      timeout: 5600
    });
    return node;
  } catch (err) {
    toast('视频生成失败', { type: 'err', hint: String(err.message || err).slice(0, 240), timeout: 9000 });
    return null;
  } finally { busy.close(); }
}

export async function recordAndCommit(cfg) {
  const out = await recordVideo({
    images: cfg.frames, width: cfg.width, height: cfg.height,
    secondsPerImage: cfg.secondsPerImage, effect: cfg.effect, fps: cfg.fps || 30,
    onProgress: cfg.onProgress || null
  });
  let src = URL.createObjectURL(out.blob);
  let persistable = false;
  if (out.bytes <= MAX_PERSIST_BYTES) {
    try { src = await blobToDataUrlAsync(out.blob); persistable = true; } catch (_) { /* 保留 blob URL */ }
  }
  return commitVideo(src, {
    title: '本地视频 ' + cfg.width + '×' + cfg.height,
    engine: cfg.engine || '本地运镜合成',
    prompt: cfg.prompt || '',
    mime: out.mime,
    width: out.width, height: out.height,
    durationMs: out.durationMs, bytes: out.bytes,
    ephemeral: !persistable,
    autoDownload: cfg.autoDownload,
    blob: out.blob
  });
}

// 导出对话框里合成的 WebM 也落到画布（exporter 只发事件，避免循环依赖）
bus.on('video:created', async (p) => {
  if (!p || !p.blob) return;
  const bytes = p.blob.size || 0;
  try {
    let src = URL.createObjectURL(p.blob);
    let persistable = false;
    if (bytes <= MAX_PERSIST_BYTES) {
      try { src = await blobToDataUrlAsync(p.blob); persistable = true; } catch (_) { /* 保留 blob URL */ }
    }
    await commitVideo(src, {
      title: p.title || '导出视频',
      engine: '本地运镜合成（导出）',
      mime: p.mime || p.blob.type || 'video/webm',
      width: p.width, height: p.height,
      durationMs: p.durationMs || 0, bytes,
      ephemeral: !persistable,
      blob: p.blob
    });
  } catch (err) {
    toast('视频未能落到画布', { type: 'warn', hint: String(err && err.message || err).slice(0, 160) });
  }
});

/** MediaRecorder 的 blob.type 形如 video/webm;codecs=vp9,opus，参数里的逗号会破坏
 *  data URL 解析（浏览器按第一个逗号切分元信息与数据），必须规范化为纯 MIME */
function normalizeMime(m) {
  const base = String(m || '').split(/[;,]/)[0].trim();
  return /^video\//.test(base) ? base : 'video/webm';
}

function blobToDataUrlAsync(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('读取视频数据失败'));
    let src = blob;
    const raw = String(blob.type || '');
    if (raw.includes(';') || raw.includes(',')) {
      try { src = new Blob([blob], { type: normalizeMime(raw) }); } catch (_) { /* 保留原 blob */ }
    }
    fr.readAsDataURL(src);
  });
}

async function commitVideo(src, meta) {
  const w = meta.width || 720;
  const h = meta.height || 1280;
  const boxW = clamp(w * 0.42, 200, 420);
  const boxH = Math.round(boxW * h / w);
  const spot = findFreeSpot(boxW, boxH);
  const node = createNode({
    type: 'video',
    x: Math.round(spot.x), y: Math.round(spot.y),
    w: Math.round(boxW), h: Math.round(boxH),
    data: {
      src: src,
      mime: normalizeMime(meta.mime),
      natW: w, natH: h,
      durationMs: meta.durationMs || 0,
      bytes: meta.bytes || 0,
      engine: meta.engine || '',
      ephemeral: !!meta.ephemeral,
      remote: !!meta.remote
    },
    meta: {
      source: 'generate',
      title: meta.title || '视频',
      prompt: meta.prompt || '',
      engine: meta.engine || '',
      createdAt: Date.now()
    }
  });
  setSelection([node.id]);
  renderAllNodes();
  focusNode(node.id);
  bus.emit('history:push', { label: '生成视频' });
  bus.emit('project:save-request');
  if (meta.autoDownload && meta.blob) downloadBlob(meta.blob, timestampName('星空画布视频', 'webm'));
  return node;
}

/* ================================================================== *
 * 注册为本地引擎：让 ai.call('video') 在无云端接口时也能返回结果
 * ================================================================== */

export function registerVideoEngine() {
  registerLocalEngine('video', async (payload) => {
    const frames = payload.frames || (payload.images || []);
    if (!frames.length) {
      return {
        ok: false,
        code: 'no_frames',
        message: '本地视频引擎需要至少一帧图片素材',
        hint: '在视频面板里添加画布图片，或填写提示词让 AI 先生成几帧'
      };
    }
    const out = await recordVideo({
      images: frames,
      width: payload.width || 720,
      height: payload.height || 1280,
      secondsPerImage: payload.secondsPerImage || 3,
      effect: payload.effect || 'kenburns',
      fps: payload.fps || 30
    });
    return {
      videoUrl: URL.createObjectURL(out.blob),
      mime: out.mime,
      width: out.width,
      height: out.height,
      durationMs: out.durationMs,
      bytes: out.bytes,
      model: 'local-video',
      engine: '本地运镜合成'
    };
  });
}

export { RES_PRESETS, EFFECTS };
