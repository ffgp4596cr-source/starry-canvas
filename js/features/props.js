/**
 * 星空画布 · 属性面板
 * ------------------------------------------------------------------
 * 显示选中节点的完整属性与来源链路（哪个工具、哪条通道、什么提示词生成），
 * 支持重命名、改尺寸、旋转、层级、锁定、删除，以及跳到父节点追溯创作树。
 * 未选中时显示画布统计与工程信息。
 */

import { state, bus, getNode, updateNode, removeNodes, setSelection, allNodes } from '../core/state.js';
import { renderAllNodes, renderNode, focusNode, fitToContent } from '../core/engine.js';
import { runTool } from './tools.js';
import { quickDownloadNode, openExportDialog } from './exporter.js';
import { el, toast, copyText, humanSize, fmtTime } from '../ui/dom.js';

let hostRef = null;

export function openPropsPanel(nodeId) {
  if (nodeId) setSelection([nodeId]);
  bus.emit('panel:open', { panel: 'props' });
}

export function renderPropsPanel(host) {
  hostRef = host;
  host.textContent = '';
  const ids = Array.from(state.selection);
  const nodes = ids.map((id) => getNode(id)).filter(Boolean);

  if (!nodes.length) { renderCanvasInfo(host); return; }
  if (nodes.length > 1) { renderMulti(host, nodes); return; }
  renderSingle(host, nodes[0]);
}

function row(k, vNode) {
  return el('div.prop-row', {}, [el('span.pk', { text: k }), typeof vNode === 'string' ? el('span', { style: { fontSize: '12px', wordBreak: 'break-all' }, text: vNode }) : vNode]);
}

function renderSingle(host, node) {
  const d = node.data;
  const m = node.meta || {};

  if (d.src) {
    const img = el('img.prop-preview');
    img.src = d.src;
    host.appendChild(img);
  }

  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '基本信息' }),
    row('名称', el('input.input', {
      value: m.title || '', placeholder: '未命名',
      onchange: (e) => { updateNode(node.id, { meta: Object.assign({}, m, { title: e.target.value }) }); renderNode(node.id); toast('已重命名', { type: 'ok', timeout: 1500 }); }
    })),
    row('类型', { image: '图片', text: '文本卡片', note: '便签', prompt: '提示词卡', video: '视频', chat: '对话卡' }[node.type] || node.type),
    row('画布尺寸', Math.round(node.w) + ' × ' + Math.round(node.h) + ' px'),
    d.natW ? row('原始像素', d.natW + ' × ' + d.natH + ' px') : null,
    d.bytes ? row('数据体积', humanSize(d.bytes)) : null,
    d.mime ? row('格式', d.mime) : null,
    row('坐标', 'x ' + Math.round(node.x) + ' · y ' + Math.round(node.y)),
    row('层级', 'z ' + node.z),
    m.createdAt ? row('创建时间', fmtTime(m.createdAt)) : null
  ].filter(Boolean)));

  if (m.source || m.engine || m.prompt || m.tool || m.parentId) {
    const chain = [];
    let cur = node;
    let guard = 0;
    while (cur && guard++ < 12) {
      chain.unshift(cur);
      cur = cur.meta && cur.meta.parentId ? getNode(cur.meta.parentId) : null;
    }
    host.appendChild(el('div.panel-section', {}, [
      el('div.sec-title', { text: '来源与链路' }),
      row('来源', { paste: '剪贴板粘贴', file: '文件载入', generate: 'AI 生成', tool: '工具处理', copy: '画布复制', duplicate: '复制节点', prompt: '提示词', chat: '对话' }[m.source] || m.source || '—'),
      m.tool ? row('工具', m.tool) : null,
      m.engine ? row('通道 / 引擎', m.engine) : null,
      m.mode ? row('生成模式', m.mode) : null,
      m.seed != null ? row('随机种子', String(m.seed)) : null,
      m.note ? row('备注', m.note) : null,
      row('创作链路', el('div.ps-tags', {}, chain.map((c, i) => el('button.ps-tag', {
        text: (i + 1) + '. ' + ((c.meta && c.meta.title) || c.type).slice(0, 12),
        onclick: () => focusNode(c.id)
      }))))
    ].filter(Boolean)));
  }

  if (m.prompt) {
    const out = el('div.ps-output', { text: m.prompt });
    host.appendChild(el('div.panel-section', {}, [
      el('div.sec-title', { text: '提示词' }),
      out,
      el('div.ps-output-bar', {}, [
        el('button.btn.sm.ghost', { text: '复制', onclick: async () => { const ok = await copyText(m.prompt); toast(ok ? '已复制' : '复制失败', { type: ok ? 'ok' : 'err', timeout: 1600 }); } }),
        el('button.btn.sm.primary', { text: '再次生成', onclick: () => bus.emit('panel:open', { panel: 'generate', prompt: m.prompt }) })
      ])
    ]));
  }

  if (node.type === 'image' || node.type === 'video') {
    host.appendChild(el('div.panel-section', {}, [
      el('div.sec-title', { text: '快速操作' }),
      el('div.prop-actions', {}, [
        el('button.btn.sm.ghost', { text: '✨ 变清晰', onclick: () => runTool('upscale', node.id) }),
        el('button.btn.sm.ghost', { text: '✂ 抠图', onclick: () => runTool('matting', node.id) }),
        el('button.btn.sm.ghost', { text: '▢ 白底图', onclick: () => runTool('whitebg', node.id) }),
        el('button.btn.sm.ghost', { text: '⤢ 改尺寸', onclick: () => runTool('resize', node.id) }),
        el('button.btn.sm.ghost', { text: '🔍 反推提示词', onclick: () => runTool('reverse', node.id) }),
        el('button.btn.sm.ghost', { text: '🎬 转视频', onclick: () => runTool('video', node.id) }),
        el('button.btn.sm.ghost', { text: '⬇ 下载', onclick: () => quickDownloadNode(node.id) }),
        el('button.btn.sm.ghost', { text: '⇩ 导出为…', onclick: () => openExportDialog(node.id) })
      ])
    ]));
  }

  const rotVal = el('span.slider-val', { text: (node.rotation || 0) + '°' });
  const rotRange = el('input', { type: 'range', min: '-180', max: '180', step: '1', value: String(node.rotation || 0) });
  rotRange.addEventListener('input', () => { rotVal.textContent = rotRange.value + '°'; });
  rotRange.addEventListener('change', () => {
    updateNode(node.id, { rotation: Number(rotRange.value) });
    renderNode(node.id);
    bus.emit('history:push', { label: '旋转' });
  });

  const scaleVal = el('span.slider-val', { text: '100%' });
  const scaleRange = el('input', { type: 'range', min: '10', max: '300', step: '5', value: '100' });
  scaleRange.addEventListener('input', () => { scaleVal.textContent = scaleRange.value + '%'; });
  scaleRange.addEventListener('change', () => {
    const k = Number(scaleRange.value) / 100;
    updateNode(node.id, { w: Math.max(24, Math.round(node.w * k)), h: Math.max(24, Math.round(node.h * k)) });
    renderNode(node.id);
    bus.emit('history:push', { label: '缩放节点' });
    scaleRange.value = '100';
    scaleVal.textContent = '100%';
  });

  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '变换' }),
    el('div.prop-grid2', {}, [
      el('div.field', {}, [el('label.lbl', { text: '旋转角度' }), el('div.slider-row', {}, rotRange, rotVal)]),
      el('div.field', {}, [el('label.lbl', { text: '整体缩放' }), el('div.slider-row', {}, scaleRange, scaleVal)])
    ]),
    el('div.prop-actions', { style: { marginTop: '8px' } }, [
      el('button.btn.sm.ghost', { text: '置顶', onclick: () => { updateNode(node.id, { z: state.zCounter++ }); renderAllNodes(); bus.emit('history:push', { label: '置顶' }); } }),
      el('button.btn.sm.ghost', { text: '复制一份', onclick: () => runTool('duplicate', node.id) }),
      el('button.btn.sm.ghost', { text: node.hidden ? '取消隐藏' : '隐藏', onclick: () => { updateNode(node.id, { hidden: !node.hidden }); renderAllNodes(); bus.emit('history:push', { label: '隐藏切换' }); } }),
      el('button.btn.sm.danger', { text: '删除', onclick: () => { removeNodes([node.id]); renderAllNodes(); bus.emit('history:push', { label: '删除节点' }); } })
    ])
  ]));
}

function renderMulti(host, nodes) {
  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '多选 ' + nodes.length + ' 个节点' }),
    row('类型统计', Object.keys(nodes.reduce((acc, n) => { acc[n.type] = (acc[n.type] || 0) + 1; return acc; }, {}))
      .map((k) => k + ' × ' + nodes.filter((n) => n.type === k).length).join(' · ')),
    row('总数据量', humanSize(nodes.reduce((s, n) => s + (n.data.bytes || 0), 0)))
  ]));
  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '批量操作' }),
    el('div.prop-actions', {}, [
      el('button.btn.sm.ghost', { text: '✨ 批量变清晰', onclick: () => batch('upscale', nodes) }),
      el('button.btn.sm.ghost', { text: '✂ 批量抠图', onclick: () => batch('matting', nodes) }),
      el('button.btn.sm.ghost', { text: '▢ 批量白底', onclick: () => batch('whitebg', nodes) }),
      el('button.btn.sm.ghost', { text: '⬇ 逐个下载', onclick: () => nodes.filter((n) => n.data.src).forEach((n, i) => setTimeout(() => quickDownloadNode(n.id), i * 400)) }),
      el('button.btn.sm.ghost', { text: '⇩ 合并导出', onclick: () => openExportDialog() }),
      el('button.btn.sm.danger', { text: '全部删除', onclick: () => { removeNodes(nodes.map((n) => n.id)); renderAllNodes(); bus.emit('history:push', { label: '批量删除' }); } })
    ])
  ]));
}

async function batch(toolId, nodes) {
  const { runToolOnSelection } = await import('./tools.js');
  return runToolOnSelection(toolId);
}

function renderCanvasInfo(host) {
  const nodes = allNodes();
  const imgs = nodes.filter((n) => n.data && n.data.src);
  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '画布信息' }),
    row('节点总数', String(nodes.length)),
    row('图片节点', String(imgs.length)),
    row('数据总量', humanSize(nodes.reduce((s, n) => s + ((n.data && n.data.bytes) || 0), 0))),
    row('视口', 'x ' + Math.round(state.viewport.x) + ' · y ' + Math.round(state.viewport.y)),
    row('缩放', Math.round(state.viewport.scale * 100) + '%'),
    row('主题', state.settings.theme === 'dark' ? '深色（星空黑）' : '浅色（科技白）'),
    row('运行形态', state.backend ? '本地服务代理（node server.js）' : '浏览器直连（单文件版）'),
    row('累计生成', state.stats.generated + ' 张 · 处理 ' + state.stats.processed + ' 次')
  ]));
  host.appendChild(el('div.panel-section', {}, [
    el('div.sec-title', { text: '操作' }),
    el('div.prop-actions', {}, [
      el('button.btn.sm.ghost', { text: '适应全部内容', onclick: () => fitToContent() }),
      el('button.btn.sm.ghost', { text: '导出画布', onclick: () => openExportDialog() }),
      el('button.btn.sm.ghost', { text: '导出工程 JSON', onclick: () => openExportDialog() }),
      el('button.btn.sm.ghost', { text: '打开设置', onclick: () => bus.emit('settings:open') })
    ])
  ]));
  host.appendChild(el('div.pane-empty', {}, [
    el('span.pe-ico', { text: '✦' }),
    el('div', { text: '选中画布上的节点查看属性' }),
    el('div', { style: { fontSize: '11px' }, text: '双击图片可直接唤出 AI 工具菜单' })
  ]));
}

