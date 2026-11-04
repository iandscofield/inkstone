import './styles.css';
import * as E from './lib/engine.js';
import { openPdf, renderPageToCanvas } from './lib/pdfjs.js';
import { $, $$, h, toast, setStatus, dialog, prompt, readBytes, saveBytes, baseName, desktopHandle } from './lib/ui.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { Annotator, TYPE_LABELS } from './annotations.js';
import * as tools from './tools.js';

const MAX_HISTORY = 40;

const state = {
  bytes: null, // current unencrypted PDF bytes (annotations not yet flattened)
  pdf: null, // pdf.js document for rendering
  fileName: 'document.pdf',
  fileHandle: null,
  security: null, // {userPassword, ownerPassword, permissions} applied on save
  dirty: false,
  busy: false,
  undo: [],
  redo: [],
};

const app = {
  state,
  get pageCount() { return state.pdf?.numPages || 0; },
  get current() { return viewer.current; },
  author: () => localStorage.getItem('pdfpro.author') || 'PDF Pro user',
};

// ---------- core components ----------

const viewer = new Viewer($('#viewerWrap'), $('#viewer'), {
  onPageChange: (i) => {
    $('#pageInput').value = state.pdf ? i + 1 : 0;
    thumbs.setCurrent(i);
    updateStatus();
  },
  onPageCreated: (p) => annots.attachPage(p),
  onZoom: (scale, mode) => {
    const sel = $('#zoomSelect');
    const preset = [...sel.options].find((o) => o.value === mode || (mode === 'custom' && Math.abs(Number(o.value) - scale) < 0.001));
    if (preset) sel.value = preset.value;
    else {
      const custom = sel.querySelector('[value=custom]');
      custom.textContent = `${Math.round(scale * 100)}%`;
      sel.value = 'custom';
    }
    annots.renderAll();
  },
});
const annots = new Annotator(app);
const thumbs = new Thumbnails($('#thumbs'), {
  onNavigate: (i) => viewer.scrollToPage(i),
  onReorder: (order) => runOp('Reordering pages', (b) => E.reorderPages(b, order), { remap: (i) => order.indexOf(i) }),
  onDropFiles: (files, at) => insertFiles(files, at),
});
Object.assign(app, { viewer, annots, thumbs });

// ---------- history ----------

function snapshot() {
  return { bytes: state.bytes, annots: annots.snapshot(), security: state.security };
}

function pushUndo(snap) {
  state.undo.push(snap);
  if (state.undo.length > MAX_HISTORY) state.undo.shift();
  state.redo = [];
  state.dirty = true;
  updateUI();
}

app.checkpoint = () => pushUndo(snapshot());

async function restore(snap, from, to) {
  if (!from.length) return;
  to.push(snapshot());
  const prev = from.pop();
  const bytesChanged = prev.bytes !== state.bytes;
  state.bytes = prev.bytes;
  state.security = prev.security;
  annots.restore(prev.annots);
  state.dirty = true;
  if (bytesChanged) await reload({ keepPosition: true, keepSelection: true });
  else { annots.renderAll(); app.onAnnotationsChanged(); }
  app.renderProps(null);
  updateUI();
}
const undo = () => restore(null, state.undo, state.redo);
const redo = () => restore(null, state.redo, state.undo);

// ---------- document lifecycle ----------

function setBusy(label) {
  state.busy = !!label;
  document.body.style.cursor = label ? 'progress' : '';
  if (label) setStatus(`${label}…`);
  else updateStatus();
}

async function reload({ keepPosition = false, keepSelection = false } = {}) {
  const old = state.pdf;
  state.pdf = state.bytes ? await openPdf(state.bytes) : null;
  await viewer.setDocument(state.pdf, { keepPosition });
  thumbs.setDocument(state.pdf, { keepSelection });
  thumbs.setCurrent(viewer.current);
  old?.destroy();
  $('#dropHint').hidden = !!state.pdf;
  renderOutline();
  app.onAnnotationsChanged();
  updateUI();
}

/**
 * Run a bytes -> bytes operation as one undoable step.
 * remap: re-index annotations after page moves; flatten: pages whose annotations
 * must be burned in first (rotation/crop change their coordinate space).
 */
async function runOp(label, fn, { remap, flatten } = {}) {
  if (!state.bytes || state.busy) return false;
  setBusy(label);
  try {
    const snap = snapshot();
    let bytes = state.bytes;
    let taken = [];
    if (flatten) {
      const set = new Set(flatten);
      taken = annots.list.filter((a) => set.has(a.page) && a.type !== 'redact');
      if (taken.length) bytes = await E.applyAnnotations(bytes, taken);
    }
    const out = await fn(bytes);
    if (!out) return false;
    pushUndo(snap);
    if (taken.length) annots.list = annots.list.filter((a) => !taken.includes(a));
    if (remap) annots.remap(remap);
    state.bytes = out;
    await reload({ keepPosition: true, keepSelection: true });
    return true;
  } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error', 6000);
    return false;
  } finally {
    setBusy(null);
  }
}
app.runOp = runOp;

/** Current document with annotations flattened in (used for save, print, export). */
app.outputBytes = async ({ includeRedactions = false } = {}) => {
  const list = annots.list.filter((a) => includeRedactions || a.type !== 'redact');
  return list.length ? E.applyAnnotations(state.bytes, list) : state.bytes;
};

async function unlock(bytes, name) {
  const { encrypted } = await E.inspect(bytes);
  if (!encrypted) return { bytes };
  try {
    return { bytes: await E.decrypt(bytes, ''), security: null };
  } catch { /* needs a password */ }
  for (let attempt = 0; attempt < 3; attempt++) {
    const pw = await prompt('Password required', `"${name}" is protected. Enter the password to open it.`, '', { type: 'password' });
    if (pw == null) return null;
    try {
      return { bytes: await E.decrypt(bytes, pw), security: { userPassword: pw, ownerPassword: pw } };
    } catch {
      toast('Incorrect password', 'error');
    }
  }
  return null;
}

async function toPdfBytes(files) {
  const images = files.filter((f) => /^image\/(png|jpe?g)$/.test(f.type));
  const pdfs = files.filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const out = [];
  for (const f of pdfs) {
    const res = await unlock(await readBytes(f), f.name);
    if (res) out.push({ name: f.name, ...res });
  }
  if (images.length) {
    const imgs = await Promise.all(images.map(async (f) => ({ bytes: await readBytes(f), type: f.type === 'image/png' ? 'image/png' : 'image/jpeg' })));
    out.push({ name: `${baseName(images[0].name)}.pdf`, bytes: await E.imagesToPdf(imgs) });
  }
  return out;
}

async function openFiles(files, handle = null) {
  if (!files.length) return;
  if (!(await confirmDiscard())) return;
  setBusy('Opening');
  try {
    const docs = await toPdfBytes(files);
    if (!docs.length) return;
    let bytes = docs[0].bytes;
    for (const d of docs.slice(1)) {
      const n = (await E.load(bytes)).getPageCount();
      bytes = await E.insertDocument(bytes, d.bytes, n);
    }
    Object.assign(state, {
      bytes, fileName: docs.length > 1 ? 'Combined.pdf' : docs[0].name, fileHandle: docs.length === 1 && files[0].type === 'application/pdf' ? handle : null,
      security: docs[0].security || null, dirty: docs.length > 1 || !files[0].name.endsWith('.pdf'), undo: [], redo: [],
    });
    annots.restore([]);
    viewer.zoomMode = 'fit-width';
    await reload();
    document.title = `${state.fileName} – PDF Pro`;
    if (docs[0].security) toast('Document unlocked. It will stay password-protected when saved unless you remove security.');
  } catch (e) {
    console.error(e);
    toast(`Could not open file: ${e.message}`, 'error', 6000);
  } finally {
    setBusy(null);
  }
}

async function insertFiles(files, at) {
  if (!state.bytes) return openFiles(files);
  const docs = await toPdfBytes(files);
  if (!docs.length) return;
  let count = 0;
  const counts = await Promise.all(docs.map(async (d) => (await E.load(d.bytes)).getPageCount()));
  count = counts.reduce((a, b) => a + b, 0);
  const pos = at ?? app.pageCount;
  await runOp('Inserting pages', async (b) => {
    let out = b;
    let offset = pos;
    for (const [k, d] of docs.entries()) {
      out = await E.insertDocument(out, d.bytes, offset);
      offset += counts[k];
    }
    return out;
  }, { remap: (i) => (i >= pos ? i + count : i) });
  toast(`Inserted ${count} page${count === 1 ? '' : 's'}`);
}
app.insertFiles = insertFiles;

async function confirmDiscard() {
  if (!state.dirty || !state.bytes) return true;
  const { value } = await dialog({
    title: 'Unsaved changes',
    body: h('p', {}, `Discard unsaved changes to "${state.fileName}"?`),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Discard', value: 'ok', primary: true }],
  });
  return !!value;
}

/** Files handed over by the desktop app (Open dialog, "Open with", double-click). */
function openDesktopFiles(list) {
  if (!list?.length) return;
  const files = list.map((f) => new File([f.bytes], f.name, { type: /\.pdf$/i.test(f.name) ? 'application/pdf' : /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' }));
  return openFiles(files, list.length === 1 ? desktopHandle(list[0].path) : null);
}

async function openCommand() {
  if (window.pdfProDesktop) return openDesktopFiles(await window.pdfProDesktop.openDialog());
  if (window.showOpenFilePicker) {
    try {
      const handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'PDF or images', accept: { 'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'] } }],
      });
      const files = await Promise.all(handles.map((x) => x.getFile()));
      return openFiles(files, handles.length === 1 ? handles[0] : null);
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  $('#fileInput').click();
}

async function save(saveAs = false) {
  if (!state.bytes) return;
  if (annots.list.some((a) => a.type === 'redact')) {
    const { value } = await dialog({
      title: 'Pending redactions',
      body: h('p', {}, 'This document has areas marked for redaction. Apply them now? Redacted pages are converted to images so the hidden content is permanently removed.'),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Apply & save', value: 'ok', primary: true }],
    });
    if (!value) return;
    if (!(await tools.applyRedactions(app))) return;
  }
  setBusy('Saving');
  try {
    const out = await E.prepareForSave(await app.outputBytes(), state.security);
    const handle = await saveBytes(out, state.fileName, saveAs ? null : state.fileHandle);
    if (handle === undefined) return;
    if (handle?.name) state.fileName = handle.name;
    state.fileHandle = handle || null;
    state.dirty = false;
    document.title = `${state.fileName} – PDF Pro`;
    toast(handle ? `Saved ${state.fileName}` : `Downloaded ${state.fileName}`);
  } catch (e) {
    console.error(e);
    toast(`Save failed: ${e.message}`, 'error', 6000);
  } finally {
    setBusy(null);
    updateUI();
  }
}

/** Desktop builds have no PDF plugin to print through, so print rendered page images instead. */
async function printAsImages(out) {
  const pdf = await openPdf(out);
  const urls = [];
  for (let i = 0; i < pdf.numPages; i++) {
    setStatus(`Preparing page ${i + 1} of ${pdf.numPages} for printing…`);
    const { canvas, viewport } = await renderPageToCanvas(pdf, i, 2);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    urls.push({ url: URL.createObjectURL(blob), w: viewport.width / 2, h: viewport.height / 2 });
  }
  pdf.destroy();
  const frame = h('iframe', { style: { position: 'fixed', right: 0, bottom: 0, width: '1px', height: '1px', border: 0, opacity: 0 } });
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><style>@page{margin:0}body{margin:0}img{display:block;width:100%;height:auto;page-break-after:always;break-after:page}img:last-child{page-break-after:auto;break-after:auto}</style>${urls.map((u) => `<img src="${u.url}">`).join('')}`);
  doc.close();
  await Promise.all([...doc.images].map((img) => img.decode().catch(() => {})));
  frame.contentWindow.focus();
  frame.contentWindow.print();
  setTimeout(() => { frame.remove(); urls.forEach((u) => URL.revokeObjectURL(u.url)); }, 1000);
}

async function print() {
  setBusy('Preparing print');
  try {
    const out = await app.outputBytes();
    if (window.pdfProDesktop) return await printAsImages(out);
    const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
    const frame = h('iframe', { src: url, style: { position: 'fixed', right: 0, bottom: 0, width: '1px', height: '1px', border: 0, opacity: 0 } });
    frame.onload = () => {
      setTimeout(() => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(url, '_blank'); }
      }, 300);
      setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
    };
    document.body.append(frame);
  } finally {
    setBusy(null);
  }
}

// ---------- form fields (used by annotator) ----------

app.addFormField = (page, type, name, rect) => runOp('Adding form field', (b) => E.addFormField(b, page, type, name, rect));

// ---------- tools & UI state ----------

const DRAW_TOOLS = ['text', 'highlight', 'underline', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'note', 'whiteout', 'redact', 'field-text', 'field-check', 'place'];

app.setTool = (tool, { keepPending = false } = {}) => {
  if (!keepPending) annots.pending = null;
  annots.setTool(tool);
  document.body.classList.remove('tool-select', 'tool-pan', 'tool-edittext', 'tool-draw');
  document.body.classList.add(DRAW_TOOLS.includes(tool) ? 'tool-draw' : `tool-${tool}`);
  $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
};

function selectionInViewer() {
  const sel = window.getSelection();
  return sel && !sel.isCollapsed && $('#viewer').contains(sel.anchorNode);
}

$$('#toolbar [data-tool]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tool = btn.dataset.tool;
    // With text selected, Highlight/Underline mark the selection directly.
    if ((tool === 'highlight' || tool === 'underline') && selectionInViewer()) {
      annots.markSelection(tool);
      return;
    }
    app.setTool(annots.tool === tool && tool !== 'select' ? 'select' : tool);
  });
});

$('#viewer').addEventListener('click', (e) => {
  if (annots.tool === 'edittext') annots.editTextAt(e);
});
$('#viewer').addEventListener('pointerdown', (e) => {
  if (annots.tool === 'select' && !e.target.closest('.ann, .handle')) annots.select(null);
});

app.onAnnotationsChanged = () => {
  renderComments();
  updateUI();
};

// Properties panel for the selected annotation.
app.renderProps = (a) => {
  const sec = $('#propsSection');
  const box = $('#props');
  sec.hidden = !a;
  box.replaceChildren();
  if (!a) return;
  const field = (label, input) => h('label', {}, label, input);
  const set = (patch) => annots.update(a, patch);
  box.append(h('div', { className: 'muted', style: { marginBottom: '6px' } }, `${TYPE_LABELS[a.type] || a.type} · page ${a.page + 1}`));
  if (!['image', 'whiteout', 'redact'].includes(a.type)) {
    box.append(field('Color', h('input', { type: 'color', value: a.color || '#000000', onchange: (e) => set({ color: e.target.value }) })));
  }
  if (['rect', 'ellipse', 'line', 'arrow', 'ink', 'underline'].includes(a.type)) {
    box.append(field('Width', h('input', { type: 'number', min: 0.5, max: 30, step: 0.5, value: a.width ?? 2, style: { width: '70px' }, onchange: (e) => set({ width: Number(e.target.value) }) })));
  }
  if (['rect', 'ellipse', 'text'].includes(a.type)) {
    const has = !!a.fill;
    const color = h('input', { type: 'color', value: a.fill || '#ffffff', disabled: !has, onchange: (e) => set({ fill: e.target.value }) });
    box.append(field('Fill', h('span', {}, h('input', { type: 'checkbox', checked: has, onchange: (e) => set({ fill: e.target.checked ? color.value : null }) }), ' ', color)));
  }
  if (a.type === 'whiteout') {
    box.append(field('Fill', h('input', { type: 'color', value: a.fill || '#ffffff', onchange: (e) => set({ fill: e.target.value }) })));
  }
  if (a.type === 'underline') {
    box.append(field('Strikeout', h('input', { type: 'checkbox', checked: !!a.strike, onchange: (e) => set({ strike: e.target.checked }) })));
  }
  if (a.type === 'text') {
    box.append(field('Font size', h('input', { type: 'number', min: 4, max: 200, value: a.fontSize, style: { width: '70px' }, onchange: (e) => set({ fontSize: Number(e.target.value) }) })));
  }
  if (!['whiteout', 'redact', 'note'].includes(a.type)) {
    const opacity = a.opacity ?? (a.type === 'highlight' ? 0.4 : 1);
    box.append(field('Opacity', h('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: opacity, onchange: (e) => set({ opacity: Number(e.target.value) }) })));
  }
  if (['text', 'note', 'stamp'].includes(a.type)) {
    box.append(h('textarea', { value: a.text, onchange: (e) => e.target.value && set({ text: e.target.value }) }));
  }
  box.append(h('div', { style: { display: 'flex', gap: '4px', marginTop: '6px', flexWrap: 'wrap' } },
    h('button', { onclick: () => annots.duplicate(a) }, 'Duplicate'),
    h('button', { onclick: () => annots.bringToFront(a) }, 'To front'),
    h('button', { onclick: () => annots.remove(a) }, 'Delete')));
};

function renderComments() {
  const box = $('#comments');
  box.replaceChildren();
  const list = [...annots.list].sort((a, b) => a.page - b.page || a.created - b.created);
  for (const a of list) {
    const label = TYPE_LABELS[a.type] || a.type;
    const text = a.text || '';
    box.append(h('div', {
      className: 'c',
      onclick: () => { viewer.scrollToPage(a.page); app.setTool('select'); annots.select(a.id); },
    }, h('small', {}, `${label} · page ${a.page + 1}`), text.slice(0, 140)));
  }
  // Comments already stored in the file.
  for (const p of viewer.pages) {
    for (const an of p.annotations || []) {
      const text = an.contentsObj?.str;
      if (!text || an.subtype === 'Link' || an.subtype === 'Widget') continue;
      box.append(h('div', { className: 'c', onclick: () => viewer.scrollToPage(p.index) },
        h('small', {}, `${an.subtype} · page ${p.index + 1}${an.titleObj?.str ? ` · ${an.titleObj.str}` : ''} (in file)`), text.slice(0, 200)));
    }
  }
  if (!box.children.length) box.append(h('p', { className: 'muted' }, 'No comments or markup yet. Use the Note, Highlight or drawing tools to add some.'));
}

async function renderOutline() {
  const box = $('#outline');
  box.replaceChildren();
  const outline = state.pdf ? await state.pdf.getOutline() : null;
  if (!outline?.length) {
    box.append(h('p', { className: 'muted' }, 'This document has no bookmarks.'));
    return;
  }
  const build = (items) => h('ul', {}, items.map((it) => h('li', {},
    h('a', {
      href: it.url || '#', target: it.url ? '_blank' : null,
      onclick: (e) => { if (!it.url) { e.preventDefault(); if (it.dest) viewer.goToDest(it.dest); } },
    }, it.title),
    it.items?.length ? build(it.items) : null)));
  box.append(build(outline));
}

function updateStatus() {
  if (!state.pdf) { setStatus('No document', ''); return; }
  const p = viewer.pages[viewer.current];
  const size = p ? `${(p.base.width / 72).toFixed(2)} × ${(p.base.height / 72).toFixed(2)} in` : '';
  const kb = state.bytes.length / 1024;
  setStatus(`${state.fileName}${state.dirty ? ' •' : ''} — page ${viewer.current + 1} of ${state.pdf.numPages}${size ? ` — ${size}` : ''}`,
    `${annots.list.length} annotation${annots.list.length === 1 ? '' : 's'} · ${kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`}${state.security ? ' · 🔒 protected' : ''}`);
}

function updateUI() {
  const has = !!state.pdf;
  $$('[data-needs-doc]').forEach((el) => { el.disabled = !has; });
  $('[data-cmd=undo]').disabled = !state.undo.length;
  $('[data-cmd=redo]').disabled = !state.redo.length;
  $('#pageCount').textContent = `/ ${app.pageCount}`;
  $$('#toolbar button').forEach((b) => { b.disabled = !has; });
  updateStatus();
}

// ---------- commands ----------

const sel = () => thumbs.targets(viewer.current);

const commands = {
  open: openCommand,
  newBlank: async () => {
    if (!(await confirmDiscard())) return;
    Object.assign(state, { bytes: await E.createBlank(), fileName: 'Untitled.pdf', fileHandle: null, security: null, dirty: true, undo: [], redo: [] });
    annots.restore([]);
    await reload();
  },
  save: () => save(false),
  saveAs: () => save(true),
  print,
  undo,
  redo,
  prevPage: () => viewer.scrollToPage(viewer.current - 1),
  nextPage: () => viewer.scrollToPage(viewer.current + 1),
  zoomIn: () => viewer.setZoom('in'),
  zoomOut: () => viewer.setZoom('out'),
  searchNext: () => viewer.stepMatch(1),
  searchPrev: () => viewer.stepMatch(-1),
  toggleTheme: () => {
    const dark = document.documentElement.dataset.theme !== 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('pdfpro.theme', dark ? 'dark' : 'light');
  },
  rotateLeft: () => { const t = sel(); return runOp('Rotating', (b) => E.rotatePages(b, t, -90), { flatten: t }); },
  rotateRight: () => { const t = sel(); return runOp('Rotating', (b) => E.rotatePages(b, t, 90), { flatten: t }); },
  deletePages: async () => {
    const t = sel();
    if (t.length >= app.pageCount) return toast('You cannot delete every page.', 'error');
    const { value } = await dialog({ title: 'Delete pages', body: h('p', {}, `Delete ${t.length === 1 ? `page ${t[0] + 1}` : `${t.length} pages`}?`), buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }] });
    if (!value) return;
    const set = new Set(t);
    thumbs.selected.clear();
    await runOp('Deleting pages', (b) => E.deletePages(b, t), { remap: (i) => (set.has(i) ? -1 : i - t.filter((d) => d < i).length) });
  },
  duplicatePages: () => {
    const t = sel();
    return runOp('Duplicating pages', (b) => E.duplicatePages(b, t), { remap: (i) => i + t.filter((d) => d < i).length });
  },
  insertBlank: () => {
    const at = viewer.current + 1;
    return runOp('Inserting page', (b) => E.insertBlankPage(b, at), { remap: (i) => (i >= at ? i + 1 : i) });
  },
  reversePages: () => {
    const n = app.pageCount;
    const order = Array.from({ length: n }, (_, i) => n - 1 - i);
    return runOp('Reversing pages', (b) => E.reorderPages(b, order), { remap: (i) => n - 1 - i });
  },
  extractPages: () => tools.extract(app, sel()),
  stampMenu: () => tools.stamp(app),
  signature: () => tools.signature(app),
  insertImage: () => tools.insertImage(app),
  merge: () => tools.merge(app),
  split: () => tools.split(app),
  cropPages: () => tools.crop(app, sel()),
  watermark: () => tools.watermark(app),
  headerFooter: () => tools.headerFooter(app),
  bates: () => tools.bates(app),
  applyRedactions: () => tools.applyRedactions(app),
  findRedact: () => tools.findAndRedact(app),
  flattenAnnots: () => tools.flattenAnnotations(app),
  metadata: () => tools.metadata(app),
  fillForm: () => tools.fillForm(app),
  flattenForm: () => runOp('Flattening form', (b) => E.flattenForm(b)),
  ocr: () => tools.ocr(app),
  encrypt: () => tools.encrypt(app),
  removeSecurity: () => tools.removeSecurity(app),
  compress: () => tools.compress(app),
  exportImages: () => tools.exportImages(app),
  exportText: () => tools.exportText(app),
};
app.commands = commands;

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  if (!btn || btn.disabled) return;
  commands[btn.dataset.cmd]?.();
});

$$('.tabs [data-tab]').forEach((btn) => btn.addEventListener('click', () => {
  $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
  $$('[data-tab-body]').forEach((b) => { b.hidden = b.dataset.tabBody !== btn.dataset.tab; });
}));

$('#fileInput').addEventListener('change', (e) => { openFiles([...e.target.files]); e.target.value = ''; });
$('#zoomSelect').addEventListener('change', (e) => { if (e.target.value !== 'custom') viewer.setZoom(e.target.value); });
$('#pageInput').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 1 && n <= app.pageCount) viewer.scrollToPage(n - 1);
  else e.target.value = viewer.current + 1;
});

let searchTimer;
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const { total } = await viewer.find(e.target.value.trim());
    $('#searchStatus').textContent = e.target.value.trim() ? `${total} found` : '';
  }, 250);
});
$('#searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); viewer.stepMatch(e.shiftKey ? -1 : 1); }
});

// Drag & drop files anywhere.
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  dragDepth = 0;
  document.body.classList.remove('dragging');
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (!state.bytes) return openFiles(files);
  const { value } = await dialog({
    title: 'Add files',
    body: h('p', {}, `What do you want to do with ${files.length === 1 ? `"${files[0].name}"` : `${files.length} files`}?`),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Open instead', value: 'open' }, { label: 'Append to this document', value: 'insert', primary: true }],
  });
  if (value === 'open') openFiles(files);
  if (value === 'insert') insertFiles(files);
});

// Keyboard shortcuts.
const TOOL_KEYS = { v: 'select', h: 'pan', e: 'edittext', t: 'text', d: 'ink', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', n: 'note' };
document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-back')) return;
  const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod) {
    const map = {
      o: 'open', p: 'print', z: e.shiftKey ? 'redo' : 'undo', y: 'redo', s: e.shiftKey ? 'saveAs' : 'save',
      '=': 'zoomIn', '+': 'zoomIn', '-': 'zoomOut',
    };
    if (k === 'f') { e.preventDefault(); $('#searchInput').focus(); $('#searchInput').select(); return; }
    if (k === 'h' && state.pdf) { e.preventDefault(); annots.markSelection('highlight'); return; }
    if (k === 'u' && state.pdf && selectionInViewer()) { e.preventDefault(); annots.markSelection('underline'); return; }
    if (k === '0' && state.pdf) { e.preventDefault(); viewer.setZoom('1'); return; }
    if (k === 'a' && !typing && state.pdf && document.activeElement.closest?.('#sidebar')) { e.preventDefault(); thumbs.selectAll(); return; }
    if (k === 'd' && annots.selected && !typing) { e.preventDefault(); annots.duplicate(annots.selected); return; }
    if ((k === 'z' || k === 'y') && typing) return;
    const cmd = map[k];
    if (cmd && (cmd === 'open' || state.pdf)) { e.preventDefault(); commands[cmd](); }
    return;
  }
  if (typing || !state.pdf) return;
  const selA = annots.selected;
  if ((e.key === 'Delete' || e.key === 'Backspace') && selA) { e.preventDefault(); annots.remove(selA); return; }
  if (e.key === 'Escape') { annots.select(null); app.setTool('select'); return; }
  if (selA && e.key.startsWith('Arrow')) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    app.checkpoint();
    if ('x' in selA) { selA.x += dx; selA.y += dy; }
    if ('x1' in selA) { selA.x1 += dx; selA.x2 += dx; selA.y1 += dy; selA.y2 += dy; }
    if (selA.points) selA.points = selA.points.map(([x, y]) => [x + dx, y + dy]);
    annots.renderPage(selA.page);
    return;
  }
  if (e.key === 'PageDown') { e.preventDefault(); commands.nextPage(); return; }
  if (e.key === 'PageUp') { e.preventDefault(); commands.prevPage(); return; }
  if (TOOL_KEYS[k] && !e.altKey) app.setTool(TOOL_KEYS[k]);
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty && state.bytes) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- boot ----------

const theme = localStorage.getItem('pdfpro.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = theme;
app.setTool('select');
updateUI();
renderComments();

// Allow launching with ?file=<url> (same-origin or CORS-enabled).
const fileParam = new URLSearchParams(location.search).get('file');
if (fileParam) {
  fetch(fileParam).then((r) => r.blob()).then((b) => openFiles([new File([b], fileParam.split('/').pop() || 'document.pdf', { type: 'application/pdf' })])).catch((e) => toast(`Could not load ${fileParam}: ${e.message}`, 'error'));
}

// Desktop app: receive files from "Open with" / double-click, now and later.
if (window.pdfProDesktop) {
  document.body.classList.add('desktop');
  window.pdfProDesktop.onOpenFiles(openDesktopFiles);
  window.pdfProDesktop.ready().then(openDesktopFiles);
}

window.pdfPro = app; // handy for debugging from the console
