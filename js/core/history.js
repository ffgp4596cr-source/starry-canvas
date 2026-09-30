/**
 * 星空画布 · 撤销 / 重做
 * 采用快照式历史：每个条目只保存节点的几何、文本与标记，
 * 图片 dataURL 以字符串引用方式共享（JS 字符串不可变），
 * 因此上百个节点、几十步历史也不会显著占用内存。
 */

import { state, bus } from './state.js';

const LIMIT = 60;
const past = [];
const future = [];
let current = null;
let restoring = false;

function snapshot() {
  return {
    nodes: Array.from(state.nodes.values()).map((n) => ({
      id: n.id, type: n.type,
      x: n.x, y: n.y, w: n.w, h: n.h,
      rotation: n.rotation, z: n.z,
      locked: n.locked, hidden: n.hidden,
      data: { ...n.data },
      meta: { ...n.meta }
    })),
    zCounter: state.zCounter,
    ts: Date.now()
  };
}

function restore(snap) {
  if (!snap) return;
  restoring = true;
  try {
    state.nodes.clear();
    state.selection.clear();
    for (const raw of snap.nodes) {
      state.nodes.set(raw.id, {
        ...raw,
        data: { ...raw.data },
        meta: { ...raw.meta }
      });
    }
    state.zCounter = snap.zCounter;
    bus.emit('project:restored');
    bus.emit('nodes:changed');
    bus.emit('selection:changed', []);
  } finally {
    restoring = false;
  }
}

export function beginHistory() {
  current = snapshot();
  past.length = 0;
  future.length = 0;
  updateButtons();
}

export function pushHistory(label = '') {
  if (restoring) return;
  if (!current) { beginHistory(); return; }
  const next = snapshot();
  // 内容完全一致就不入栈，避免污染历史
  if (JSON.stringify(next.nodes) === JSON.stringify(current.nodes)) return;
  past.push({ snap: current, label });
  if (past.length > LIMIT) past.shift();
  current = next;
  future.length = 0;
  updateButtons();
}

export function undo() {
  if (!past.length) return false;
  const entry = past.pop();
  future.push({ snap: current, label: entry.label });
  current = entry.snap;
  restore(current);
  updateButtons();
  return entry.label || '撤销';
}

export function redo() {
  if (!future.length) return false;
  const entry = future.pop();
  past.push({ snap: current, label: entry.label });
  current = entry.snap;
  restore(current);
  updateButtons();
  return entry.label || '重做';
}

export function canUndo() { return past.length > 0; }
export function canRedo() { return future.length > 0; }

export function historySize() { return { undo: past.length, redo: future.length }; }

function updateButtons() {
  const u = document.getElementById('tool-undo');
  const r = document.getElementById('tool-redo');
  if (u) { u.disabled = !past.length; u.style.opacity = past.length ? '' : '0.35'; }
  if (r) { r.disabled = !future.length; r.style.opacity = future.length ? '' : '0.35'; }
  bus.emit('history:changed', historySize());
}

export function initHistory() {
  bus.on('history:push', (p) => pushHistory(p?.label || ''));
  bus.on('history:begin', () => beginHistory());
  bus.on('history:clear', () => beginHistory());
  beginHistory();
}
