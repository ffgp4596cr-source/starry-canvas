/**
 * 星空画布 · 生成面板
 * ------------------------------------------------------------------
 * 输入提示词 → 选择生成模式（主图 / 白底图 / 详情页 / 视频 / 自由）→
 * 选择尺寸（预设或完全自定义宽高）→ 选通道 → 生成，结果直接落到画布。
 * 支持以某张图作为参考（图生图）、批量数量、随机种子、负向提示词。
 * 同一套逻辑同时驱动右侧「生成」面板与弹窗版生成器。
 */

import { state, bus, getNode, createNode, setSelection, resolveSize, modeById, applyModeTemplate, availableRoutes, providerLabel } from '../core/state.js';
import { renderAllNodes, focusNode, findFreeSpot } from '../core/engine.js';
import { ai, hasLocalEngine } from '../ai/client.js';
import { localWhiteBackground, fitExact, localUpscale } from './imageops.js';
import { showBusy } from './exporter.js';
import { nodeSizeForImage } from './clipboard.js';
import { el, modal, toast, readImage, clamp } from '../ui/dom.js';

const MODE_ICONS = { main: '🛍', whitebg: '▢', detail: '📄', video: '🎬', free: '🎨' };

/** 从各种返回结构里取图片 */
export function pickImage(res) {
  if (!res) return null;
  if (typeof res === 'string') return res;
  if (res.image) return res.image;
  if (Array.isArray(res.images) && res.images.length) return res.images[0];
  return null;
}
export function pickAllImages(res) {
  if (!res) return [];
  if (Array.isArray(res.images)) return res.images.filter(Boolean);
  if (res.image) return [res.image];
  return [];
}

/** 最终提示词 = 模式模板 + 主体 */
export function composePrompt(modeId, subject, useTemplate) {
  if (useTemplate === false) return String(subject || '').trim();
  return applyModeTemplate(modeId, String(subject || '').trim()).trim();
}

/** 某能力当前真正可用的通道列表（过滤掉没 Key、没启用的） */
export function usableRoutes(cap) {
  return availableRoutes(cap).filter((r) => {
    if (r.provider === 'local') return hasLocalEngine(cap);
    const list = (state.catalog && state.catalog.providers) || [];
    const p = list.find((x) => x.id === r.provider);
    if (!p || !p.capabilities || !p.capabilities[cap]) return false;
    if (p.needsKey && !r.credential.key) return false;
    if (p.needsKey && r.enabled === false) return false;
    return true;
  });
}

/** 通道状态行（.route-line） */
export function routeLineEl(cap, label) {
  const routes = usableRoutes(cap);
  if (!routes.length) {
    return el('div.route-line', {}, [
      el('span.rl-dot.err'),
      el('span', { text: (label || cap) + '：暂无可用通道，请到「设置 · AI 接口」开启' })
    ]);
  }
  const primary = routes[0];
  return el('div.route-line', {}, [
    el('span.rl-dot'),
    el('span', { text: (label || cap) + '：' }),
    el('code', { text: providerLabel(primary.provider) + (primary.model ? ' / ' + primary.model : '') }),
    routes.length > 1 ? el('span.muted', { text: '（+' + (routes.length - 1) + ' 条备用，自动回退）' }) : null
  ].filter(Boolean));
}

/* ================================================================== *
 * 弹窗版生成器（功能最全）
 * ================================================================== */

export function openGenerateDialog(opts = {}) {
  const { imageNode = null, prompt = '', mode = null, sizeId = null } = opts;
  const g = state.settings.generate;
  const modes = (state.catalog && state.catalog.generationModes) || [];
  const sizes = (state.catalog && state.catalog.sizePresets) || [];

  const st = {
    subject: prompt || g.lastSubject || '',
    mode: mode || g.mode || 'main',
    sizeId: sizeId || g.sizeId || '1:1',
    customW: g.customW || 1024,
    customH: g.customH || 1024,
    count: clamp(g.count || 1, 1, 4),
    negative: g.negative || '',
    seed: g.seed || '',
    enhance: g.enhance !== false,
    useTemplate: g.useModeTemplate !== false,
    refImage: imageNode && imageNode.data ? imageNode.data.src : null,
    refNodeId: imageNode ? imageNode.id : null,
    useRef: !!imageNode
  };

  let m = null;
  let curRatio = st.customW / (st.customH || 1);

  /* ---- 提示词 ---- */
  const subjectArea = el('textarea.textarea', {
    rows: '4',
    placeholder: '描述你要生成的内容，例如：一只戴宇航员头盔的橘猫坐在月球表面，身后是蓝色地球'
  });
  subjectArea.value = st.subject;
  const count = el('span.prompt-count', { text: '0 字' });
  const negArea = el('textarea.textarea', { rows: '2', placeholder: '不想出现的元素（可选，留空则用模式默认负向词）' });
  negArea.value = st.negative;

  /* ---- 模式 ---- */
  const modeGrid = el('div.mode-grid');
  function renderModes() {
    modeGrid.textContent = '';
    for (const md of modes) {
      const card = el('button.mode-card' + (st.mode === md.id ? '.active' : ''), {
        type: 'button',
        title: md.desc,
        onclick: () => {
          st.mode = md.id;
          renderModes();
          applyModeDefaultSize();
          syncFinal();
        }
      }, [
        el('span.mc-name', {}, [el('span.mc-ico', { text: MODE_ICONS[md.id] || '✦' }), el('span', { text: md.label })]),
        el('span.mc-desc', { text: md.desc })
      ]);
      modeGrid.appendChild(card);
    }
  }
  function applyModeDefaultSize() {
    const cur = modeById(st.mode);
    if (!cur) return;
    if (cur.defaultSize && sizes.some((s) => s.id === cur.defaultSize)) {
      st.sizeId = cur.defaultSize;
      const r = resolveSize(st.sizeId, st.customW, st.customH);
      st.customW = r.width; st.customH = r.height;
      curRatio = r.width / r.height;
      wInput.value = String(r.width); hInput.value = String(r.height);
    }
    if (cur.negative && !st.negative) { st.negative = cur.negative; negArea.value = cur.negative; }
    renderSizes();
  }

  /* ---- 尺寸 ---- */
  const sizeGrid = el('div.size-grid');
  const wInput = el('input.input', { type: 'number', min: '64', max: '4096', value: String(st.customW) });
  const hInput = el('input.input', { type: 'number', min: '64', max: '4096', value: String(st.customH) });
  const linkBtn = el('button.link-ratio.on', { type: 'button', title: '锁定宽高比' , text: '🔗' });
  let lockRatio = true;
  linkBtn.addEventListener('click', () => {
    lockRatio = !lockRatio;
    linkBtn.classList.toggle('on', lockRatio);
    linkBtn.textContent = lockRatio ? '🔗' : '🔓';
  });
  const customSize = el('div.custom-size', {}, wInput, el('span.cs-x', { text: '×' }), hInput, linkBtn);

  function currentSize() { return resolveSize(st.sizeId, st.customW, st.customH); }

  function renderSizes() {
    sizeGrid.textContent = '';
    for (const s of sizes) {
      const isCustom = s.id === 'custom';
      const shapeW = isCustom ? 16 : clamp((s.ratio ? s.ratio[0] / Math.max(s.ratio[1], 0.01) : 1) * 14, 6, 26);
      const shapeH = isCustom ? 16 : clamp(14 / (s.ratio ? s.ratio[0] / Math.max(s.ratio[1], 0.01) : 1), 6, 26);
      const chip = el('button.size-chip' + (st.sizeId === s.id ? '.active' : ''), {
        type: 'button',
        title: isCustom ? '手动输入任意宽高' : s.width + '×' + s.height,
        onclick: () => {
          st.sizeId = s.id;
          renderSizes();
          if (!isCustom) {
            const r = resolveSize(s.id, st.customW, st.customH);
            st.customW = r.width; st.customH = r.height;
            curRatio = r.width / r.height;
            wInput.value = String(r.width); hInput.value = String(r.height);
          }
          syncFinal();
        }
      }, [
        el('span.sc-shape', { style: { width: Math.round(shapeW) + 'px', height: Math.round(shapeH) + 'px' } }),
        el('span.sc-label', { text: isCustom ? '自定义' : s.label })
      ]);
      sizeGrid.appendChild(chip);
    }
  }
  wInput.addEventListener('input', () => {
    st.customW = clamp(Number(wInput.value) || 64, 64, 4096);
    if (lockRatio && curRatio) { st.customH = Math.round(st.customW / curRatio); hInput.value = String(st.customH); }
    else curRatio = st.customW / (st.customH || 1);
    syncFinal();
  });
  hInput.addEventListener('input', () => {
    st.customH = clamp(Number(hInput.value) || 64, 64, 4096);
    if (lockRatio && curRatio) { st.customW = Math.round(st.customH * curRatio); wInput.value = String(st.customW); }
    else curRatio = st.customW / (st.customH || 1);
    syncFinal();
  });

  /* ---- 数量 / 种子 / 开关 ---- */
  const countRow = el('div.chip-row');
  [1, 2, 3, 4].forEach((n) => {
    const c = el('button.chip' + (st.count === n ? '.active' : ''), {
      type: 'button', text: String(n),
      onclick: () => { st.count = n; countRow.querySelectorAll('.chip').forEach((x) => x.classList.remove('active')); c.classList.add('active'); syncFinal(); }
    });
    countRow.appendChild(c);
  });
  const seedInput = el('input.input.mono', { type: 'text', placeholder: '随机', value: String(st.seed || '') });
  seedInput.addEventListener('input', () => { st.seed = seedInput.value.trim(); });
  const tplChk = el('input', { type: 'checkbox' }); tplChk.checked = st.useTemplate;
  tplChk.addEventListener('change', () => { st.useTemplate = tplChk.checked; syncFinal(); });
  const enhanceChk = el('input', { type: 'checkbox' }); enhanceChk.checked = st.enhance;
  enhanceChk.addEventListener('change', () => { st.enhance = enhanceChk.checked; });

  /* ---- 参考图 ---- */
  const refBox = el('div.reverse-preview');
  function renderRef() {
    refBox.textContent = '';
    if (!st.refImage) {
      refBox.appendChild(el('div.rp-body', {}, [
        el('div.rp-name', { text: '纯文生图' }),
        el('div.muted', { style: { fontSize: '11px' }, text: '未选择参考图。也可在画布上双击图片 → 「以此图生成」。' })
      ]));
      return;
    }
    const img = el('img'); img.src = st.refImage;
    const useChk = el('input', { type: 'checkbox' }); useChk.checked = st.useRef;
    useChk.addEventListener('change', () => { st.useRef = useChk.checked; syncFinal(); });
    refBox.append(img, el('div.rp-body', {}, [
      el('div.rp-name', { text: '参考图已挂载' }),
      el('label.chk-row', {}, useChk, el('span', { text: '作为图生图输入（需接口支持）' })),
      el('button.btn.sm.ghost', { text: '移除参考图', onclick: () => { st.refImage = null; st.refNodeId = null; st.useRef = false; renderRef(); syncFinal(); } })
    ]));
  }

  /* ---- 通道 + 最终提示词 ---- */
  const channelBox = el('div.stack', { style: { gap: '5px' } });
  const finalOut = el('div.ps-output.empty', { text: '（请输入主体描述）' });
  const finalMeta = el('div.muted', { style: { fontFamily: 'var(--font-mono)', fontSize: '10.5px', marginTop: '6px' }, text: '' });

  function syncChannel() {
    channelBox.textContent = '';
    channelBox.appendChild(routeLineEl(st.mode === 'video' ? 'video' : 'image', st.mode === 'video' ? '视频通道' : '出图通道'));
    if (st.mode === 'video') {
      channelBox.appendChild(el('div.notice.info', {}, [
        el('span.n-ico', { text: 'ⓘ' }),
        el('div.n-body', { text: '未配置云端视频接口时，会用画布上的图片在本地合成运镜视频（WebM），完全免费、不上传图片。' })
      ]));
    }
  }

  function syncFinal() {
    const finalPrompt = composePrompt(st.mode, st.subject, st.useTemplate);
    const size = currentSize();
    count.textContent = st.subject.length + ' 字';
    finalOut.textContent = finalPrompt || '（请输入主体描述）';
    finalOut.classList.toggle('empty', !finalPrompt);
    finalMeta.textContent = '模式 ' + ((modeById(st.mode) || {}).label || '-') +
      ' · 尺寸 ' + size.width + '×' + size.height +
      ' · 数量 ' + st.count +
      (st.useRef && st.refImage ? ' · 图生图' : ' · 文生图') +
      (st.negative ? ' · 负向 ' + st.negative.slice(0, 18) : '');
    syncChannel();
  }

  subjectArea.addEventListener('input', () => { st.subject = subjectArea.value; syncFinal(); });
  negArea.addEventListener('input', () => { st.negative = negArea.value; syncFinal(); });

  renderModes();
  renderSizes();
  renderRef();
  syncFinal();

  function snapshot() {
    const size = currentSize();
    return {
      subject: st.subject,
      prompt: composePrompt(st.mode, st.subject, st.useTemplate),
      negative: st.negative || ((modeById(st.mode) || {}).negative || ''),
      mode: st.mode,
      width: size.width,
      height: size.height,
      sizeLabel: size.label,
      count: st.count,
      seed: st.seed ? Number(st.seed) : null,
      enhance: st.enhance,
      refImage: st.useRef ? st.refImage : null,
      refNodeId: st.useRef ? st.refNodeId : null
    };
  }

  const goBtn = el('button.btn.primary', { text: '✦ 开始生成' });
  goBtn.addEventListener('click', async () => {
    const cfg = snapshot();
    persistSettings(cfg);
    if (m) m.close();
    await runGenerate(cfg);
  });

  m = modal({
    title: 'AI 生成',
    sub: imageNode ? '以选中图片为起点创作' : '提示词 + 模式 + 尺寸，自由选择',
    size: 'wide',
    body: el('div.exp-layout', {}, [
      el('div.stack', {}, [
        el('div.field', {}, [
          el('label.lbl', { text: '主体描述 / 提示词' }),
          el('div.prompt-box', {}, subjectArea, count, el('div.prompt-tools', {}, [
            el('button.ptool', { type: 'button', title: '清空', text: '✕', onclick: () => { st.subject = ''; subjectArea.value = ''; syncFinal(); } }),
            el('button.ptool', { type: 'button', title: '复制最终提示词', text: '⧉', onclick: async () => { await navigator.clipboard.writeText(composePrompt(st.mode, st.subject, st.useTemplate)).catch(() => {}); toast('提示词已复制', { type: 'ok', timeout: 1600 }); } })
          ]))
        ]),
        el('div.field', {}, [el('label.lbl', { text: '负向提示词' }), negArea]),
        el('div.field', {}, [el('label.lbl', { text: '生成模式' }), modeGrid]),
        el('div.field', {}, [el('label.lbl', { text: '尺寸（预设 / 自定义）' }), sizeGrid, customSize])
      ]),
      el('div.stack', {}, [
        el('div.field', {}, [el('label.lbl', { text: '数量与参数' }),
          el('div.inline-row', {}, el('span.muted', { text: '数量' }), countRow),
          el('div.inline-row', {}, el('span.muted', { text: '种子' }), seedInput),
          el('label.chk-row', {}, tplChk, el('span', { text: '套用模式提示词模板' })),
          el('label.chk-row', {}, enhanceChk, el('span', { text: '允许接口自动优化提示词' }))
        ]),
        el('div.field', {}, [el('label.lbl', { text: '参考图' }), refBox]),
        el('div.field', {}, [el('label.lbl', { text: '调用通道' }), channelBox]),
        el('div.field', {}, [el('label.lbl', { text: '最终提示词' }), finalOut, finalMeta])
      ])
    ]),
    footer: [
      el('button.btn.ghost', { text: '取消', onclick: () => m.close() }),
      goBtn
    ]
  });
  return m;
}

function persistSettings(cfg) {
  Object.assign(state.settings.generate, {
    mode: cfg.mode,
    sizeId: state.settings.generate.sizeId,
    customW: cfg.width,
    customH: cfg.height,
    count: cfg.count,
    negative: cfg.negative,
    enhance: cfg.enhance,
    lastSubject: cfg.subject
  });
  bus.emit('settings:changed', state.settings);
}

/** 把提示词存成画布上的提示词卡 */
export function addPromptCard(text, meta) {
  const spot = findFreeSpot(340, 200);
  const node = createNode({
    type: 'prompt',
    x: Math.round(spot.x), y: Math.round(spot.y),
    w: 340, h: clamp(130 + Math.ceil(text.length / 26) * 19, 130, 440),
    data: { text: text },
    meta: {
      source: 'prompt-studio',
      title: '提示词卡片',
      mode: meta && meta.mode ? meta.mode : '',
      size: meta && meta.width ? meta.width + '×' + meta.height : '',
      createdAt: Date.now()
    }
  });
  setSelection([node.id]);
  renderAllNodes();
  bus.emit('history:push', { label: '新建提示词卡' });
  toast('提示词已存到画布', { type: 'ok', timeout: 2000 });
  return node;
}

/* ================================================================== *
 * 实际生成
 * ================================================================== */

export async function runGenerate(cfg) {
  if (!cfg.prompt || !cfg.prompt.trim()) { toast('请先输入提示词', { type: 'warn' }); return null; }
  if (cfg.mode === 'video') {
    const mod = await import('./video.js');
    return mod.openVideoDialog({ prompt: cfg.prompt, width: cfg.width, height: cfg.height, refImage: cfg.refImage, negative: cfg.negative });
  }

  const busy = showBusy('正在生成…');
  const t0 = performance.now();
  const total = clamp(cfg.count || 1, 1, 4);
  try {
    const created = [];
    for (let i = 0; i < total; i++) {
      busy.update('正在生成 ' + (i + 1) + '/' + total + '…');
      const payload = {
        prompt: cfg.prompt,
        negativePrompt: cfg.negative || '',
        width: cfg.width,
        height: cfg.height,
        n: 1,
        count: 1,
        seed: cfg.seed != null ? cfg.seed + i : Math.floor(Math.random() * 99999999),
        enhance: !!cfg.enhance,
        mode: cfg.mode,
        refImage: cfg.refImage || null,
        nodeId: cfg.refNodeId || null
      };
      const res = await ai.call('image', payload);
      const imgs = pickAllImages(res);
      if (!imgs.length) throw new Error((res && res.message) || '接口没有返回图片');
      const md = modeById(cfg.mode);
      let dataUrl = imgs[0];
      let engine = providerLabel(res.__route ? res.__route.provider : 'unknown') + (res.model ? ' · ' + res.model : '');

      if (md && (md.postProcess || []).indexOf('whiteBackground') >= 0) {
        try {
          busy.update('白底后处理中…');
          const wb = await localWhiteBackground(dataUrl);
          dataUrl = wb.dataUrl;
          engine += ' + 本地白底合成';
        } catch (err) {
          toast('白底后处理失败，保留原图', { type: 'warn', hint: String(err.message || err), timeout: 4200 });
        }
      }

      // 高清增强：免费接口常把图压到 512–768（请求 1024 只回 768），
      // 先按比例放大到目标尺寸附近并锐化，再精确对齐——解决"模糊"痛点
      if (cfg.width && cfg.height) {
        const isWhite = !!(md && (md.postProcess || []).indexOf('whiteBackground') >= 0);
        try {
          busy.update('高清增强中…');
          // 读取实际像素尺寸
          const probe = await readImage(dataUrl);
          const natW = probe.naturalWidth, natH = probe.naturalHeight;
          const targetW = cfg.width, targetH = cfg.height;
          // 若实际图明显小于目标（任一边 < 目标的 80%），先本地放大
          if (natW && natH && (natW < targetW * 0.8 || natH < targetH * 0.8)) {
            const factor = clamp(Math.max(targetW / (natW || 1), targetH / (natH || 1)), 1, 4);
            if (factor > 1.15) {
              const up = await localUpscale(dataUrl, { factor: Math.min(2, factor), sharpen: 1.2 });
              if (up.dataUrl) {
                dataUrl = up.dataUrl;
                engine += ' + 本地高清增强';
              }
            }
          }
        } catch (err) {
          // 高清增强失败不影响出图，继续
        }
        try {
          busy.update('对齐目标尺寸…');
          const fit = await fitExact(dataUrl, cfg.width, cfg.height, { mode: 'cover', bg: isWhite ? '#ffffff' : null });
          if (fit.changed) { dataUrl = fit.dataUrl; engine += ` · 已对齐 ${fit.width}×${fit.height}`; }
        } catch (err) {
          toast('尺寸对齐失败，保留接口原始尺寸', { type: 'warn', hint: String(err.message || err), timeout: 4200 });
        }
      }

      const img = await readImage(dataUrl);
      const size = nodeSizeForImage(img.naturalWidth, img.naturalHeight, 460);
      const anchor = created.length ? created[created.length - 1] : (cfg.refNodeId ? getNode(cfg.refNodeId) : null);
      const near = anchor ? { x: anchor.x + anchor.w + 40, y: anchor.y } : null;
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
          mode: cfg.mode,
          modeLabel: md ? md.label : '',
          engine: res.model || ''
        },
        meta: {
          source: 'generate',
          title: (md ? md.label : '生成') + ' ' + cfg.width + '×' + cfg.height,
          parentId: cfg.refNodeId || null,
          prompt: cfg.prompt,
          negative: cfg.negative || '',
          mode: cfg.mode,
          seed: payload.seed,
          engine: engine,
          createdAt: Date.now()
        }
      });
      created.push(node);
      state.stats.generated++;
    }
    setSelection(created.map((n) => n.id));
    renderAllNodes();
    if (created[0]) focusNode(created[0].id);
    bus.emit('history:push', { label: 'AI 生成' });
    bus.emit('project:save-request');
    bus.emit('generate:done', { nodes: created, cfg: cfg });
    const ms = Math.round(performance.now() - t0);
    toast('生成完成 ' + created.length + ' 张', {
      type: 'ok',
      hint: (created[0] ? created[0].meta.engine : '') + ' · ' + ms + 'ms',
      timeout: 5600
    });
    return created;
  } catch (err) {
    const hint = err && err.hint ? ' · ' + err.hint : '';
    const tried = err && err.tried ? ' · 已尝试 ' + err.tried.map((t) => providerLabel(t.provider) + '：' + (t.skipped || t.error)).join('；') : '';
    toast('生成失败', { type: 'err', hint: (String(err.message || err) + hint + tried).slice(0, 320), timeout: 9000 });
    return null;
  } finally { busy.close(); }
}

/** 用现成提示词直接生成（提示词工坊调用） */
export function generateFromPrompt(text, opts = {}) {
  opts = opts || {};
  const g = state.settings.generate;
  const size = resolveSize(opts.sizeId || g.sizeId || '1:1', opts.width || g.customW || 1024, opts.height || g.customH || 1024);
  const mode = opts.mode || 'free';
  return runGenerate({
    subject: text,
    prompt: text,
    negative: opts.negative || (modeById(mode) || {}).negative || '',
    mode: mode,
    width: opts.width || size.width,
    height: opts.height || size.height,
    sizeLabel: size.label,
    count: opts.count || 1,
    seed: opts.seed != null ? opts.seed : null,
    enhance: false,
    refImage: opts.refImage || null,
    refNodeId: opts.refNodeId || null
  });
}

/* ================================================================== *
 * 右侧「生成」面板（紧凑版，与弹窗共享 runGenerate）
 * ================================================================== */

export function renderGeneratePanel(host) {
  const g = state.settings.generate;
  const modes = (state.catalog && state.catalog.generationModes) || [];
  const sizes = (state.catalog && state.catalog.sizePresets) || [];
  const st = {
    subject: g.lastSubject || '',
    mode: g.mode || 'main',
    sizeId: g.sizeId || '1:1',
    customW: g.customW || 1024,
    customH: g.customH || 1024,
    useTemplate: g.useModeTemplate !== false,
    refImage: null,
    refNodeId: null
  };
  // 若画布上已选中图片，默认挂为参考图
  const sel = Array.from(state.selection).map((id) => getNode(id)).filter((n) => n && n.data && n.data.src);
  if (sel.length) { st.refImage = sel[0].data.src; st.refNodeId = sel[0].id; }

  host.textContent = '';
  host.appendChild(el('div.gen-hero', {}, [
    el('span.gh-ico', { text: '✦' }),
    el('div', {}, [
      el('div.gh-t', { text: 'AI 生成' }),
      el('div.gh-s', { text: '提示词 + 模式 + 尺寸，结果直接落到画布' })
    ])
  ]));

  const area = el('textarea.textarea', { rows: '5', placeholder: '例如：极简风格的无线耳机，浅灰背景，柔和顶光，产品悬浮' });
  area.value = st.subject;
  const cnt = el('span.prompt-count', { text: '0 字' });

  const modeGrid = el('div.mode-grid');
  const sizeGrid = el('div.size-grid');
  const wInput = el('input.input', { type: 'number', min: '64', max: '4096', value: String(st.customW) });
  const hInput = el('input.input', { type: 'number', min: '64', max: '4096', value: String(st.customH) });
  const customSize = el('div.custom-size', {}, wInput, el('span.cs-x', { text: '×' }), hInput,
    el('button.link-ratio', { type: 'button', text: '⤢', title: '打开完整生成器（更多参数）', onclick: () => openGenerateDialog({ prompt: st.subject, mode: st.mode }) }));
  const channel = el('div.stack', { style: { gap: '5px' } });
  const finalOut = el('div.ps-output.empty', { text: '（输入描述后显示最终提示词）' });
  const tplChk = el('input', { type: 'checkbox' }); tplChk.checked = st.useTemplate;
  tplChk.addEventListener('change', () => { st.useTemplate = tplChk.checked; sync(); });

  function currentSize() { return resolveSize(st.sizeId, st.customW, st.customH); }
  function renderModes() {
    modeGrid.textContent = '';
    for (const md of modes) {
      modeGrid.appendChild(el('button.mode-card' + (st.mode === md.id ? '.active' : ''), {
        type: 'button', title: md.desc,
        onclick: () => {
          st.mode = md.id;
          renderModes();
          if (md.defaultSize && sizes.some((s) => s.id === md.defaultSize)) {
            st.sizeId = md.defaultSize;
            const r = resolveSize(md.defaultSize, st.customW, st.customH);
            st.customW = r.width; st.customH = r.height;
            wInput.value = String(r.width); hInput.value = String(r.height);
            renderSizes();
          }
          sync();
        }
      }, [
        el('span.mc-name', {}, [el('span.mc-ico', { text: MODE_ICONS[md.id] || '✦' }), el('span', { text: md.label })]),
        el('span.mc-desc', { text: md.desc })
      ]));
    }
  }
  function renderSizes() {
    sizeGrid.textContent = '';
    for (const s of sizes) {
      const isCustom = s.id === 'custom';
      sizeGrid.appendChild(el('button.size-chip' + (st.sizeId === s.id ? '.active' : ''), {
        type: 'button', title: isCustom ? '自定义宽高' : s.width + '×' + s.height,
        onclick: () => {
          st.sizeId = s.id; renderSizes();
          if (!isCustom) {
            const r = resolveSize(s.id, st.customW, st.customH);
            st.customW = r.width; st.customH = r.height;
            wInput.value = String(r.width); hInput.value = String(r.height);
          }
          sync();
        }
      }, [el('span.sc-label', { text: isCustom ? '自定义' : s.label })]));
    }
  }
  function sync() {
    const size = currentSize();
    cnt.textContent = st.subject.length + ' 字';
    const fp = composePrompt(st.mode, st.subject, st.useTemplate);
    finalOut.textContent = fp || '（输入描述后显示最终提示词）';
    finalOut.classList.toggle('empty', !fp);
    channel.textContent = '';
    channel.appendChild(routeLineEl(st.mode === 'video' ? 'video' : 'image', st.mode === 'video' ? '视频' : '出图'));
  }
  area.addEventListener('input', () => { st.subject = area.value; sync(); });
  wInput.addEventListener('input', () => { st.customW = clamp(Number(wInput.value) || 64, 64, 4096); st.sizeId = 'custom'; renderSizes(); sync(); });
  hInput.addEventListener('input', () => { st.customH = clamp(Number(hInput.value) || 64, 64, 4096); st.sizeId = 'custom'; renderSizes(); sync(); });

  renderModes();
  renderSizes();
  sync();

  const strip = el('div.result-strip');
  const off = bus.on('generate:done', ({ nodes }) => {
    strip.textContent = '';
    nodes.forEach((n) => {
      const t = el('img.result-thumb', { title: n.meta.title, onclick: () => focusNode(n.id) });
      t.src = n.data.src;
      strip.appendChild(t);
    });
  });
  host.addEventListener('panel:destroy', () => { if (typeof off === 'function') off(); });

  host.append(
    el('div.panel-section', {}, [
      el('div.sec-title', { text: '提示词' }),
      el('div.prompt-box', {}, area, cnt, el('div.prompt-tools', {}, [
        el('button.ptool', { type: 'button', title: '套用/取消模板', text: '⌘', onclick: () => { tplChk.checked = !tplChk.checked; st.useTemplate = tplChk.checked; sync(); } }),
        el('button.ptool', { type: 'button', title: '打开提示词工坊', text: '✎', onclick: () => bus.emit('panel:open', { panel: 'prompt', subject: st.subject }) })
      ])),
      el('label.chk-row', { style: { marginTop: '6px' } }, tplChk, el('span', { text: '套用模式提示词模板' }))
    ]),
    el('div.panel-section', {}, [el('div.sec-title', { text: '生成模式' }), modeGrid]),
    el('div.panel-section', {}, [el('div.sec-title', { text: '尺寸（可自定义）' }), sizeGrid, customSize]),
    el('div.panel-section', {}, [el('div.sec-title', { text: '通道与最终提示词' }), channel, finalOut]),
    el('div.gen-actions', {}, [
      el('button.btn.ghost', { text: '完整参数', onclick: () => openGenerateDialog({ prompt: st.subject, mode: st.mode, sizeId: st.sizeId }) }),
      el('button.btn.primary', {
        text: '✦ 生成',
        onclick: () => {
          const size = currentSize();
          persistSettings({ mode: st.mode, width: size.width, height: size.height, count: 1, negative: '', enhance: true, subject: st.subject });
          runGenerate({
            subject: st.subject,
            prompt: composePrompt(st.mode, st.subject, st.useTemplate),
            negative: (modeById(st.mode) || {}).negative || '',
            mode: st.mode, width: size.width, height: size.height, sizeLabel: size.label,
            count: 1, seed: null, enhance: true,
            refImage: st.refImage, refNodeId: st.refNodeId
          });
        }
      })
    ]),
    strip
  );
}
