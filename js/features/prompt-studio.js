/**
 * 星空画布 · 提示词工坊
 * ------------------------------------------------------------------
 * 两个方向：
 *   输出提示词（expand）：给主体 + 选风格标签 → 产出可直接投喂模型的成品提示词
 *   反推提示词（reverse）：给一张图 → 反推出可复用的提示词
 * 有云端接口时走大模型（chat / vision），没有时用本地模板与本地图像分析兜底，
 * 保证这两个核心能力在任何环境下都真实可用。
 */

import { state, bus, getNode, setSelection, modeById } from '../core/state.js';
import { ai } from '../ai/client.js';
import { analyzeImage } from './imageops.js';
import { usableRoutes, composePrompt, generateFromPrompt, addPromptCard } from './generate.js';
import { buildLocalPromptText } from './tools.js';
import { pickFiles } from './clipboard.js';
import { el, toast, copyText } from '../ui/dom.js';

const STYLE_TAGS = {
  风格: ['商业摄影', '极简主义', '赛博朋克', '国潮插画', '日系清新', '3D 渲染', '扁平插画', '写实油画', '胶片质感', '未来科技'],
  光线: ['柔和顶光', '侧逆光', '影棚柔光箱', '黄金时刻自然光', '霓虹冷光', '高调明亮', '低调暗调', '轮廓光'],
  构图: ['主体居中', '三分法构图', '俯拍平铺', '45 度斜角', '微距特写', '留白构图', '对称构图', '全景 wide shot'],
  质感: ['超高细节', '锐利清晰', '磨砂哑光', '金属光泽', '玻璃通透', '织物纹理', '8k 画质', 'raw photo']
};

const LANGS = [['zh', '中文'], ['en', '英文'], ['both', '中英双语']];

const psState = {
  tab: 'expand',
  subject: '',
  mode: 'main',
  lang: 'both',
  tags: {},
  output: '',
  engine: '',
  imageNodeId: null,
  imageSrc: null,
  analysis: null,
  busy: false
};

let hostRef = null;

function rerender() { if (hostRef && document.body.contains(hostRef)) renderPromptPanel(hostRef); }

// 生成面板里的「✎ 打开提示词工坊」只发事件、不带函数引用，这里吸收它带来的 subject。
// 模块级监听在 boot() 之前注册，因此先于 main.js 的 openPanel 执行。
bus.on('panel:open', (p) => {
  if (!p || (p.panel || p.id) !== 'prompt') return;
  if (p.subject != null) {
    psState.subject = String(p.subject);
    psState.tab = 'expand';
  }
});

/** 供工具菜单/右键调用：带着图片打开工坊 */
export function openPromptStudio(opts = {}) {
  // 显式指定 mode 时以 mode 为准；只有「带着图但没说要干嘛」才默认落到反推页
  if (opts.mode === 'expand' || opts.mode === 'reverse') psState.tab = opts.mode;
  else if (opts.imageSrc || opts.imageNodeId) psState.tab = 'reverse';
  else if (opts.mode) psState.tab = opts.mode;
  if (opts.subject != null) { psState.subject = String(opts.subject); }
  if (opts.imageNodeId) psState.imageNodeId = opts.imageNodeId;
  if (opts.imageSrc) psState.imageSrc = opts.imageSrc;
  if (opts.initialText) { psState.output = String(opts.initialText); psState.engine = opts.engine || ''; }
  if (opts.analysis) psState.analysis = opts.analysis;
  bus.emit('panel:open', { panel: 'prompt' });
  setTimeout(rerender, 0);
}

/* ================================================================== *
 * 面板渲染
 * ================================================================== */

export function renderPromptPanel(host) {
  hostRef = host;
  host.textContent = '';

  const tabs = el('div.ps-tabs', {}, [
    el('button.ps-tab' + (psState.tab === 'expand' ? '.active' : ''), { text: '✍ 输出提示词', onclick: () => { psState.tab = 'expand'; rerender(); } }),
    el('button.ps-tab' + (psState.tab === 'reverse' ? '.active' : ''), { text: '🔍 反推提示词', onclick: () => { psState.tab = 'reverse'; rerender(); } })
  ]);
  host.appendChild(tabs);

  if (psState.tab === 'expand') renderExpand(host);
  else renderReverse(host);

  host.appendChild(renderOutput());
}

/* ---------------------------- 输出提示词 ---------------------------- */

function renderExpand(host) {
  const modes = (state.catalog && state.catalog.generationModes) || [];
  const subject = el('textarea.textarea', { rows: '3', placeholder: '用一句话说明你要什么，例如：一款主打降噪的无线耳机' });
  subject.value = psState.subject;
  subject.addEventListener('input', () => { psState.subject = subject.value; });

  const modeRow = el('div.ps-tags');
  modes.forEach((md) => {
    modeRow.appendChild(el('button.ps-tag' + (psState.mode === md.id ? '.on' : ''), {
      text: md.label, title: md.desc,
      onclick: () => { psState.mode = md.id; rerender(); }
    }));
  });

  const langRow = el('div.ps-tags');
  LANGS.forEach((pair) => {
    langRow.appendChild(el('button.ps-tag' + (psState.lang === pair[0] ? '.on' : ''), {
      text: pair[1], onclick: () => { psState.lang = pair[0]; rerender(); }
    }));
  });

  const tagSlots = el('div.stack', { style: { gap: '2px' } });
  Object.keys(STYLE_TAGS).forEach((group) => {
    const wrap = el('div.ps-tags');
    STYLE_TAGS[group].forEach((t) => {
      const on = !!psState.tags[t];
      wrap.appendChild(el('button.ps-tag' + (on ? '.on' : ''), {
        text: t,
        onclick: () => {
          if (psState.tags[t]) delete psState.tags[t]; else psState.tags[t] = group;
          rerender();
        }
      }));
    });
    tagSlots.appendChild(el('div.ps-slot', {}, [el('div.ps-k', { text: group }), el('div.ps-v', {}, wrap)]));
  });

  const canCloud = !!usableRoutes('chat').length;
  host.append(
    el('div.panel-section', {}, [
      el('div.sec-title', { text: '主体描述' }),
      subject
    ]),
    el('div.panel-section', {}, [
      el('div.sec-title', { text: '生成模式' }),
      modeRow,
      el('div.muted', { style: { fontSize: '11px', marginTop: '6px' }, text: (modeById(psState.mode) || {}).desc || '' })
    ]),
    el('div.panel-section', {}, [el('div.sec-title', { text: '输出语言' }), langRow]),
    el('div.panel-section', {}, [el('div.sec-title', { text: '风格标签（点选叠加）' }), tagSlots]),
    el('div.panel-section', {}, [
      el('div.sec-title', { text: '通道' }),
      canCloud
        ? el('div.notice.ok', {}, [el('span.n-ico', { text: '✓' }), el('div.n-body', { text: '将由大模型扩写为成品提示词（' + usableRoutes('chat')[0].provider + '）。' })])
        : el('div.notice.info', {}, [el('span.n-ico', { text: 'ⓘ' }), el('div.n-body', { text: '未配置对话模型时使用内置模板引擎本地拼装，同样可用。' })])
    ]),
    el('div.gen-actions', {}, [
      el('button.btn.ghost', { text: '清空标签', onclick: () => { psState.tags = {}; rerender(); } }),
      el('button.btn.primary', { text: '✦ 生成提示词', onclick: () => doExpand() })
    ])
  );
}

async function doExpand() {
  const subject = (psState.subject || '').trim();
  if (!subject) { toast('请先写一句主体描述', { type: 'warn' }); return; }
  const picked = Object.keys(psState.tags);
  const md = modeById(psState.mode);
  psState.busy = true;
  rerender();
  try {
    let text = '';
    let engine = '';
    const routes = usableRoutes('chat');
    if (routes.length) {
      try {
        const sys = '你是电商视觉提示词工程师。根据用户给的主体、目标用途与风格标签，产出可直接投喂文生图模型的成品提示词。严格按要求输出，不要寒暄、不要解释。';
        const user = [
          '主体：' + subject,
          '用途/模式：' + (md ? md.label + '（' + md.desc + '）' : '自由创作'),
          '风格标签：' + (picked.length ? picked.join('、') : '（未指定，请你补齐合适的商业摄影风格）'),
          '输出语言：' + (psState.lang === 'zh' ? '仅中文' : psState.lang === 'en' ? '仅英文' : '中英双语'),
          '',
          '请按以下分节输出：',
          '【成品提示词】一段连贯、细节充分的描述（60-140 字）',
          '【英文提示词】逗号分隔 tag 风格，可直接投喂模型',
          '【负向提示词】需要排除的元素',
          '【推荐尺寸】结合用途给出宽高比与像素尺寸'
        ].join('\n');
        const res = await ai.call('chat', { messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], stream: false });
        if (res && res.text) { text = res.text; engine = '大模型扩写 · ' + routes[0].provider + (res.model ? ' / ' + res.model : ''); }
      } catch (err) {
        toast('大模型扩写失败，改用本地模板', { type: 'warn', hint: String(err.message || err).slice(0, 140), timeout: 5200 });
      }
    }
    if (!text) { text = localExpand(subject, picked, md); engine = '本地模板引擎'; }
    psState.output = text;
    psState.engine = engine;
    toast('提示词已生成', { type: 'ok', hint: engine, timeout: 3200 });
  } finally {
    psState.busy = false;
    rerender();
  }
}

/** 无大模型时的本地模板拼装（保证功能始终可用） */
function localExpand(subject, picked, md) {
  const tpl = md ? md.promptTemplate : '{subject}';
  const base = tpl.replace(/\{subject\}/g, subject);
  const zh = [base, picked.length ? picked.join('，') : ''].filter(Boolean).join('，');
  const enMap = {
    '商业摄影': 'commercial product photography', '极简主义': 'minimalist', '赛博朋克': 'cyberpunk',
    '国潮插画': 'chinese style illustration', '日系清新': 'japanese fresh style', '3D 渲染': '3d render, octane',
    '扁平插画': 'flat illustration', '写实油画': 'realistic oil painting', '胶片质感': 'film grain, analog photo',
    '未来科技': 'futuristic tech', '柔和顶光': 'soft top light', '侧逆光': 'side backlight',
    '影棚柔光箱': 'studio softbox lighting', '黄金时刻自然光': 'golden hour natural light', '霓虹冷光': 'neon cold light',
    '高调明亮': 'high key bright', '低调暗调': 'low key dark', '轮廓光': 'rim light',
    '主体居中': 'centered composition', '三分法构图': 'rule of thirds', '俯拍平铺': 'flat lay top view',
    '45 度斜角': '45 degree angle', '微距特写': 'macro close-up', '留白构图': 'negative space composition',
    '对称构图': 'symmetrical composition', '全景 wide shot': 'wide shot',
    '超高细节': 'ultra detailed', '锐利清晰': 'ultra sharp', '磨砂哑光': 'matte finish',
    '金属光泽': 'metallic gloss', '玻璃通透': 'translucent glass', '织物纹理': 'fabric texture',
    '8k 画质': '8k', 'raw photo': 'raw photo'
  };
  const en = ['professional product shot of ' + subject, picked.map((t) => enMap[t]).filter(Boolean).join(', '), 'high detail, sharp focus, clean background, 8k'].filter(Boolean).join(', ');
  const neg = (md && md.negative) || 'blurry, lowres, watermark, text, logo, deformed, worst quality';
  const sizeMap = { main: '1:1（1024×1024）', whitebg: '1:1（800×800 起，平台白底规范）', detail: '3:4（896×1152）或 2:3 长图', video: '9:16（720×1280）', free: '1:1（1024×1024）' };
  return [
    '【成品提示词】', zh, '',
    '【英文提示词】', en, '',
    '【负向提示词】', neg, '',
    '【推荐尺寸】', sizeMap[(md && md.id) || 'free'] || '1:1（1024×1024）', '',
    '※ 由内置模板引擎生成（未配置对话模型时的兜底方案）。'
  ].join('\n');
}

/* ---------------------------- 反推提示词 ---------------------------- */

function renderReverse(host) {
  const node = psState.imageNodeId ? getNode(psState.imageNodeId) : null;
  const src = psState.imageSrc || (node && node.data ? node.data.src : null);

  const previewBody = el('div.rp-body');
  if (src) {
    const img = el('img'); img.src = src;
    previewBody.append(
      el('div.rp-name', { text: (node && node.meta && node.meta.title) || '当前图片' }),
      el('div.rp-tags', {}, [
        el('span.rp-tag', { text: node && node.data.natW ? node.data.natW + '×' + node.data.natH : '已挂载' }),
        psState.engine ? el('span.rp-tag', { text: psState.engine.split(' · ')[0] }) : null
      ].filter(Boolean)),
      el('div.swatch-row', {}, (psState.analysis && psState.analysis.swatches ? psState.analysis.swatches : []).map((c) => {
        const s = el('span.swatch', { title: c }); s.style.background = c; return s;
      })),
      el('div.gen-actions', { style: { marginTop: '8px' } }, [
        el('button.btn.sm.ghost', { text: '换一张', onclick: () => { psState.imageNodeId = null; psState.imageSrc = null; psState.analysis = null; bus.emit('panel:pick-image', { for: 'reverse' }); rerender(); } }),
        el('button.btn.sm.primary', { text: '🔍 开始反推', onclick: () => doReverse() })
      ])
    );
    host.appendChild(el('div.panel-section', {}, [el('div.sec-title', { text: '待反推图片' }), el('div.reverse-preview', {}, img, previewBody)]));
  } else {
    host.appendChild(el('div.panel-section', {}, [
      el('div.sec-title', { text: '待反推图片' }),
      el('div.pane-empty', {}, [
        el('span.pe-ico', { text: '🖼' }),
        el('div', { text: '还没有选择图片' }),
        el('div.gen-actions', { style: { marginTop: '12px' } }, [
          el('button.btn.sm.ghost', { text: '用画布选中的图', onclick: () => { pickFromCanvas(); } }),
          el('button.btn.sm.primary', { text: '上传图片', onclick: () => { bus.emit('panel:pick-image', { for: 'reverse' }); } })
        ])
      ])
    ]));
  }

  if (psState.analysis) {
    const an = psState.analysis.analysis || {};
    const rows = [
      ['亮度', an.brightness], ['对比度', an.contrast], ['饱和度', an.saturation], ['细节密度', an.edgeDensity]
    ];
    host.appendChild(el('div.panel-section', {}, [
      el('div.sec-title', { text: '客观指标' }),
      el('div.prop-grid2', {}, rows.map((r) => el('div.prop-row', {}, [
        el('span.pk', { text: r[0] }),
        el('span.mono', { style: { fontSize: '11.5px' }, text: String(r[1]) })
      ]))),
      el('div.muted', { style: { fontSize: '11px', marginTop: '6px' }, text: '背景：' + (an.background && an.background.uniform ? '纯色' + (an.background.isWhite ? '（近纯白）' : '') : '复杂') + ' · 主体重心 ' + (an.centroid ? an.centroid.x + '/' + an.centroid.y : '-') })
    ]));
  }

  const canVision = usableRoutes('vision').some((r) => r.provider !== 'local');
  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '通道' }),
    canVision
      ? el('div.notice.ok', {}, [el('span.n-ico', { text: '✓' }), el('div.n-body', { text: '已配置视觉模型，可做语义级反推。' })])
      : el('div.notice.info', {}, [
        el('span.n-ico', { text: 'ⓘ' }),
        el('div.n-body', {}, [
          el('div', { text: '当前使用内置图像分析引擎（色彩 / 构图 / 边缘统计）反推，完全离线可用。' }),
          el('div', { style: { marginTop: '4px' }, text: '想获得语义级描述，在「设置 · AI 接口」填入任一视觉模型 Key（通义 qwen-vl-max、智谱 glm-4v、OpenAI gpt-4o-mini 等）。' })
        ])
      ])
  ]));
}

function pickFromCanvas() {
  const sel = Array.from(state.selection).map((id) => getNode(id)).filter((n) => n && n.data && n.data.src);
  if (!sel.length) { toast('画布上没有选中的图片', { type: 'warn', hint: '先点选一张图，或直接上传' }); return; }
  psState.imageNodeId = sel[0].id;
  psState.imageSrc = sel[0].data.src;
  psState.analysis = null;
  rerender();
}

export function attachImageToStudio(nodeId) {
  const node = getNode(nodeId);
  if (!node || !node.data || !node.data.src) return false;
  psState.imageNodeId = nodeId;
  psState.imageSrc = node.data.src;
  psState.analysis = null;
  psState.tab = 'reverse';
  rerender();
  return true;
}

async function doReverse() {
  const node = psState.imageNodeId ? getNode(psState.imageNodeId) : null;
  const src = psState.imageSrc || (node && node.data ? node.data.src : null);
  if (!src) { toast('请先选择图片', { type: 'warn' }); return; }
  psState.busy = true;
  rerender();
  try {
    let text = '';
    let engine = '';
    let analysis = null;
    const routes = usableRoutes('vision').filter((r) => r.provider !== 'local');
    if (routes.length) {
      try {
        const res = await ai.call('vision', {
          image: src,
          nodeId: psState.imageNodeId,
          task: 'reverse-prompt',
          prompt: '你是一位专业的提示词工程师。请仔细观察这张图，反推出可直接用于文生图模型的完整提示词。严格按以下分节输出，不要寒暄：\n【中文描述】主体、风格、构图、光线、色调、质感、镜头参数\n【英文提示词】逗号分隔的 tag 风格\n【负向提示词】需要排除的元素\n【推荐设置】宽高比 + 生成模式（主图/白底图/详情页/自由）'
        });
        if (res && res.text) { text = res.text; engine = '视觉模型 · ' + routes[0].provider + (res.model ? ' / ' + res.model : ''); }
      } catch (err) {
        toast('视觉模型不可用，改用本地分析', { type: 'warn', hint: String(err.message || err).slice(0, 140), timeout: 5200 });
      }
    }
    if (!text) {
      analysis = await analyzeImage(src);
      text = buildLocalPromptText(analysis);
      engine = '本地图像分析（' + analysis.costMs + 'ms）';
    }
    psState.output = text;
    psState.engine = engine;
    psState.analysis = analysis || psState.analysis;
    toast('反推完成', { type: 'ok', hint: engine, timeout: 3600 });
  } catch (err) {
    toast('反推失败', { type: 'err', hint: String(err.message || err) });
  } finally {
    psState.busy = false;
    rerender();
  }
}

/* ---------------------------- 输出区 ---------------------------- */

function renderOutput() {
  const out = el('div.ps-output' + (psState.output ? '' : '.empty'), {
    text: psState.output || '（结果会显示在这里，可自由编辑后复制、存卡片或直接生成）'
  });
  out.contentEditable = 'true';
  out.spellcheck = false;
  out.addEventListener('input', () => { psState.output = out.textContent; });

  const bar = el('div.ps-output-bar', {}, [
    el('button.btn.sm.ghost', { text: '⧉ 复制', onclick: async () => {
      if (!psState.output) { toast('还没有可复制的内容', { type: 'warn' }); return; }
      const ok = await copyText(psState.output);
      toast(ok ? '提示词已复制' : '复制失败', { type: ok ? 'ok' : 'err', timeout: 2000 });
    } }),
    el('button.btn.sm.ghost', { text: '▤ 存为画布卡片', onclick: () => {
      if (!psState.output) { toast('还没有内容', { type: 'warn' }); return; }
      addPromptCard(psState.output, { mode: psState.mode });
    } }),
    el('button.btn.sm.primary', { text: '✦ 用这个提示词生成', onclick: () => {
      if (!psState.output) { toast('还没有提示词', { type: 'warn' }); return; }
      const zh = extractSection(psState.output, '成品提示词') || extractSection(psState.output, '中文描述') || firstPlainLine(psState.output);
      generateFromPrompt(zh || psState.output.slice(0, 400), {
        mode: psState.tab === 'reverse' ? 'free' : psState.mode,
        negative: extractSection(psState.output, '负向提示词') || '',
        refImage: psState.imageSrc,
        refNodeId: psState.imageNodeId
      });
    } })
  ]);

  return el('div.panel-section', {}, [
    el('div.sec-title', { text: '输出结果' + (psState.engine ? ' · ' + psState.engine : '') }),
    out,
    bar
  ]);
}

/** 从分节文本里取某一节内容 */
export function extractSection(text, title) {
  const re = new RegExp('【\\s*' + title + '\\s*】\\s*([\\s\\S]*?)(?=\\n【|$)');
  const m = re.exec(String(text || ''));
  return m ? m[1].trim() : '';
}

function firstPlainLine(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('【') && !s.startsWith('※'));
  return lines[0] || '';
}

export { psState, STYLE_TAGS };
