/**
 * 星空画布 · 图片工具面板（双击图片节点触发）
 * ------------------------------------------------------------------
 * 双击一张图片 → 弹出工具选择菜单：变清晰 / 抠图 / 白底图 / 改尺寸 /
 * 反推提示词 / 输出提示词 / 以此图生成 / 转视频 / 就图对话 / 复制 / 下载 / 属性。
 * 每项工具都把结果作为新节点放到画布（原图保留，可无限迭代），
 * 并在节点 meta 上记录来源链路，形成可追溯的创作树。
 * 云端接口不可用时自动回退本地引擎，菜单徽标实时显示将使用哪条通道。
 */

import { state, bus, getNode, createNode, setSelection, resolveSize, availableRoutes, providerLabel } from '../core/state.js';
import { renderAllNodes, focusNode, findFreeSpot } from '../core/engine.js';
import { ai, hasLocalEngine } from '../ai/client.js';
import { localUpscale, localMatting, analyzeImage, applyMask } from './imageops.js';
import { showBusy, quickDownloadNode, openExportDialog } from './exporter.js';
import { nodeSizeForImage } from './clipboard.js';
import { openGenerateDialog } from './generate.js';
import { openPromptStudio } from './prompt-studio.js';
import { chatWithImage } from './chat.js';
import { openPropsPanel } from './props.js';
import { el, modal, toast, readImage, makeCanvas, clamp, humanSize } from '../ui/dom.js';

/* ------------------------------------------------------------------ *
 * 工具菜单定义
 * ------------------------------------------------------------------ */

const TOOL_GROUPS = [
  {
    title: '图像增强',
    items: [
      { id: 'upscale', icon: '✨', label: '变清晰', hint: '超分放大 · 本地引擎或云端 API', cap: 'upscale' },
      { id: 'matting', icon: '✂', label: '抠图', hint: '去背景 · 输出透明 PNG', cap: 'matting' },
      { id: 'whitebg', icon: '▢', label: '白底图', hint: '抠图后合成纯白背景', cap: 'matting' },
      { id: 'resize', icon: '⤢', label: '改尺寸', hint: '预设比例或自定义宽高', cap: null }
    ]
  },
  {
    title: '提示词',
    items: [
      { id: 'reverse', icon: '🔍', label: '反推提示词', hint: '从这张图推出可复用的提示词', cap: 'vision' },
      { id: 'expand', icon: '✍', label: '输出提示词', hint: '按生成模式扩写成成品提示词', cap: 'chat' }
    ]
  },
  {
    title: '再创作',
    items: [
      { id: 'generate', icon: '🎨', label: '以此图生成', hint: '选模式 / 尺寸，生成新图', cap: 'image' },
      { id: 'video', icon: '🎬', label: '转为视频', hint: '本地运镜合成或云端文生视频', cap: 'video' },
      { id: 'chat', icon: '💬', label: '就这张图对话', hint: '带图提问、改写、点评', cap: 'chat' }
    ]
  },
  {
    title: '画布操作',
    items: [
      { id: 'duplicate', icon: '⧉', label: '复制一份', cap: null },
      { id: 'download', icon: '⬇', label: '下载原图', cap: null },
      { id: 'export', icon: '⇩', label: '导出为…', hint: '选格式 / 倍率 / 背景', cap: null },
      { id: 'props', icon: 'ⓘ', label: '属性与来源', cap: null }
    ]
  }
];

/** 该能力当前实际会走哪条通道（用于菜单徽标与可用性判断） */
export function routeBadge(cap) {
  if (!cap) return null;
  const routes = availableRoutes(cap);
  const catalog = state.catalog;
  for (const r of routes) {
    if (r.provider === 'local') {
      if (hasLocalEngine(cap)) return { provider: 'local', model: r.model || '', label: '本地引擎' };
      continue;
    }
    const p = catalog && catalog.providers ? catalog.providers.find((x) => x.id === r.provider) : null;
    if (!p || !p.capabilities || !p.capabilities[cap]) continue;
    if (p.needsKey && !r.credential.key) continue;
    if (p.needsKey && r.enabled === false) continue;
    return { provider: r.provider, model: r.model || '', label: providerLabel(r.provider) };
  }
  // 反推提示词在没有任何接口时用本地图像分析兜底
  if (cap === 'vision') return { provider: 'local', model: 'local-analyze', label: '本地分析' };
  return null;
}

let menuEl = null;

export function closeToolMenu() {
  if (menuEl) {
    menuEl.classList.add('hidden');
    menuEl.classList.remove('open');
    menuEl.textContent = '';
    menuEl.style.left = '';
    menuEl.style.top = '';
  }
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('keydown', onEsc, true);
}
function onEsc(e) { if (e.key === 'Escape') closeToolMenu(); }
function onOutside(e) { if (menuEl && !menuEl.contains(e.target)) closeToolMenu(); }

/** 在屏幕坐标处弹出工具菜单 */
export function openToolMenu(nodeId, clientX, clientY) {
  const node = getNode(nodeId);
  if (!node) return;
  closeToolMenu();

  const stage = document.getElementById('stage');
  const rect = stage ? stage.getBoundingClientRect() : null;
  const vw = rect ? rect.width : window.innerWidth;
  const vh = rect ? rect.height : window.innerHeight;

  // 复用 index.html 里的 #tool-menu 容器（引擎在平移/点击空白时也会隐藏它）
  menuEl = document.getElementById('tool-menu');
  if (!menuEl) {
    menuEl = el('div.tool-menu', { id: 'tool-menu', role: 'menu' });
    document.body.appendChild(menuEl);
  }
  menuEl.textContent = '';
  menuEl.classList.remove('hidden');

  const headKids = [];
  if (node.data && node.data.src) headKids.push(el('img.tm-thumb', { src: node.data.src, alt: '' }));
  headKids.push(el('div.grow', {}, [
    el('div.tm-title', { text: (node.meta && node.meta.title) || (node.type === 'video' ? '视频工具' : '图片工具') }),
    el('div.tm-sub', {
      text: node.data.natW
        ? node.data.natW + '×' + node.data.natH + 'px · ' + humanSize(node.data.bytes || 0)
        : '选择要执行的操作'
    })
  ]));
  menuEl.appendChild(el('div.tm-head', {}, headKids));

  TOOL_GROUPS.forEach((group, gi) => {
    if (gi > 0) menuEl.appendChild(el('div.tm-sep'));
    menuEl.appendChild(el('div.tm-group', { text: group.title }));
    for (const item of group.items) {
      const route = routeBadge(item.cap);
      const disabled = !!item.cap && !route;
      const row = el('div.tm-item', {
        role: 'menuitem',
        title: disabled ? '该能力暂无可用接口，请到「设置 · AI 接口」配置' : (item.hint || item.label)
      }, [
        el('span.tm-ico', { text: item.icon }),
        el('div.tm-txt', {}, [
          el('div.tm-name', { text: item.label }),
          item.hint ? el('div.tm-hint', { text: item.hint }) : null
        ]),
        route ? el('span.tm-key', { text: route.label }) : null
      ]);
      if (disabled) row.classList.add('disabled');
      if (item.danger) row.classList.add('danger');
      row.addEventListener('click', () => {
        if (disabled) {
          toast('该能力暂无可用接口', { type: 'warn', hint: '到「设置 · AI 接口」填好 Key 即可解锁', timeout: 6000 });
          return;
        }
        closeToolMenu();
        runTool(item.id, nodeId);
      });
      menuEl.appendChild(row);
    }
  });

  if (!menuEl.isConnected) document.body.appendChild(menuEl);
  const mw = menuEl.offsetWidth;
  const mh = menuEl.offsetHeight;
  let left = clientX;
  let top = clientY;
  if (left + mw > vw - 12) left = Math.max(12, vw - mw - 12);
  if (top + mh > vh - 12) top = Math.max(12, vh - mh - 12);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
  menuEl.classList.add('open');
  setTimeout(() => {
    document.addEventListener('pointerdown', onOutside, true);
    window.addEventListener('keydown', onEsc, true);
  }, 0);
}

/** 统一工具入口（菜单、右键、快捷键、批量都走这里） */
export async function runTool(toolId, nodeId, opts) {
  opts = opts || {};
  const node = getNode(nodeId);
  if (!node) { toast('节点不存在', { type: 'err' }); return null; }
  switch (toolId) {
    case 'upscale': return doUpscale(node, opts);
    case 'matting': return runMatting(node, { white: false });
    case 'whitebg': return runMatting(node, { white: true });
    case 'resize': return doResize(node);
    case 'reverse': return doReversePrompt(node);
    case 'expand': return openPromptStudio({ mode: 'expand', imageNodeId: node.id, imageSrc: node.data.src });
    case 'generate': return openGenerateDialog({ imageNode: node });
    case 'video': return doVideo(node);
    case 'chat': return chatWithImage(node);
    case 'duplicate': {
      const copy = createNode({
        type: node.type, x: Math.round(node.x + 30), y: Math.round(node.y + 30),
        w: node.w, h: node.h, rotation: node.rotation,
        data: Object.assign({}, node.data),
        meta: Object.assign({}, node.meta, { source: 'duplicate', createdAt: Date.now() })
      });
      setSelection([copy.id]);
      renderAllNodes();
      bus.emit('history:push', { label: '复制节点' });
      return copy;
    }
    case 'download': return quickDownloadNode(nodeId);
    case 'export': return openExportDialog(nodeId);
    case 'props': return openPropsPanel(nodeId);
    default:
      toast('未实现的工具：' + toolId, { type: 'warn' });
      return null;
  }
}

/** 把处理结果落到画布，并挂上来源链路 */
export async function commitResult(dataUrl, srcNode, label, extraMeta) {
  extraMeta = extraMeta || {};
  const img = await readImage(dataUrl);
  const size = nodeSizeForImage(img.naturalWidth, img.naturalHeight, 460);
  const near = srcNode ? { x: srcNode.x + srcNode.w + 60, y: srcNode.y } : null;
  const spot = findFreeSpot(size.w, size.h, near);
  const mimeMatch = /^data:([^;]+)/.exec(dataUrl);
  const node = createNode({
    type: 'image',
    x: Math.round(spot.x), y: Math.round(spot.y),
    w: size.w, h: size.h,
    data: {
      src: dataUrl,
      natW: img.naturalWidth, natH: img.naturalHeight,
      mime: mimeMatch ? mimeMatch[1] : 'image/png',
      bytes: Math.round(dataUrl.length * 0.75),
      // 角标与后续逻辑读的是 data.*，这里把工具痕迹一并落到 data 上
      engine: extraMeta.engine || '',
      ...(extraMeta.data || {})
    },
    meta: {
      source: extraMeta.source || 'tool',
      title: label,
      parentId: srcNode ? srcNode.id : null,
      tool: extraMeta.tool || label,
      engine: extraMeta.engine || '',
      note: extraMeta.note || '',
      prompt: extraMeta.prompt || '',
      createdAt: Date.now()
    }
  });
  setSelection([node.id]);
  renderAllNodes();
  focusNode(node.id);
  bus.emit('history:push', { label: label });
  bus.emit('project:save-request');
  state.stats.processed++;
  return node;
}

/* ---------------------------- 变清晰 ---------------------------- */

export async function doUpscale(node, opts) {
  opts = opts || {};
  let scale = opts.scale;
  if (!scale) scale = await askUpscaleScale();
  if (!scale) return null;
  scale = clamp(scale, 1, 4); // 内置引擎最高 4x；配置了云端超分接口时也按该上限收敛
  const busy = showBusy('正在变清晰（' + scale + 'x）…');
  try {
    const route = routeBadge('upscale');
    let out = null;
    let engine = '';
    if (route && route.provider !== 'local') {
      try {
        const res = await ai.call('upscale', { image: node.data.src, scale: scale, nodeId: node.id });
        if (res && res.ok !== false && res.image) {
          out = res.image;
          engine = route.label + (res.model ? ' · ' + res.model : '');
        } else if (res && res.ok === false) throw new Error(res.message || '云端超分未返回图片');
      } catch (err) {
        toast('云端超分未生效，已回退本地引擎', { type: 'warn', hint: String(err.message || err).slice(0, 160), timeout: 5200 });
      }
    }
    if (!out) {
      busy.update('本地引擎处理中（' + scale + 'x）…');
      const local = await localUpscale(node.data.src, { factor: scale });
      out = local.dataUrl;
      engine = local.engine + '（' + local.costMs + 'ms）';
    }
    const result = await commitResult(out, node, '变清晰 ' + scale + 'x', {
      tool: 'upscale', engine: engine.trim(), note: '源 ' + node.data.natW + '×' + node.data.natH,
      data: { upscaled: true, upscaleFactor: scale }
    });
    toast('变清晰完成', {
      type: 'ok',
      hint: node.data.natW + '×' + node.data.natH + ' → ' + result.data.natW + '×' + result.data.natH + ' · ' + engine,
      timeout: 5200
    });
    return result;
  } catch (err) {
    toast('变清晰失败', { type: 'err', hint: String(err.message || err) });
    return null;
  } finally { busy.close(); }
}

function askUpscaleScale() {
  return new Promise((resolve) => {
    let chosen = 2;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const chips = el('div.chip-row');
    [2, 3, 4].forEach((s) => {
      const c = el('button.chip' + (s === 2 ? '.active' : ''), {
        text: s + 'x',
        onclick: () => {
          chosen = s;
          chips.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
          c.classList.add('active');
        }
      });
      chips.appendChild(c);
    });
    let m = null;
    m = modal({
      title: '变清晰',
      sub: '选择放大倍率',
      body: el('div.stack', {}, [
        el('div.field', {}, [el('label.lbl', { text: '放大倍率' }), chips]),
        el('p.muted', {
          text: '优先调用你在「设置 · AI 接口」里配置的超分服务；未配置或调用失败时自动使用内置本地引擎（多级重采样 + 中值降噪 + 反锐化掩模），无需联网、不消耗额度、图片不出本机。'
        })
      ]),
      footer: [
        el('button.btn.ghost', { text: '取消', onclick: () => { m.close(); done(0); } }),
        el('button.btn.primary', { text: '开始处理', onclick: () => { m.close(); done(chosen); } })
      ]
    });
    m.onClose = () => done(0);
  });
}

/* ------------------------- 抠图 / 白底图 ------------------------- */

export async function doMatting(node, opts) { return runMatting(node, Object.assign({ white: false }, opts || {})); }
export async function doWhiteBackground(node, opts) { return runMatting(node, Object.assign({ white: true }, opts || {})); }

async function runMatting(node, cfg) {
  cfg = cfg || {};
  const white = !!cfg.white;
  const label = white ? '白底图' : '抠图';
  const busy = showBusy('正在' + label + '…');
  try {
    const route = routeBadge('matting');
    let out = null;
    let engine = '';
    let note = '';
    if (route && route.provider !== 'local') {
      try {
        const res = await ai.call('matting', { image: node.data.src, nodeId: node.id, white: white });
        if (res && res.ok !== false && (res.image || res.mask)) {
          out = res.image || (res.mask ? (await applyMask(node.data.src, res.mask, { output: white ? 'white' : 'transparent' })).dataUrl : null);
          engine = route.label + (res.model ? ' · ' + res.model : '');
        } else if (res && res.ok === false) throw new Error(res.message || '云端抠图未返回结果');
      } catch (err) {
        toast('云端抠图未生效，已回退本地引擎', { type: 'warn', hint: String(err.message || err).slice(0, 160), timeout: 5200 });
      }
    }
    if (!out) {
      busy.update('本地引擎分割中…');
      const local = await localMatting(node.data.src, { output: white ? 'white' : 'transparent' });
      out = local.dataUrl;
      engine = local.engine + (white ? ' · 纯白背景' : '');
      note = '主体占比 ' + Math.round(local.coverage * 100) + '% · 背景' + (local.uniformBackground ? '纯色，分割干净' : '较复杂，建议配云端接口复核');
    }
    const result = await commitResult(out, node, label, {
      tool: white ? 'whitebg' : 'matting', engine: engine.trim(),
      note: (note ? note + ' · ' : '') + '源 ' + node.data.natW + '×' + node.data.natH,
      data: { matted: true, whiteBackground: white }
    });
    toast(label + '完成', { type: 'ok', hint: engine + (note ? ' · ' + note : ''), timeout: 5200 });
    return result;
  } catch (err) {
    toast(label + '失败', { type: 'err', hint: String(err.message || err) });
    return null;
  } finally { busy.close(); }
}

/* ----------------------------- 改尺寸 ----------------------------- */

export async function doResize(node) {
  const sizes = (state.catalog && state.catalog.sizePresets) || [];
  const st = {
    sizeId: '',
    w: node.data.natW || node.w,
    h: node.data.natH || node.h,
    mode: 'contain',
    bg: 'transparent'
  };
  const ratio = (node.data.natW && node.data.natH) ? node.data.natW / node.data.natH : node.w / node.h;
  let locked = true;
  let m = null;

  const sizeRow = el('div.chip-row');
  const wInput = el('input.input', { type: 'number', min: '16', max: '8000', value: String(st.w) });
  const hInput = el('input.input', { type: 'number', min: '16', max: '8000', value: String(st.h) });
  const lockBtn = el('button.chip.active', { text: '🔗 锁定比例' });
  lockBtn.addEventListener('click', () => {
    locked = !locked;
    lockBtn.classList.toggle('active', locked);
    lockBtn.textContent = locked ? '🔗 锁定比例' : '🔓 自由比例';
  });
  wInput.addEventListener('input', () => {
    st.w = clamp(Number(wInput.value) || 1, 16, 8000);
    if (locked) { st.h = Math.round(st.w / ratio); hInput.value = String(st.h); }
  });
  hInput.addEventListener('input', () => {
    st.h = clamp(Number(hInput.value) || 1, 16, 8000);
    if (locked) { st.w = Math.round(st.h * ratio); wInput.value = String(st.w); }
  });

  for (const s of sizes) {
    const c = el('button.chip', {
      text: s.label,
      onclick: () => {
        st.sizeId = s.id;
        sizeRow.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        const r = resolveSize(s.id, st.w, st.h);
        st.w = r.width; st.h = r.height;
        wInput.value = String(r.width); hInput.value = String(r.height);
        drawPreview();
      }
    });
    sizeRow.appendChild(c);
  }

  const fitRow = el('div.chip-row');
  [['contain', '完整容纳'], ['cover', '裁切填满'], ['stretch', '拉伸变形']].forEach((pair) => {
    const c = el('button.chip' + (st.mode === pair[0] ? '.active' : ''), {
      text: pair[1],
      onclick: () => {
        st.mode = pair[0];
        fitRow.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        drawPreview();
      }
    });
    fitRow.appendChild(c);
  });

  const bgRow = el('div.chip-row');
  [['transparent', '透明'], ['#ffffff', '白底'], ['#000000', '黑底']].forEach((pair) => {
    const c = el('button.chip' + (st.bg === pair[0] ? '.active' : ''), {
      text: pair[1],
      onclick: () => {
        st.bg = pair[0];
        bgRow.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        drawPreview();
      }
    });
    bgRow.appendChild(c);
  });

  const preview = el('div.exp-preview', { style: { minHeight: '180px' } });
  const info = el('div.muted', { style: { fontFamily: 'var(--font-mono)', fontSize: '11px', marginTop: '8px' }, text: '—' });

  let token = 0;
  async function drawPreview() {
    const my = ++token;
    try {
      const c = await compose(node.data.src, st.w, st.h, st.mode, st.bg);
      if (my !== token) return;
      const url = c.toDataURL('image/png');
      preview.textContent = '';
      const img = el('img');
      img.src = url;
      preview.appendChild(img);
      info.textContent = st.w + '×' + st.h + ' · ' + st.mode + ' · ' + humanSize(Math.round(url.length * 0.75));
    } catch (err) {
      if (my === token) info.textContent = '预览失败：' + err.message;
    }
  }
  wInput.addEventListener('change', drawPreview);
  hInput.addEventListener('change', drawPreview);
  drawPreview();

  m = modal({
    title: '改尺寸',
    sub: '预设比例或完全自定义宽高',
    size: 'wide',
    body: el('div.exp-layout', {}, [
      el('div', {}, [preview, info]),
      el('div.stack', {}, [
        el('div.field', {}, [el('label.lbl', { text: '常用尺寸' }), sizeRow]),
        el('div.field', {}, [
          el('label.lbl', { text: '自定义宽高（px）' }),
          el('div.inline-row', {}, wInput, el('span.muted', { text: '×' }), hInput, lockBtn)
        ]),
        el('div.field', {}, [el('label.lbl', { text: '适配方式' }), fitRow]),
        el('div.field', {}, [el('label.lbl', { text: '留白背景' }), bgRow])
      ])
    ]),
    footer: [
      el('button.btn.ghost', { text: '取消', onclick: () => m.close() }),
      el('button.btn.primary', {
        text: '生成新尺寸',
        onclick: async () => {
          m.close();
          const busy = showBusy('正在合成…');
          try {
            const c = await compose(node.data.src, st.w, st.h, st.mode, st.bg);
            await commitResult(c.toDataURL('image/png'), node, st.w + '×' + st.h, {
              tool: 'resize', engine: '本地画布合成',
              note: st.mode + ' · 源 ' + node.data.natW + '×' + node.data.natH
            });
            toast('已生成 ' + st.w + '×' + st.h + ' 新图', { type: 'ok' });
          } catch (err) {
            toast('改尺寸失败', { type: 'err', hint: String(err.message || err) });
          } finally { busy.close(); }
        }
      })
    ]
  });
  return m;
}

/** 按适配方式把图片合成到目标尺寸画布 */
export async function compose(src, W, H, mode, bg) {
  const img = await readImage(src);
  const canvas = makeCanvas(Math.round(W), Math.round(H));
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (bg && bg !== 'transparent') { ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H); }
  let dw = W, dh = H, dx = 0, dy = 0;
  if (mode === 'contain') {
    const k = Math.min(W / img.naturalWidth, H / img.naturalHeight);
    dw = img.naturalWidth * k; dh = img.naturalHeight * k;
    dx = (W - dw) / 2; dy = (H - dh) / 2;
  } else if (mode === 'cover') {
    const k = Math.max(W / img.naturalWidth, H / img.naturalHeight);
    dw = img.naturalWidth * k; dh = img.naturalHeight * k;
    dx = (W - dw) / 2; dy = (H - dh) / 2;
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  return canvas;
}

/* --------------------- 反推提示词（图 → 提示词） --------------------- */

const REVERSE_SYS = '你是一位专业的提示词工程师。请仔细观察这张图，反推出可直接用于文生图模型的完整提示词。严格按以下分节输出，不要寒暄：\n【中文描述】主体、风格、构图、光线、色调、质感、镜头参数\n【英文提示词】逗号分隔的 tag 风格，可直接投喂模型\n【负向提示词】需要排除的元素\n【推荐设置】宽高比 + 生成模式（主图/白底图/详情页/自由）';

export async function doReversePrompt(node) {
  const busy = showBusy('正在反推提示词…');
  try {
    const route = routeBadge('vision');
    let text = '';
    let engine = '';
    let analysis = null;
    if (route && route.provider !== 'local') {
      try {
        const res = await ai.call('vision', { image: node.data.src, nodeId: node.id, task: 'reverse-prompt', prompt: REVERSE_SYS });
        if (res && res.ok !== false && res.text) {
          text = res.text;
          engine = route.label + (res.model ? ' · ' + res.model : '');
        } else if (res && res.ok === false) throw new Error(res.message || '视觉模型未返回文本');
      } catch (err) {
        toast('视觉模型不可用，改用本地图像分析', { type: 'warn', hint: String(err.message || err).slice(0, 150), timeout: 5200 });
      }
    }
    if (!text) {
      busy.update('本地图像分析中…');
      const a = await analyzeImage(node.data.src);
      analysis = a;
      text = buildLocalPromptText(a);
      engine = a.engine + '（' + a.costMs + 'ms）';
    }
    openPromptStudio({
      mode: 'reverse',
      imageNodeId: node.id,
      imageSrc: node.data.src,
      initialText: text,
      engine: engine,
      analysis: analysis
    });
    toast('提示词已反推完成', { type: 'ok', hint: engine, timeout: 4600 });
    return { ok: true, text: text, engine: engine, analysis: analysis };
  } catch (err) {
    toast('反推提示词失败', { type: 'err', hint: String(err.message || err) });
    return null;
  } finally { busy.close(); }
}

/** 无视觉接口时的本地兜底：用色彩/构图/边缘统计拼出可用提示词 */
export function buildLocalPromptText(a) {
  const an = a.analysis || {};
  const bg = an.background || {};
  const ratio = an.ratio || 1;
  const ratioLabel = ratio > 1.25 ? '16:9 横版' : ratio < 0.8 ? '3:4 竖版' : '1:1 方形';
  const mode = bg.isWhite ? '白底图' : (bg.uniform ? '主图' : '自由');
  const palette = (a.swatches || []).join(' / ');
  const lines = [
    '【中文描述】',
    a.promptZh || '（本地图像分析：' + JSON.stringify(an).slice(0, 200) + '）',
    '',
    '【英文提示词】',
    a.promptEn || '',
    '',
    '【负向提示词】',
    'blurry, lowres, jpeg artifacts, watermark, text, logo, cropped, out of frame, worst quality, low quality, deformed, extra limbs, bad anatomy',
    '',
    '【推荐设置】',
    '宽高比：' + ratioLabel + '（' + an.width + '×' + an.height + '）　生成模式：' + mode,
    '',
    '【图像客观指标】',
    '亮度 ' + an.brightness + ' · 对比度 ' + an.contrast + ' · 饱和度 ' + an.saturation + ' · 细节密度 ' + an.edgeDensity,
    '背景：' + (bg.uniform ? '纯色背景 RGB(' + (bg.rgb || []).join(',') + ')' : '复杂背景') + (bg.isWhite ? '（接近纯白，适合白底图流程）' : ''),
    '主体重心：x ' + (an.centroid ? an.centroid.x : '-') + ' / y ' + (an.centroid ? an.centroid.y : '-'),
    '主色板：' + (palette || '—'),
    '',
    '【标签】',
    (a.tags || []).join('、'),
    '',
    '※ 本结果由内置图像分析引擎生成（未配置视觉模型时的兜底方案）。在「设置 · AI 接口」里填入任一支持视觉的模型 Key（如通义千问 qwen-vl-max、智谱 glm-4v、OpenAI gpt-4o-mini）即可获得语义级反推提示词。'
  ];
  return lines.join('\n');
}

/* ------------------------------ 视频 ------------------------------ */

export async function doVideo(node) {
  const mod = await import('./video.js');
  return mod.openVideoDialog({ imageNodeIds: [node.id] });
}

/* ------------------- 批量：对多张选中图片执行同一工具 ------------------- */

export async function runToolOnSelection(toolId) {
  const nodes = Array.from(state.selection).map((id) => getNode(id)).filter((n) => n && n.data && n.data.src);
  if (!nodes.length) { toast('请先选中图片节点', { type: 'warn' }); return; }
  if (nodes.length === 1) return runTool(toolId, nodes[0].id);
  if (['resize', 'props', 'export'].indexOf(toolId) >= 0) return runTool(toolId, nodes[0].id);
  const busy = showBusy('批量处理 ' + nodes.length + ' 张图片…');
  let ok = 0, fail = 0;
  try {
    for (let i = 0; i < nodes.length; i++) {
      busy.update('批量处理中 ' + (i + 1) + '/' + nodes.length + '…');
      try {
        const r = await runTool(toolId, nodes[i].id);
        if (r) ok++; else fail++;
      } catch (err) { fail++; }
    }
    toast('批量完成：成功 ' + ok + ' 张' + (fail ? '，失败 ' + fail + ' 张' : ''), { type: fail ? 'warn' : 'ok', timeout: 5200 });
  } finally { busy.close(); }
}

export { TOOL_GROUPS, REVERSE_SYS };
