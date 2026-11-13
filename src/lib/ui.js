// Small UI helpers: toasts, modal dialogs, file IO.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function toast(msg, type = 'info', ms = 3200) {
  const el = h('div', { className: `toast ${type}` }, msg);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

export function setStatus(text, right) {
  if (text != null) $('#statusText').textContent = text;
  if (right != null) $('#statusRight').textContent = right;
}

/**
 * Show a modal. `body` is a Node or HTML string. `buttons` is a list of
 * {label, value, primary}. Resolves with {value, form} where form is the body element.
 * A button with value `null` (or Escape) cancels.
 */
export function dialog({ title, body, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: 'ok', primary: true }], onOpen, validate }) {
  return new Promise((resolve) => {
    const bodyEl = h('div', { className: 'body' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.append(body);
    const close = (value) => {
      if (value != null && validate) {
        const err = validate(bodyEl, value);
        if (err) return toast(err, 'error');
      }
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve({ value, form: bodyEl });
    };
    const foot = h('div', { className: 'foot' }, buttons.map((b) => h('button', { className: b.primary ? 'primary' : '', onclick: () => close(b.value) }, b.label)));
    const modal = h('div', { className: 'modal', role: 'dialog' }, h('h2', {}, title), bodyEl, foot);
    const back = h('div', { className: 'modal-back' }, modal);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const primary = buttons.find((b) => b.primary);
        if (primary) { e.preventDefault(); e.stopPropagation(); close(primary.value); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    onOpen?.(bodyEl, close);
    // Defer focus so the click that opened the dialog doesn't steal it back.
    setTimeout(() => {
      const first = bodyEl.querySelector('input:not([type=hidden]), textarea, select');
      first?.focus();
      if (first?.select) first.select();
    }, 50);
  });
}

/** Read named inputs in a dialog body into an object. */
export function formValues(root) {
  const out = {};
  for (const el of root.querySelectorAll('[name]')) {
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else if (el.type === 'number' || el.type === 'range') out[el.name] = el.value === '' ? null : Number(el.value);
    else out[el.name] = el.value;
  }
  return out;
}

export async function prompt(title, label, value = '', { multiline = false, type = 'text' } = {}) {
  const input = multiline
    ? h('textarea', { name: 'v', rows: 5, style: { width: '100%' } }, value)
    : h('input', { name: 'v', type, value, style: { width: '100%' } });
  const body = h('div', {}, label ? h('p', {}, label) : null, input);
  const { value: ok, form } = await dialog({ title, body });
  return ok ? form.querySelector('[name=v]').value : null;
}

export async function confirmDialog(title, message, okLabel = 'OK') {
  const { value } = await dialog({ title, body: h('p', {}, message), buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: 'ok', primary: true }] });
  return !!value;
}

export function pickFiles(accept = 'application/pdf', multiple = false) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.addEventListener('change', () => resolve([...input.files]));
    input.click();
  });
}

export const readBytes = async (file) => new Uint8Array(await file.arrayBuffer());

export function downloadBlob(data, name, mime = 'application/pdf') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/**
 * Save bytes. Uses the File System Access API where available so "Save" can
 * overwrite the same file; falls back to a download.
 */
export async function saveBytes(bytes, name, handle) {
  const desktop = window.inkstoneDesktop;
  if (desktop && !handle?.createWritable) {
    const path = await desktop.saveDialog(name);
    if (!path) return undefined;
    handle = desktopHandle(path);
  }
  if (handle?.createWritable) {
    const w = await handle.createWritable();
    await w.write(bytes);
    await w.close();
    return handle;
  }
  if (window.showSaveFilePicker) {
    try {
      const picked = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'PDF document', accept: { 'application/pdf': ['.pdf'] } }] });
      const w = await picked.createWritable();
      await w.write(bytes);
      await w.close();
      return picked;
    } catch (e) {
      if (e.name === 'AbortError') return undefined;
      // Fall through to download.
    }
  }
  downloadBlob(bytes, name);
  return null;
}

/** A FileSystemFileHandle look-alike backed by the desktop app's native file access. */
export function desktopHandle(path) {
  return {
    name: path.split(/[\\/]/).pop(),
    path,
    async createWritable() {
      let data;
      return {
        write: async (bytes) => { data = bytes; },
        close: () => window.inkstoneDesktop.writeFile(path, data),
      };
    },
  };
}

export function parsePageRange(str, total) {
  str = (str || '').trim();
  if (!str || str.toLowerCase() === 'all') return [...Array(total).keys()];
  const out = new Set();
  for (const part of str.split(',')) {
    const m = part.trim().match(/^(\d+)?\s*(-\s*(\d+)?)?$/);
    if (!m) throw new Error(`Invalid page range "${part}"`);
    const a = m[1] ? +m[1] : 1;
    const b = m[2] ? (m[3] ? +m[3] : total) : a;
    for (let i = Math.max(1, a); i <= Math.min(total, b); i++) out.add(i - 1);
  }
  return [...out].sort((x, y) => x - y);
}

export function hexToRgb01(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export const uid = () => Math.random().toString(36).slice(2, 10);
export const clone = (o) => structuredClone(o);
export const baseName = (name) => (name || 'document').replace(/\.[^.]+$/, '');
