import './styles.css';
import * as E from './lib/engine.js';
import { openPdf, renderPageToCanvas } from './lib/pdfjs.js';
import { $, $$, h, toast, setStatus, dialog, prompt, readBytes, saveBytes, baseName, desktopHandle, labelIconButtons } from './lib/ui.js';
import { Viewer } from './viewer.js';
import { Thumbnails } from './thumbnails.js';
import { Annotator, TYPE_LABELS } from './annotations.js';
import * as tools from './tools.js';
import { createIcons, Archive, ArrowDownUp, BadgeCheck, Bookmark, Check, ChevronDown, ChevronUp, Circle, CircleDot, Copy, Crop, Droplets, Eraser, FileImage, FileOutput, FilePlus, FileText, FileType, Files, FolderOpen, FormInput, GitCompare, Hand, Hash, Heading, Highlighter, ImagePlus, Info, KeyRound, Keyboard, Layers, LayoutGrid, Link, Lock, LockOpen, MessageSquare, Minimize2, Minus, Moon, MousePointer2, MoveUpRight, PanelRight, Pen, PencilLine, Plus, Printer, Redo2, RotateCcw, RotateCw, Save, ScanSearch, ScanText, Scissors, Search, Settings2, ShieldCheck, Signature, Slash, Square, SquareCheck, SquareChevronDown, SquareX, Stamp, Sun, TextCursorInput, Trash2, Type, Underline, Undo2, Unlink } from 'lucide';

const ICONS = { Archive, ArrowDownUp, BadgeCheck, Bookmark, Check, ChevronDown, ChevronUp, Circle, CircleDot, Copy, Crop, Droplets, Eraser, FileImage, FileOutput, FilePlus, FileText, FileType, Files, FolderOpen, FormInput, GitCompare, Hand, Hash, Heading, Highlighter, ImagePlus, Info, KeyRound, Keyboard, Layers, LayoutGrid, Link, Lock, LockOpen, MessageSquare, Minimize2, Minus, Moon, MousePointer2, MoveUpRight, PanelRight, Pen, PencilLine, Plus, Printer, Redo2, RotateCcw, RotateCw, Save, ScanSearch, ScanText, Scissors, Search, Settings2, ShieldCheck, Signature, Slash, Square, SquareCheck, SquareChevronDown, SquareX, Stamp, Sun, TextCursorInput, Trash2, Type, Underline, Undo2, Unlink };

const MAX_HISTORY = 40;

const MAX_HISTORY_BYTES = 400 * 1024 * 1024; // cap undo memory for large documents

/** Per-document state. Each open tab owns one; `state` always points at the active tab's. */
function makeDoc() {
  return {
    id: Math.random().toString(36).slice(2),
    bytes: null, // current unencrypted PDF bytes (annotations not yet flattened)
    pdf: null, // pdf.js document for rendering
    fileName: 'document.pdf',
    fileHandle: null,
    security: null, // {userPassword, ownerPassword, permissions} applied on save
    dirty: false,
    busy: false,
    undo: [],
    redo: [],
    annots: [], // annotation list while the tab is in the background
    view: null, // {top, left, zoomMode, scale} while in the background
    original: null, // exact bytes of a signed file as opened, kept so signatures can be verified and preserved
    signatures: [], // verification results for `original`
  };
}

let state = makeDoc();
const tabs = [state];

const app = {
  get state() { return state; },
  get pageCount() { return state.pdf?.numPages || 0; },
  get current() { return viewer.current; },
  author: () => localStorage.getItem('inkstone.author') || 'Inkstone user',
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
  const historyBytes = () => [...new Set(state.undo.map((s) => s.bytes))].reduce((n, b) => n + (b?.length || 0), 0);
  while (state.undo.length > MAX_HISTORY || (state.undo.length > 1 && historyBytes() > MAX_HISTORY_BYTES)) state.undo.shift();
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
    if (!res) continue;
    // Restore markup saved by Inkstone as editable objects.
    const { bytes, annots: saved } = await E.extractEditableAnnotations(res.bytes);
    const pages = (await E.load(bytes)).getPageCount();
    // Keep the untouched bytes of signed, unencrypted files: signatures cover the exact file.
    const original = !('security' in res) && E.hasDigitalSignature(res.bytes) ? res.bytes : null;
    out.push({ name: f.name, ...res, bytes, annots: saved, pages, original });
  }
  if (images.length) {
    const imgs = await Promise.all(images.map(async (f) => ({ bytes: await readBytes(f), type: f.type === 'image/png' ? 'image/png' : 'image/jpeg' })));
    out.push({ name: `${baseName(images[0].name)}.pdf`, bytes: await E.imagesToPdf(imgs), annots: [], pages: imgs.length });
  }
  return out;
}

/** Combine several opened files into one byte array, shifting their editable markup to match. */
async function combine(docs, base = null, at = 0) {
  let bytes = base;
  let offset = at;
  const list = [];
  for (const d of docs) {
    bytes = bytes ? await E.insertDocument(bytes, d.bytes, offset) : d.bytes;
    list.push(...d.annots.map((a) => ({ ...a, page: a.page + offset })));
    offset += d.pages;
  }
  return { bytes, annots: list, count: offset - at };
}

async function openFiles(files, handle = null) {
  if (!files.length) return;
  // A file that is already open just gets its tab focused.
  if (handle?.path) {
    const open = tabs.findIndex((t) => t.fileHandle?.path === handle.path);
    if (open >= 0) return switchTab(open);
  }
  setBusy('Opening');
  try {
    const docs = await toPdfBytes(files);
    if (!docs.length) return;
    const { bytes, annots: saved } = await combine(docs);
    // Reuse the current tab if it is empty; otherwise open a new one.
    if (state.bytes) await switchTab(tabs.push(makeDoc()) - 1);
    Object.assign(state, {
      bytes, fileName: docs.length > 1 ? 'Combined.pdf' : docs[0].name, fileHandle: docs.length === 1 && files[0].type === 'application/pdf' ? handle : null,
      security: docs[0].security || null, dirty: docs.length > 1 || !files[0].name.endsWith('.pdf'), undo: [], redo: [],
      original: docs.length === 1 ? docs[0].original : null, signatures: [],
    });
    annots.restore(saved);
    viewer.zoomMode = 'fit-width';
    await reload();
    renderTabs();
    refreshSignatures();
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
  const count = docs.reduce((n, d) => n + d.pages, 0);
  const pos = at ?? app.pageCount;
  let incoming = [];
  const ok = await runOp('Inserting pages', async (b) => {
    const res = await combine(docs, b, pos);
    incoming = res.annots;
    return res.bytes;
  }, { remap: (i) => (i >= pos ? i + count : i) });
  if (!ok) return;
  if (incoming.length) {
    annots.list.push(...incoming);
    annots.renderAll();
    app.onAnnotationsChanged();
  }
  toast(`Inserted ${count} page${count === 1 ? '' : 's'}`);
}
app.insertFiles = insertFiles;

async function confirmDiscard(doc = state) {
  if (!doc.dirty || !doc.bytes) return true;
  const { value } = await dialog({
    title: 'Unsaved changes',
    body: h('p', {}, `Discard unsaved changes to "${doc.fileName}"?`),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Discard', value: 'ok', primary: true }],
  });
  return !!value;
}

// ---------- tabs ----------

/** Make tabs[i] the active document, parking the current one in the background. */
async function switchTab(i) {
  const next = tabs[i];
  if (!next) return;
  if (next !== state) {
    state.annots = annots.snapshot();
    state.view = { top: viewer.wrap.scrollTop, left: viewer.wrap.scrollLeft, zoomMode: viewer.zoomMode, scale: viewer.scale };
    state = next;
    annots.restore(state.annots || []);
    app.renderProps(null);
    if (state.view) { viewer.zoomMode = state.view.zoomMode; viewer.scale = state.view.scale; } else viewer.zoomMode = 'fit-width';
    await viewer.setDocument(state.pdf);
    if (state.view) { viewer.wrap.scrollTop = state.view.top; viewer.wrap.scrollLeft = state.view.left; viewer.updateCurrent(true); }
    thumbs.setDocument(state.pdf);
    thumbs.setCurrent(viewer.current);
    $('#dropHint').hidden = !!state.pdf;
    $('#searchInput').value = '';
    $('#searchStatus').textContent = '';
    renderOutline();
    app.onAnnotationsChanged();
  }
  renderTabs();
  renderSignatures();
  updateUI();
}

// ---------- certificate signatures ----------

const signedAndUnchanged = () => state.original && state.bytes === state.original && !annots.list.length;

async function refreshSignatures() {
  const doc = state;
  doc.signatures = [];
  if (doc.original && window.inkstoneDesktop?.verifyPdf) {
    try { doc.signatures = await window.inkstoneDesktop.verifyPdf(doc.original); } catch (e) { console.error(e); }
  }
  if (doc === state) renderSignatures();
  if (doc.signatures.length && doc === state) {
    const bad = doc.signatures.some((s) => !s.integrity || !s.signatureValid);
    toast(bad ? 'Warning: a signature in this document is invalid. See the Signatures panel.' : `This document has ${doc.signatures.length} digital signature${doc.signatures.length === 1 ? '' : 's'}. See the Signatures panel.`, bad ? 'error' : 'info', 6000);
  }
}

function renderSignatures() {
  const box = $('#signatures');
  const btn = $('.rail [data-tab=signatures]');
  const sigs = state.signatures || [];
  btn.dataset.count = sigs.length || '';
  btn.classList.toggle('has-problem', sigs.some((s) => !s.integrity || !s.signatureValid));
  box.replaceChildren();
  if (state.original && !window.inkstoneDesktop) {
    box.append(h('p', { className: 'muted small' }, 'This document is signed. Signatures can be checked in the Inkstone desktop app.'));
    return;
  }
  if (!sigs.length) {
    box.append(h('p', { className: 'muted small' }, state.pdf
      ? 'No certificate signatures. Use "Sign with digital ID" to add one.'
      : 'Open a signed document to check its signatures.'));
    return;
  }
  if (state.original && !signedAndUnchanged()) {
    box.append(h('div', { className: 'sig-banner warn' }, 'You have unsaved changes. Saving them will invalidate these signatures.'));
  }
  for (const s of sigs) {
    const ok = s.integrity && s.signatureValid && !s.problems.length;
    const level = !ok ? 'bad' : s.trusted && s.coversWholeFile ? 'good' : 'warn';
    const headline = !ok ? 'Signature is invalid' : s.trusted ? 'Signature is valid' : 'Valid, but signer identity not verified';
    box.append(h('div', { className: `sig-item ${level}`, onclick: () => tools.signatureDetails(s) },
      h('div', { className: 'sig-status' }, headline),
      h('strong', {}, s.name || 'Unknown signer'),
      h('small', {}, s.timestamp?.matches ? `${new Date(s.timestamp.time).toLocaleString()} (trusted timestamp)` : s.signedAt ? `${new Date(s.signedAt).toLocaleString()} (signer's clock)` : 'Signing time unknown'),
      s.reason ? h('small', {}, s.reason) : null,
      !s.coversWholeFile && ok ? h('small', { className: 'muted' }, 'The document was updated after this signature (for example, by a later signature).') : null,
      !s.trusted && ok ? h('small', { className: 'muted' }, 'Self-signed or unknown certificate authority.') : null,
      !ok ? h('small', {}, s.problems.join(' ')) : null,
      h('small', { className: 'muted' }, 'Click for certificate details')));
  }
}

/** After signing, the tab shows the signed copy that was just saved. */
app.replaceWithSigned = async (signed, handle) => {
  Object.assign(state, {
    bytes: signed, original: signed, fileHandle: handle || null, fileName: handle?.name || state.fileName,
    dirty: false, undo: [], redo: [], security: null,
  });
  annots.restore([]);
  await reload({ keepPosition: true });
  renderTabs();
  await refreshSignatures();
};

async function closeTab(i) {
  const doc = tabs[i];
  if (!doc) return;
  if (doc !== state) await switchTab(i);
  if (!(await confirmDiscard(doc))) return;
  tabs.splice(i, 1);
  doc.pdf?.destroy();
  if (!tabs.length) tabs.push(makeDoc());
  // Force switchTab to load the neighbour even though `state` is the closed doc.
  state = makeDoc();
  await switchTab(Math.min(i, tabs.length - 1));
}

function renderTabs() {
  const strip = $('#tabstrip');
  strip.replaceChildren();
  for (const [i, t] of tabs.entries()) {
    if (!t.bytes && tabs.length === 1) break;
    const tab = h('div', {
      className: `tab${t === state ? ' active' : ''}${t.dirty ? ' dirty' : ''}`,
      title: t.fileHandle?.path || t.fileName,
      onclick: () => switchTab(i),
      onauxclick: (e) => { if (e.button === 1) closeTab(i); },
    },
    h('span', { className: 'tab-name' }, t.bytes ? t.fileName : 'New tab'),
    h('button', { className: 'tab-close', title: 'Close (Ctrl+W)', onclick: (e) => { e.stopPropagation(); closeTab(i); } }, '×'));
    strip.append(tab);
  }
  if (state.bytes) strip.append(h('button', { className: 'tab-new', title: 'Open another document (Ctrl+O)', onclick: () => openCommand() }, '+'));
  document.title = state.bytes ? `${state.fileName} – Inkstone` : 'Inkstone';
}

/** Files handed over by the desktop app (Open dialog, "Open with", double-click). */
function openDesktopFiles(list) {
  if (!list?.length) return;
  const files = list.map((f) => new File([f.bytes], f.name, { type: /\.pdf$/i.test(f.name) ? 'application/pdf' : /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' }));
  return openFiles(files, list.length === 1 ? desktopHandle(list[0].path) : null);
}

async function openCommand() {
  if (window.inkstoneDesktop) return openDesktopFiles(await window.inkstoneDesktop.openDialog());
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
    if (!(await tools.applyRedactions(app, { ask: false }))) return;
  }
  // Signed documents: an unchanged file is written byte-for-byte; changes would break the signatures.
  const keepSigned = !!state.original && signedAndUnchanged();
  if (state.original && !keepSigned) {
    const { value } = await dialog({
      title: 'Signed document',
      body: h('p', {}, 'This document has digital signatures. Saving your changes will invalidate them. Save anyway?'),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Save anyway', value: 'ok', primary: true }],
    });
    if (!value) return;
  }
  setBusy('Saving');
  try {
    let out;
    if (keepSigned) out = state.original;
    else {
      // Markup is drawn in for every reader, but stays editable when reopened in Inkstone.
      const withMarkup = annots.list.length ? await E.saveEditableAnnotations(state.bytes, annots.list) : state.bytes;
      out = await E.prepareForSave(withMarkup, state.security);
    }
    const handle = await saveBytes(out, state.fileName, saveAs ? null : state.fileHandle);
    if (handle === undefined) return;
    if (handle?.name) state.fileName = handle.name;
    state.fileHandle = handle || null;
    state.dirty = false;
    if (state.original && !keepSigned) {
      // The saved file was rewritten, so its old signatures no longer apply.
      state.original = null;
      state.signatures = [];
      renderSignatures();
    }
    renderTabs();
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
    if (window.inkstoneDesktop) return await printAsImages(out);
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

app.addFormField = (page, type, name, rect, extra) => runOp('Adding form field', (b) => E.addFormField(b, page, type, name, rect, extra));
app.createFromRect = (tool, page, rect) => (tool === 'link' ? tools.createLink(app, page, rect)
  : tool === 'digisign' ? tools.digitalSign(app, page, rect)
  : tools.createFormField(app, tool, page, rect));

// ---------- tools & UI state ----------

const DRAW_TOOLS = ['text', 'highlight', 'underline', 'ink', 'rect', 'ellipse', 'line', 'arrow', 'note', 'whiteout', 'redact', 'field-text', 'field-check', 'field-dropdown', 'field-radio', 'link', 'digisign', 'place'];

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
  if (annots.tool === 'edittext') tools.editText(app, e);
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

/** Bookmarks as an editable tree: [{title, page, url, children}] with 0-based page indices. */
async function readOutline(pdf) {
  const raw = pdf ? await pdf.getOutline() : null;
  const toPage = async (dest) => {
    try {
      const explicit = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
      if (!explicit) return null;
      return typeof explicit[0] === 'number' ? explicit[0] : await pdf.getPageIndex(explicit[0]);
    } catch { return null; }
  };
  const conv = (items) => Promise.all(items.map(async (it) => ({
    title: it.title, url: it.url || null, page: it.dest ? await toPage(it.dest) : null, children: it.items?.length ? await conv(it.items) : [],
  })));
  return raw ? conv(raw) : [];
}

async function renderOutline() {
  const box = $('#outline');
  const pdf = state.pdf;
  const tree = await readOutline(pdf);
  if (pdf !== state.pdf) return;
  box.replaceChildren();
  if (!pdf) return;

  const save = (label, next) => runOp(label, (b) => E.setOutline(b, next));
  const at = (path, t = tree) => path.length === 1 ? { list: t, i: path[0] } : at(path.slice(1), t[path[0]].children);
  const edit = (path, fn, label) => { const next = structuredClone(tree); const { list, i } = at(path, next); fn(list, i); return save(label, next); };
  const here = () => ({ title: `Page ${viewer.current + 1}`, page: viewer.current, url: null, children: [] });
  const askTitle = (v) => prompt('Bookmark', 'Title', v);

  box.append(h('button', {
    className: 'outline-add',
    onclick: async () => { const t = await askTitle(here().title); if (t) save('Adding bookmark', [...structuredClone(tree), { ...here(), title: t }]); },
  }, `+ Bookmark page ${viewer.current + 1}`));

  if (!tree.length) {
    box.append(h('p', { className: 'muted small' }, 'No bookmarks yet. Go to a page and add one to build a table of contents.'));
    return;
  }
  const act = (title, label, fn) => h('button', { className: 'icon sm', title, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
  const build = (items, base = []) => h('ul', {}, items.map((it, i) => {
    const path = [...base, i];
    return h('li', {},
      h('div', { className: 'outline-row' },
        h('a', {
          href: it.url || '#', target: it.url ? '_blank' : null, title: it.url || (it.page != null ? `Page ${it.page + 1}` : ''),
          onclick: (e) => { if (!it.url) { e.preventDefault(); if (it.page != null) viewer.scrollToPage(it.page); } },
        }, it.title),
        h('span', { className: 'outline-actions' },
          act('Rename', '✎', async () => { const t = await askTitle(it.title); if (t) edit(path, (l, k) => { l[k].title = t; }, 'Renaming bookmark'); }),
          act(`Add child for page ${viewer.current + 1}`, '+', async () => { const t = await askTitle(here().title); if (t) edit(path, (l, k) => { l[k].children.push({ ...here(), title: t }); }, 'Adding bookmark'); }),
          act('Move up', '↑', () => i > 0 && edit(path, (l, k) => { [l[k - 1], l[k]] = [l[k], l[k - 1]]; }, 'Moving bookmark')),
          act('Move down', '↓', () => i < items.length - 1 && edit(path, (l, k) => { [l[k + 1], l[k]] = [l[k], l[k + 1]]; }, 'Moving bookmark')),
          act('Delete', '×', () => edit(path, (l, k) => { l.splice(k, 1); }, 'Deleting bookmark')))),
      it.children?.length ? build(it.children, path) : null);
  }));
  box.append(build(tree));
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
  document.body.classList.toggle('no-doc', !has);
  renderTabs();
  renderSignatures();
  updateStatus();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Keep the desktop window's native min/max/close buttons in sync with the theme.
  const css = getComputedStyle(document.documentElement);
  window.inkstoneDesktop?.setTitleBarTheme?.({ color: css.getPropertyValue('--chrome').trim(), symbolColor: css.getPropertyValue('--text').trim() });
}

// ---------- commands ----------

const sel = () => thumbs.targets(viewer.current);

const commands = {
  open: openCommand,
  newBlank: async () => {
    if (state.bytes) await switchTab(tabs.push(makeDoc()) - 1);
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
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    localStorage.setItem('inkstone.theme', theme);
  },
  togglePanel: () => {
    // On narrow windows the panel is an overlay rather than a column.
    if (matchMedia('(max-width: 1100px)').matches) { document.body.classList.toggle('panel-open'); return; }
    document.body.classList.toggle('panel-collapsed');
    localStorage.setItem('inkstone.panel', document.body.classList.contains('panel-collapsed') ? 'hidden' : 'shown');
    if (viewer.zoomMode.startsWith('fit')) setTimeout(() => viewer.setZoom(viewer.zoomMode), 0);
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
  manageFields: () => tools.manageFields(app),
  removeLinks: () => tools.removeLinks(app, sel()),
  compare: () => tools.compare(app),
  digitalSign: () => {
    app.setTool('digisign');
    toast('Drag a box where the signature should appear');
  },
  digitalIds: () => tools.digitalIds(app),
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
  exportWord: () => tools.exportWord(app),
  pdfa: () => tools.saveAsPdfA(app),
  shortcuts: () => tools.shortcuts(),
  about: () => tools.about(),
};
app.commands = commands;

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-cmd]');
  // Overlay panels close once you pick something or click elsewhere.
  if (!e.target.closest('.panel, [data-cmd=togglePanel]')) document.body.classList.remove('panel-open');
  else if (btn && btn.closest('.panel')) document.body.classList.remove('panel-open');
  if (!e.target.closest('.sidebar, .rail')) document.body.classList.remove('sidebar-open');
  if (!btn || btn.disabled) return;
  commands[btn.dataset.cmd]?.();
});

$$('.tabs [data-tab]').forEach((btn) => btn.addEventListener('click', () => {
  if (matchMedia('(max-width: 800px)').matches) {
    // Narrow windows: the sidebar is an overlay; the rail toggles it.
    const open = !(btn.classList.contains('active') && document.body.classList.contains('sidebar-open'));
    document.body.classList.toggle('sidebar-open', open);
    $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    $$('[data-tab-body]').forEach((b) => { b.hidden = b.dataset.tabBody !== btn.dataset.tab; });
    return;
  }
  // Clicking the open tab again collapses the sidebar.
  const collapse = btn.classList.contains('active') && !document.body.classList.contains('sidebar-collapsed');
  document.body.classList.toggle('sidebar-collapsed', collapse);
  $$('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b === btn && !collapse));
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
    if (k === 'w' && state.bytes) { e.preventDefault(); closeTab(tabs.indexOf(state)); return; }
    if (e.key === 'Tab' && tabs.length > 1) { e.preventDefault(); switchTab((tabs.indexOf(state) + (e.shiftKey ? tabs.length - 1 : 1)) % tabs.length); return; }
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
  if (tabs.some((t) => t.dirty && t.bytes)) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- boot ----------

// One-time migration of settings and saved signatures from the old "PDF Pro" name.
try {
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    const nk = k.startsWith('pdfpro.') && `inkstone.${k.slice(7)}`;
    if (nk && localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k));
  }
} catch { /* storage unavailable */ }

createIcons({ icons: ICONS });
labelIconButtons();
if (window.inkstoneDesktop) document.body.classList.add('desktop');
if (localStorage.getItem('inkstone.panel') === 'hidden') document.body.classList.add('panel-collapsed');
applyTheme(localStorage.getItem('inkstone.theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
app.setTool('select');
updateUI();
renderComments();

// Allow launching with ?file=<url> (same-origin or CORS-enabled).
const fileParam = new URLSearchParams(location.search).get('file');
if (fileParam) {
  fetch(fileParam).then((r) => r.blob()).then((b) => openFiles([new File([b], fileParam.split('/').pop() || 'document.pdf', { type: 'application/pdf' })])).catch((e) => toast(`Could not load ${fileParam}: ${e.message}`, 'error'));
}

// Desktop app: receive files from "Open with" / double-click, now and later.
if (window.inkstoneDesktop) {
  window.inkstoneDesktop.onOpenFiles(openDesktopFiles);
  // Background update: show a restart button in the status bar once it's downloaded.
  window.inkstoneDesktop.onUpdateStatus?.((s) => {
    const btn = $('#updateNotice');
    if (s.state === 'ready') {
      btn.hidden = false;
      btn.textContent = `Update ${s.version} ready — restart`;
      btn.onclick = async () => { if (tabs.some((t) => t.dirty && t.bytes) && !(await confirmDiscard({ dirty: true, bytes: true, fileName: 'your open documents' }))) return; window.inkstoneDesktop.installUpdate(); };
    } else if (s.state === 'downloading') {
      btn.hidden = false;
      btn.onclick = null;
      btn.textContent = s.percent != null ? `Downloading update… ${s.percent}%` : `Downloading update ${s.version || ''}…`;
    }
  });
  window.inkstoneDesktop.ready().then(openDesktopFiles);
}

app.engine = E;
window.inkstone = app; // handy for debugging from the console
