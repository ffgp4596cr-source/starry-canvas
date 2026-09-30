/**
 * 星空画布 · 智能对话
 * ------------------------------------------------------------------
 * 右侧对话面板：支持流式输出、图片附件（看图问答）、快捷提问、
 * 一键把回答复制 / 存成画布卡片 / 当作提示词直接生成图片。
 * 走统一的 ai.call('chat')，自动在免费模型与自备 API 之间回退。
 */

import { state, bus, getNode, createNode, setSelection, providerLabel } from '../core/state.js';
import { renderAllNodes, findFreeSpot, focusNode } from '../core/engine.js';
import { ai, readSseStream } from '../ai/client.js';
import { usableRoutes, generateFromPrompt, addPromptCard } from './generate.js';
import { openPromptStudio, extractSection } from './prompt-studio.js';
import { el, toast, copyText, clamp } from '../ui/dom.js';

const QUICK = [
  '帮我把这张图改成电商主图提示词',
  '这组产品图怎么拍更像大牌？',
  '给我 5 个白底图的构图建议',
  '详情页首屏应该放什么内容？',
  '把这段描述翻译成英文提示词',
  '帮我诊断这张图的问题'
];

let hostRef = null;
let logRef = null;
let inputRef = null;
let sendRef = null;
let attachRef = null;

function rerender() { if (hostRef && document.body.contains(hostRef)) renderChatPanel(hostRef); }

export function openChat(opts = {}) {
  if (opts.question) state.chat.draft = opts.question;
  bus.emit('panel:open', { panel: 'chat' });
  setTimeout(() => { rerender(); if (inputRef) inputRef.focus(); }, 0);
}

/** 双击图片 → 「就这张图对话」 */
export function chatWithImage(node, question = '') {
  if (node && node.data && node.data.src) {
    state.chat.attach = { nodeId: node.id, src: node.data.src, title: (node.meta && node.meta.title) || '图片' };
  }
  state.chat.draft = question || '';
  openChat();
}

export function setChatAttachment(nodeId) {
  const node = getNode(nodeId);
  if (!node || !node.data || !node.data.src) return false;
  state.chat.attach = { nodeId: node.id, src: node.data.src, title: (node.meta && node.meta.title) || '图片' };
  rerender();
  return true;
}

/* ================================================================== *
 * 渲染
 * ================================================================== */

export function renderChatPanel(host) {
  hostRef = host;
  host.textContent = '';
  const wrap = el('div.chat-wrap');
  host.appendChild(wrap);

  logRef = el('div.chat-log');
  wrap.appendChild(logRef);

  const msgs = state.chat.messages || [];
  if (!msgs.length) {
    logRef.appendChild(el('div.chat-empty', {}, [
      el('div', { text: '✦ 星空画布 AI 助手' }),
      el('div', { style: { fontSize: '11px', marginTop: '4px' }, text: '可以问提示词、构图、电商视觉、平台规范；也能挂着图片让我看图点评。' }),
      el('div.chat-quick', {}, QUICK.map((q) => el('button.ps-tag', {
        text: q.length > 16 ? q.slice(0, 16) + '…' : q, title: q,
        onclick: () => { state.chat.draft = q; rerender(); if (inputRef) { inputRef.value = q; inputRef.focus(); } }
      })))
    ]));
  } else {
    msgs.forEach((msg, i) => logRef.appendChild(messageEl(msg, i)));
  }

  /* ---- 输入区 ---- */
  const bottom = el('div.stack', { style: { gap: '6px', flex: 'none' } });
  if (state.chat.attach) {
    attachRef = el('div.chat-attach-badge', {}, [
      el('span', { text: '🖼 ' + (state.chat.attach.title || '已附图') }),
      el('button.ptool', { text: '✕', title: '移除附件', onclick: () => { state.chat.attach = null; rerender(); } })
    ]);
    bottom.appendChild(attachRef);
  }
  const routes = usableRoutes('chat');
  bottom.appendChild(el('div.route-line', {}, [
    el('span.rl-dot' + (routes.length ? '' : '.err')),
    el('span', { text: '对话通道：' }),
    el('code', { text: routes.length ? providerLabel(routes[0].provider) + (routes[0].model ? ' / ' + routes[0].model : '') : '未配置' })
  ]));

  inputRef = el('textarea.textarea', { rows: '2', placeholder: '输入问题，Enter 发送 / Shift+Enter 换行' });
  inputRef.value = state.chat.draft || '';
  inputRef.addEventListener('input', () => {
    state.chat.draft = inputRef.value;
    inputRef.style.height = 'auto';
    inputRef.style.height = clamp(inputRef.scrollHeight, 40, 130) + 'px';
    if (sendRef) sendRef.disabled = !inputRef.value.trim() || state.chat.pending;
  });
  inputRef.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });

  sendRef = el('button.chat-send', { text: '➤', title: '发送', disabled: true });
  sendRef.addEventListener('click', () => send());

  bottom.appendChild(el('div.chat-input-row', {}, [
    el('button.btn.sm.ghost', { text: '🖼', title: '附图提问', onclick: () => bus.emit('panel:pick-image', { for: 'chat' }) }),
    inputRef,
    sendRef,
    el('button.btn.sm.ghost', { text: '🗑', title: '清空对话', onclick: () => { state.chat.messages = []; state.chat.attach = null; rerender(); } })
  ]));
  wrap.appendChild(bottom);

  setTimeout(() => {
    if (sendRef) sendRef.disabled = !(inputRef.value || '').trim() || state.chat.pending;
    if (logRef) logRef.scrollTop = logRef.scrollHeight;
  }, 0);
}

function messageEl(msg, idx) {
  const isUser = msg.role === 'user';
  const bubble = el('div.m-bubble' + (msg.streaming ? '.streaming' : '') + (msg.error ? '.err' : ''));
  if (msg.attach && msg.attach.src) {
    const img = el('img.m-attach');
    img.src = msg.attach.src;
    bubble.appendChild(img);
  }
  bubble.appendChild(el('div', { text: msg.error ? '⚠ ' + msg.content : msg.content }));

  const acts = [];
  if (!isUser && !msg.streaming) {
    acts.push(el('button.m-act', { text: '复制', onclick: async () => { const ok = await copyText(msg.content); toast(ok ? '已复制' : '复制失败', { type: ok ? 'ok' : 'err', timeout: 1600 }); } }));
    acts.push(el('button.m-act', { text: '存为画布卡片', onclick: () => { addTextCard(msg.content, 'AI 回答'); } }));
    acts.push(el('button.m-act', {
      text: '作为提示词生成', onclick: () => {
        const zh = extractSection(msg.content, '成品提示词') || extractSection(msg.content, '英文提示词') || msg.content.slice(0, 400);
        generateFromPrompt(zh, { mode: 'free' });
      }
    }));
    acts.push(el('button.m-act', { text: '送入提示词工坊', onclick: () => openPromptStudio({ mode: 'expand', subject: '', initialText: msg.content, engine: '来自对话' }) }));
  }
  const meta = el('div.m-meta', {}, [
    el('span', { text: isUser ? '你' : (msg.engine || 'AI') }),
    msg.costMs ? el('span', { text: msg.costMs + 'ms' }) : null,
    ...acts
  ].filter(Boolean));

  return el('div.msg' + (isUser ? '.user' : ''), {}, [
    el('div.m-avatar', { text: isUser ? '我' : '✦' }),
    el('div', { style: { minWidth: '0', flex: '1' } }, [bubble, meta])
  ]);
}

function addTextCard(text, title) {
  const spot = findFreeSpot(340, 200);
  const node = createNode({
    type: 'text',
    x: Math.round(spot.x), y: Math.round(spot.y),
    w: 340, h: clamp(120 + Math.ceil(text.length / 26) * 19, 120, 460),
    data: { text: text },
    meta: { source: 'chat', title: title || 'AI 回答', createdAt: Date.now() }
  });
  setSelection([node.id]);
  renderAllNodes();
  focusNode(node.id);
  bus.emit('history:push', { label: '对话存卡片' });
  toast('已存到画布', { type: 'ok', timeout: 2000 });
  return node;
}

/* ================================================================== *
 * 发送
 * ================================================================== */

async function send() {
  const text = (inputRef ? inputRef.value : state.chat.draft || '').trim();
  if (!text) { toast('请输入内容', { type: 'warn' }); return; }
  if (state.chat.pending) { toast('上一条还在回答中', { type: 'warn', timeout: 1800 }); return; }
  const routes = usableRoutes('chat');
  if (!routes.length) {
    toast('没有可用的对话通道', { type: 'err', hint: '到「设置 · AI 接口」开启一个供应商（Pollinations 免费模型无需 Key）', timeout: 8000 });
    return;
  }

  const attach = state.chat.attach;
  const userMsg = { role: 'user', content: text, attach: attach ? { src: attach.src, title: attach.title } : null, ts: Date.now() };
  const aiMsg = { role: 'assistant', content: '', streaming: true, engine: '', ts: Date.now() };
  state.chat.messages.push(userMsg, aiMsg);
  state.chat.pending = true;
  state.chat.draft = '';
  state.chat.attach = null;
  rerender();

  const t0 = performance.now();
  const history = buildMessages(text, attach);
  const aiIdx = state.chat.messages.length - 1;

  try {
    const res = await ai.call('chat', {
      messages: history,
      prompt: text,
      image: attach ? attach.src : null,
      system: state.settings.chat.systemPrompt,
      stream: state.settings.chat.stream !== false
    });

    if (res && res.stream) {
      await readSseStream(res.stream, {
        onDelta: (delta) => {
          aiMsg.content += delta;
          const bubble = logRef && logRef.children[aiIdx] ? logRef.children[aiIdx].querySelector('.m-bubble > div:last-child') : null;
          if (bubble) { bubble.textContent = aiMsg.content; logRef.scrollTop = logRef.scrollHeight; }
        }
      });
      aiMsg.engine = '流式 · ' + providerLabel(res.__route ? res.__route.provider : routes[0].provider) + (res.localVision ? ' + 本地看图理解' : '');
    } else if (res && res.text) {
      aiMsg.content = res.text;
      aiMsg.engine = providerLabel(res.__route ? res.__route.provider : routes[0].provider) + (res.model ? ' / ' + res.model : '');
    } else {
      throw new Error((res && res.message) || '模型没有返回内容');
    }
    aiMsg.streaming = false;
    aiMsg.costMs = Math.round(performance.now() - t0);
    trimHistory();
  } catch (err) {
    aiMsg.streaming = false;
    aiMsg.error = true;
    aiMsg.content = String(err.message || err) + (err.hint ? '\n建议：' + err.hint : '');
    aiMsg.engine = '失败';
    toast('对话失败', { type: 'err', hint: String(err.message || err).slice(0, 160), timeout: 8000 });
  } finally {
    state.chat.pending = false;
    rerender();
    bus.emit('project:save-request');
  }
}

function buildMessages(text, attach) {
  const keep = clamp(state.settings.chat.keepContext || 12, 2, 60);
  const sys = state.settings.chat.systemPrompt;
  const prev = (state.chat.messages || [])
    .slice(0, -2) // 排除刚 push 的这两条
    .filter((m) => !m.error && m.content)
    .slice(-keep)
    .map((m) => ({ role: m.role, content: m.content }));
  const out = [];
  if (sys) out.push({ role: 'system', content: sys });
  out.push(...prev);
  if (attach && attach.src) {
    out.push({
      role: 'user',
      content: [
        { type: 'text', text: text },
        { type: 'image_url', image_url: { url: attach.src } }
      ]
    });
  } else {
    out.push({ role: 'user', content: text });
  }
  return out;
}

function trimHistory() {
  const max = 80;
  if (state.chat.messages.length > max) state.chat.messages = state.chat.messages.slice(-max);
}

export { addTextCard, QUICK };
