// Dialog-driven document tools.
import JSZip from 'jszip';
import * as E from './lib/engine.js';
import { renderPageToCanvas, canvasToBytes, pageText, openPdf } from './lib/pdfjs.js';
import { h, toast, dialog, formValues, pickFiles, readBytes, prompt, downloadBlob, saveBytes, parsePageRange, baseName, setStatus, uid } from './lib/ui.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const rangeRow = (value = 'all') => `<label>Pages</label><input type="text" name="range" value="${value}" placeholder="all, or e.g. 1-3, 5, 8-">`;

function rangeValidator(app) {
  return (form, value) => {
    if (!value) return null;
    const el = form.querySelector('[name=range]');
    if (!el) return null;
    try {
      if (!parsePageRange(el.value, app.pageCount).length) return 'No pages in that range';
    } catch (e) { return e.message; }
    return null;
  };
}

function progressDialog(title) {
  const bar = h('div');
  const label = h('div', { className: 'muted' }, 'Starting…');
  const body = h('div', {}, label, h('div', { className: 'progress' }, bar));
  let cancelled = false;
  const done = dialog({ title, body, buttons: [{ label: 'Cancel', value: null }] }).then(() => { cancelled = true; });
  return {
    update(frac, text) { bar.style.width = `${Math.round(frac * 100)}%`; if (text) label.textContent = text; },
    get cancelled() { return cancelled; },
    close() { body.closest('.modal-back')?.remove(); },
    done,
  };
}

// ---------- organize ----------

export async function extract(app, pages) {
  const { value, form } = await dialog({
    title: 'Extract pages',
    body: `<div class="form-grid">${rangeRow(pages.map((p) => p + 1).join(', '))}
      <label></label><label><input type="checkbox" name="remove"> Delete pages from this document after extracting</label></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Extract', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  const idx = parsePageRange(v.range, app.pageCount);
  const out = await E.extractPages(await app.outputBytes(), idx);
  downloadBlob(out, `${baseName(app.state.fileName)}_pages.pdf`);
  if (v.remove && idx.length < app.pageCount) {
    const set = new Set(idx);
    await app.runOp('Removing extracted pages', (b) => E.deletePages(b, idx), { remap: (i) => (set.has(i) ? -1 : i - idx.filter((d) => d < i).length) });
  }
}

export async function merge(app) {
  const files = await pickFiles('application/pdf,image/png,image/jpeg', true);
  if (!files.length) return;
  const { value, form } = await dialog({
    title: 'Combine files',
    body: `<p>${files.map((f) => esc(f.name)).join('<br>')}</p>
      <div class="form-grid"><label>Insert</label><select name="pos">
        <option value="end">At the end</option><option value="start">At the beginning</option><option value="after">After the current page (${app.current + 1})</option>
      </select></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Combine', value: 'ok', primary: true }],
  });
  if (!value) return;
  const pos = formValues(form).pos;
  await app.insertFiles(files, pos === 'start' ? 0 : pos === 'after' ? app.current + 1 : app.pageCount);
}

export async function split(app) {
  const { value, form } = await dialog({
    title: 'Split document',
    body: `<div class="form-grid">
      <label><input type="radio" name="mode" value="every" checked> Every</label><span><input type="number" name="n" value="1" min="1" style="width:70px"> page(s) per file</span>
      <label><input type="radio" name="mode" value="ranges"> Ranges</label><input type="text" name="ranges" placeholder="e.g. 1-3; 4-10; 11-">
      <p class="full muted">Files are downloaded together as a .zip archive.</p></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Split', value: 'ok', primary: true }],
  });
  if (!value) return;
  const v = formValues(form);
  const total = app.pageCount;
  let groups = [];
  try {
    if (v.mode === 'every') {
      const n = Math.max(1, v.n || 1);
      for (let i = 0; i < total; i += n) groups.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
    } else {
      groups = v.ranges.split(';').map((r) => parsePageRange(r, total)).filter((g) => g.length);
    }
  } catch (e) { return toast(e.message, 'error'); }
  if (!groups.length) return toast('Nothing to split', 'error');
  const src = await app.outputBytes();
  const zip = new JSZip();
  const name = baseName(app.state.fileName);
  for (const [k, g] of groups.entries()) {
    setStatus(`Splitting… ${k + 1}/${groups.length}`);
    const label = g.length === 1 ? `${g[0] + 1}` : `${g[0] + 1}-${g[g.length - 1] + 1}`;
    zip.file(`${name}_${String(k + 1).padStart(3, '0')}_p${label}.pdf`, await E.extractPages(src, g));
  }
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${name}_split.zip`, 'application/zip');
  toast(`Split into ${groups.length} files`);
  setStatus('');
}

export async function crop(app, pages) {
  const { value, form } = await dialog({
    title: 'Crop pages',
    body: `<p class="muted">Margins to trim, in points (72 pt = 1 inch), measured on the page as displayed.</p>
      <div class="form-grid">
      <label>Top</label><input type="number" name="top" value="36" min="0">
      <label>Bottom</label><input type="number" name="bottom" value="36" min="0">
      <label>Left</label><input type="number" name="left" value="36" min="0">
      <label>Right</label><input type="number" name="right" value="36" min="0">
      ${rangeRow(pages.length === app.pageCount ? 'all' : pages.map((p) => p + 1).join(', '))}</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Crop', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  const idx = parsePageRange(v.range, app.pageCount);
  await app.runOp('Cropping', (b) => E.cropPages(b, idx, { top: v.top || 0, bottom: v.bottom || 0, left: v.left || 0, right: v.right || 0 }), { flatten: idx });
}

// ---------- stamps / signature / images ----------

const STAMPS = [
  ['APPROVED', '#15803d'], ['REJECTED', '#b91c1c'], ['DRAFT', '#1d4ed8'], ['CONFIDENTIAL', '#b91c1c'],
  ['FINAL', '#15803d'], ['FOR REVIEW', '#c2410c'], ['COMPLETED', '#15803d'], ['VOID', '#b91c1c'],
  ['NOT APPROVED', '#b91c1c'], ['FOR COMMENT', '#7c3aed'], ['SIGN HERE', '#c2410c'], ['RECEIVED', '#1d4ed8'],
];

export async function stamp(app) {
  let chosen = null;
  const grid = h('div', { className: 'stamp-grid' }, STAMPS.map(([text, color]) =>
    h('button', { style: { color, borderColor: color }, onclick: (e) => { chosen = { text, color }; e.target.closest('.modal').querySelector('.foot .primary').click(); } }, text)));
  const body = h('div', {}, grid,
    h('div', { className: 'form-grid', style: { marginTop: '12px' } },
      h('label', {}, 'Custom'), h('input', { type: 'text', name: 'custom', placeholder: 'Custom stamp text' }),
      h('label', {}, 'Color'), h('input', { type: 'color', name: 'color', value: '#b91c1c' }),
      h('label', {}, ''), h('label', {}, h('input', { type: 'checkbox', name: 'date' }), ' Append date & name')));
  const { value, form } = await dialog({ title: 'Stamp', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Use custom', value: 'ok', primary: true }] });
  if (!value) return;
  const v = formValues(form);
  if (!chosen) {
    if (!v.custom.trim()) return;
    chosen = { text: v.custom.trim().toUpperCase(), color: v.color };
  }
  let text = chosen.text;
  if (v.date) text += ` · ${app.author()} · ${new Date().toLocaleDateString()}`;
  const w = Math.max(150, Math.min(420, text.length * 13));
  app.annots.startPlacing({ kind: 'stamp', text, color: chosen.color, w, h: 46 });
}

const SIG_KEY = 'inkstone.signatures';
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } };

function trimCanvas(c, minAlpha = 24) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > minAlpha) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  if (x1 <= x0) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 8;
  out.height = y1 - y0 + 8;
  out.getContext('2d').drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/**
 * Make light paper pixels transparent so a photographed or scanned signature
 * sits cleanly on the page. Pixels lighter than `hi` vanish, darker than `lo`
 * stay opaque, with a soft ramp in between to keep edges smooth.
 */
function removeBackground(canvas, lo = 150, hi = 225) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const keep = lum <= lo ? 1 : lum >= hi ? 0 : (hi - lum) / (hi - lo);
    // Drop near-invisible paper texture so it doesn't defeat auto-cropping.
    d[i + 3] = keep < 0.2 ? 0 : Math.round(d[i + 3] * keep);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/** Load an uploaded image onto a canvas, downscaled to a sensible signature size. */
async function imageFileToCanvas(file, maxW = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, maxW / img.width);
    const c = h('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function signature(app) {
  let mode = 'draw';
  let picked = null;

  // --- Draw ---
  const pad = h('canvas', { className: 'sigpad', width: 640, height: 200 });
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 2.8;
  ctx.lineCap = ctx.lineJoin = 'round';
  let drawing = false, drawn = false;
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
  pad.addEventListener('pointerdown', (e) => { drawing = true; drawn = true; pad.setPointerCapture(e.pointerId); ctx.strokeStyle = ink.value; ctx.beginPath(); ctx.moveTo(...pos(e)); });
  pad.addEventListener('pointermove', (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
  pad.addEventListener('pointerup', () => { drawing = false; });
  const clearPad = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };

  // --- Type ---
  const typed = h('input', { type: 'text', placeholder: 'Type your name', style: { width: '100%', fontSize: '15px' } });
  const typedPreview = h('div', { style: { height: '110px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', borderRadius: '10px', border: '1px dashed var(--border)', marginTop: '10px', font: 'italic 46px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive', overflow: 'hidden', whiteSpace: 'nowrap' } });
  const syncTyped = () => { typedPreview.textContent = typed.value || ' '; typedPreview.style.color = ink.value; };
  typed.addEventListener('input', syncTyped);

  // --- Upload ---
  let uploaded = null; // original canvas
  const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/bmp', hidden: true });
  const removeBg = h('input', { type: 'checkbox', checked: true });
  const dropText = h('div', {}, h('strong', {}, 'Choose an image'), h('div', { className: 'small' }, 'PNG, JPG or a photo of your signature on white paper. You can also drop it here.'));
  const preview = h('img', { hidden: true, alt: 'Signature preview' });
  const drop = h('div', { className: 'sig-drop', onclick: () => fileInput.click() }, dropText, preview);
  const processed = () => {
    if (!uploaded) return null;
    const c = h('canvas', { width: uploaded.width, height: uploaded.height });
    c.getContext('2d').drawImage(uploaded, 0, 0);
    return removeBg.checked ? removeBackground(c) : c;
  };
  const refreshPreview = () => {
    const c = processed();
    if (!c) return;
    preview.src = (trimCanvas(c) || c).toDataURL('image/png');
    preview.hidden = false;
    dropText.hidden = true;
  };
  const takeFile = async (file) => {
    if (!file || !file.type.startsWith('image/')) return toast('Please choose an image file', 'error');
    try { uploaded = await imageFileToCanvas(file); refreshPreview(); } catch { toast('Could not read that image', 'error'); }
  };
  fileInput.addEventListener('change', () => takeFile(fileInput.files[0]));
  removeBg.addEventListener('change', refreshPreview);
  drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); drop.classList.remove('over'); takeFile(e.dataTransfer.files[0]); });

  // --- Shared ---
  const ink = h('input', { type: 'color', value: '#1a237e', oninput: syncTyped });
  const remember = h('input', { type: 'checkbox', checked: true });
  const panes = {
    draw: h('div', {}, pad, h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' } },
      h('label', { className: 'muted' }, 'Ink ', ink), h('button', { onclick: clearPad }, 'Clear'))),
    type: h('div', {}, typed, typedPreview),
    upload: h('div', {}, drop, fileInput, h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '10px' } }, removeBg, 'Remove white background')),
  };
  const tabs = h('div', { className: 'seg-tabs' }, Object.entries({ draw: 'Draw', type: 'Type', upload: 'Upload image' }).map(([k, label]) =>
    h('button', { className: k === mode ? 'active' : '', onclick: (e) => {
      mode = k;
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === e.currentTarget));
      Object.entries(panes).forEach(([pk, el]) => { el.hidden = pk !== k; });
      if (k === 'type') { syncTyped(); typed.focus(); }
    } }, label)));
  Object.entries(panes).forEach(([pk, el]) => { el.hidden = pk !== mode; });

  const sigs = loadSigs();
  const list = h('div', { className: 'sig-list' }, sigs.map((src, i) => h('span', {},
    h('img', { src, title: 'Use this signature', onclick: (e) => { picked = src; e.target.closest('.modal').querySelector('.foot .primary').click(); } }),
    h('button', { title: 'Forget this signature', onclick: (e) => { const s = loadSigs(); s.splice(i, 1); localStorage.setItem(SIG_KEY, JSON.stringify(s)); e.target.parentElement.remove(); } }, '×'))));

  const body = h('div', { style: { width: 'min(640px, 80vw)' } },
    tabs, ...Object.values(panes),
    h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '12px' } }, remember, 'Save for next time (stored only on this device)'),
    sigs.length ? h('div', { style: { marginTop: '14px' } }, h('div', { className: 'muted small' }, 'Saved signatures — click one to use it'), list) : null);

  const { value } = await dialog({ title: 'Add signature', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Place signature', value: 'ok', primary: true }] });
  if (!value) return;

  let src = picked;
  if (!src) {
    let c;
    if (mode === 'type') {
      if (!typed.value.trim()) return toast('Type your name first', 'error');
      c = h('canvas', { width: 1100, height: 240 });
      const t = c.getContext('2d');
      t.fillStyle = ink.value;
      t.font = 'italic 110px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
      t.textBaseline = 'middle';
      t.fillText(typed.value.trim(), 20, 120);
    } else if (mode === 'upload') {
      c = processed();
      if (!c) return toast('Choose an image first', 'error');
    } else {
      if (!drawn) return toast('Draw your signature first', 'error');
      c = pad;
    }
    const trimmed = trimCanvas(c);
    if (!trimmed) return toast('The signature is empty — try turning off "Remove white background"', 'error');
    src = trimmed.toDataURL('image/png');
    if (remember.checked) localStorage.setItem(SIG_KEY, JSON.stringify([src, ...loadSigs()].slice(0, 8)));
  }
  const img = await loadImage(src);
  const w = Math.min(180, img.width * 0.75);
  app.annots.startPlacing({ kind: 'image', src, w, h: (w * img.height) / img.width });
}

function loadImage(src) {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
}

export async function insertImage(app) {
  const [file] = await pickFiles('image/png,image/jpeg');
  if (!file) return;
  let src = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  const img = await loadImage(src);
  if (!/^data:image\/(png|jpeg)/.test(src)) {
    // Normalize other formats to PNG.
    const c = h('canvas', { width: img.width, height: img.height });
    c.getContext('2d').drawImage(img, 0, 0);
    src = c.toDataURL('image/png');
  }
  const w = Math.min(300, img.width * 0.75);
  app.annots.startPlacing({ kind: 'image', src, w, h: (w * img.height) / img.width });
}

// ---------- edit document ----------

export async function watermark(app) {
  const { value, form } = await dialog({
    title: 'Add watermark',
    body: `<div class="form-grid">
      <label>Text</label><input type="text" name="text" value="CONFIDENTIAL">
      <label>Font</label><select name="font"><option>Helvetica-Bold</option><option>Helvetica</option><option>Times-Roman</option><option>Courier</option></select>
      <label>Size</label><input type="number" name="fontSize" value="72" min="6" max="400">
      <label>Color</label><input type="color" name="color" value="#888888">
      <label>Opacity</label><input type="range" name="opacity" min="0.05" max="1" step="0.05" value="0.25">
      <label>Angle</label><input type="number" name="angle" value="45" min="-180" max="180">
      ${rangeRow()}</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  if (!v.text.trim()) return;
  await app.runOp('Adding watermark', (b) => E.addWatermark(b, parsePageRange(v.range, app.pageCount), v));
}

function headerFooterBody(defaults) {
  const slot = (name, label) => `<label>${label}</label><input type="text" name="${name}" value="${esc(defaults[name] || '')}">`;
  return `<p class="muted">Tokens: <code>{page}</code> <code>{total}</code> <code>{date}</code> <code>{title}</code>${defaults.bates ? ' <code>{bates}</code>' : ''}</p>
    <div class="form-grid">
    ${slot('topLeft', 'Header left')}${slot('topCenter', 'Header center')}${slot('topRight', 'Header right')}
    ${slot('bottomLeft', 'Footer left')}${slot('bottomCenter', 'Footer center')}${slot('bottomRight', 'Footer right')}
    ${defaults.bates ? `<label>Bates prefix</label><input type="text" name="batesPrefix" value="DOC">
      <label>Start number</label><input type="number" name="batesStart" value="1" min="0">
      <label>Digits</label><input type="number" name="batesDigits" value="6" min="1" max="12">` : '<label>Start numbering at</label><input type="number" name="start" value="1">'}
    <label>Font</label><select name="font"><option>Helvetica</option><option>Times-Roman</option><option>Courier</option><option>Helvetica-Bold</option></select>
    <label>Size</label><input type="number" name="fontSize" value="10" min="4" max="72">
    <label>Color</label><input type="color" name="color" value="#000000">
    <label>Margin (pt)</label><input type="number" name="margin" value="30" min="0">
    ${rangeRow()}</div>`;
}

export async function headerFooter(app) {
  const { value, form } = await dialog({
    title: 'Header, footer & page numbers',
    body: headerFooterBody({ bottomCenter: 'Page {page} of {total}' }),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  await app.runOp('Adding header/footer', (b) => E.addHeaderFooter(b, parsePageRange(v.range, app.pageCount), { ...v, fileName: app.state.fileName }));
}

export async function bates(app) {
  const { value, form } = await dialog({
    title: 'Bates numbering',
    body: headerFooterBody({ bates: true, bottomRight: '{bates}' }),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  await app.runOp('Adding Bates numbers', (b) => E.addHeaderFooter(b, parsePageRange(v.range, app.pageCount), v));
}

/** Rasterize pages with redaction marks so the covered content is truly gone. */
export async function applyRedactions(app, { ask = true } = {}) {
  const marks = app.annots.list.filter((a) => a.type === 'redact');
  if (!marks.length) { toast('Nothing to redact. Use the Redact tool or "Find & redact" to mark content first.'); return true; }
  const pages = [...new Set(marks.map((a) => a.page))].sort((a, b) => a - b);
  // Scrubbing hidden data is the safe default; when called from Save it happens without asking.
  let scrub = true;
  if (ask) {
    const box = h('input', { type: 'checkbox', checked: true });
    const { value } = await dialog({
      title: 'Apply redactions',
      body: h('div', {},
        h('p', {}, `Permanently remove ${marks.length} marked area(s) on ${pages.length} page(s)? Those pages are converted to images so the covered content can't be recovered.`),
        h('label', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } }, box,
          h('span', {}, 'Also remove hidden information', h('br'), h('span', { className: 'muted small' }, 'Document properties and XMP metadata, file attachments, scripts and automatic actions.')))),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Redact', value: 'ok', primary: true }],
    });
    if (!value) return false;
    scrub = box.checked;
  }
  const dpiScale = 2; // 144 dpi
  const ok = await app.runOp('Applying redactions', async (bytes) => {
    const pdf = await openPdf(bytes);
    const replacements = [];
    for (const i of pages) {
      const { canvas, viewport } = await renderPageToCanvas(pdf, i, dpiScale);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      for (const m of marks.filter((a) => a.page === i)) ctx.fillRect(m.x * dpiScale, m.y * dpiScale, m.w * dpiScale, m.h * dpiScale);
      replacements.push({ index: i, image: await canvasToBytes(canvas, 'image/jpeg', 0.9), png: false, vw: viewport.width / dpiScale, vh: viewport.height / dpiScale });
    }
    pdf.destroy();
    const out = await E.rasterizePages(bytes, replacements);
    return scrub ? E.scrubHiddenData(out) : out;
  });
  if (ok) {
    app.annots.list = app.annots.list.filter((a) => a.type !== 'redact');
    app.annots.renderAll();
    app.onAnnotationsChanged();
    toast(`Redacted ${marks.length} area(s) on ${pages.length} page(s). Run OCR to make the remaining text searchable again.`, 'info', 6000);
  }
  return ok;
}

/**
 * Visual-coordinate box around characters [from, to) of a pdf.js text item,
 * following the text's direction (works for rotated text too).
 */
function textBox(p, it, from, to) {
  const [a, b, c, d, e, f] = it.transform;
  const fh = Math.hypot(c, d);
  const len = it.str.length || 1;
  const ux = a / (Math.hypot(a, b) || 1), uy = b / (Math.hypot(a, b) || 1);
  const s0 = (from / len) * it.width, s1 = (to / len) * it.width;
  const corners = [[s0, -0.25 * fh], [s1, -0.25 * fh], [s1, 0.95 * fh], [s0, 0.95 * fh]].map(([sx, sy]) =>
    p.base.convertToViewportPoint(e + sx * ux - sy * uy, f + sx * uy + sy * ux));
  const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// ---------- Edit Text (real replacement) ----------

const itemGeo = (it) => {
  const [a, b, c, d, e, f] = it.transform;
  const len = Math.hypot(a, b) || 1;
  return { ux: a / len, uy: b / len, h: Math.hypot(c, d), x: e, y: f, w: it.width };
};

/** The clicked text item and its whole line (neighbouring items on the same baseline). */
function lineAt(p, items, vx, vy) {
  const hit = items.find((it) => {
    const bx = textBox(p, it, 0, it.str.length);
    return vx >= bx.x - 1 && vx <= bx.x + bx.w + 1 && vy >= bx.y - 1 && vy <= bx.y + bx.h + 1;
  });
  if (!hit) return null;
  const g0 = itemGeo(hit);
  const along = (it) => { const g = itemGeo(it); return (g.x - g0.x) * g0.ux + (g.y - g0.y) * g0.uy; };
  const across = (it) => { const g = itemGeo(it); return -(g.x - g0.x) * g0.uy + (g.y - g0.y) * g0.ux; };
  const same = items.filter((it) => {
    const g = itemGeo(it);
    return g.ux * g0.ux + g.uy * g0.uy > 0.98 && Math.abs(across(it)) < 0.35 * Math.max(g.h, g0.h);
  }).sort((a, b) => along(a) - along(b));
  // Grow outwards from the clicked item while the gaps look like word spacing, not columns.
  const gapOk = (a, b) => along(b) - (along(a) + a.width) < 1.5 * g0.h;
  let lo = same.indexOf(hit), hi = lo;
  while (lo > 0 && gapOk(same[lo - 1], same[lo])) lo--;
  while (hi < same.length - 1 && gapOk(same[hi], same[hi + 1])) hi++;
  const run = same.slice(lo, hi + 1);
  let text = '';
  run.forEach((it, k) => {
    if (k > 0) {
      const gap = along(it) - (along(run[k - 1]) + run[k - 1].width);
      if (gap > 0.2 * g0.h && !text.endsWith(' ') && !it.str.startsWith(' ')) text += ' ';
    }
    text += it.str;
  });
  const g1 = itemGeo(run[0]);
  const last = run[run.length - 1];
  return {
    text: text.trim(), fontKey: run[0].fontName,
    line: { origin: [g1.x, g1.y], dir: [g0.ux, g0.uy], height: g0.h, length: along(last) - along(run[0]) + last.width },
  };
}

/**
 * Every text line on the page along direction `dir`, in "along/across" coordinates
 * (along = reading direction, across = perpendicular, larger is higher on the page).
 */
function pageLines(items, dir, hBase) {
  const [ux, uy] = dir;
  const pts = items.filter((it) => {
    const g = itemGeo(it);
    return g.ux * ux + g.uy * uy > 0.98;
  }).map((it) => {
    const g = itemGeo(it);
    return { it, along: g.x * ux + g.y * uy, across: -g.x * uy + g.y * ux, w: g.w, h: g.h };
  }).sort((a, b) => b.across - a.across || a.along - b.along);
  const lines = [];
  for (const t of pts) {
    const line = lines.find((l) => Math.abs(l.across - t.across) < 0.35 * Math.max(l.h, t.h)
      && t.along - l.alongEnd < 1.5 * Math.max(l.h, hBase) && l.alongStart - (t.along + t.w) < 1.5 * Math.max(l.h, hBase));
    if (line) {
      line.parts.push(t);
      line.alongStart = Math.min(line.alongStart, t.along);
      line.alongEnd = Math.max(line.alongEnd, t.along + t.w);
      line.h = Math.max(line.h, t.h);
    } else lines.push({ parts: [t], across: t.across, alongStart: t.along, alongEnd: t.along + t.w, h: t.h });
  }
  for (const l of lines) {
    l.parts.sort((a, b) => a.along - b.along);
    let text = '';
    l.parts.forEach((t, k) => {
      const prev = l.parts[k - 1];
      if (prev && t.along - (prev.along + prev.w) > 0.2 * t.h && !text.endsWith(' ') && !t.it.str.startsWith(' ')) text += ' ';
      text += t.it.str;
    });
    l.text = text.trim();
    const g = itemGeo(l.parts[0].it);
    l.spec = { origin: [g.x, g.y], dir, height: l.h, length: l.alongEnd - l.alongStart };
  }
  return lines.sort((a, b) => b.across - a.across);
}

/**
 * Grow a paragraph around the clicked line: lines with the same size, a steady line
 * spacing and the same left edge (the first line may be indented).
 */
function paragraphAt(items, found) {
  const dir = found.line.dir;
  const lines = pageLines(items, dir, found.line.height);
  const [ux, uy] = dir;
  const o = found.line.origin;
  const clickAcross = -o[0] * uy + o[1] * ux, clickAlong = o[0] * ux + o[1] * uy;
  const start = lines.find((l) => Math.abs(l.across - clickAcross) < 0.35 * l.h && clickAlong >= l.alongStart - 1 && clickAlong <= l.alongEnd + 1);
  if (!start) return null;
  const h0 = start.h;
  const sameSize = (l) => Math.abs(l.h - h0) < 0.15 * h0;
  const overlaps = (a, b) => Math.min(a.alongEnd, b.alongEnd) - Math.max(a.alongStart, b.alongStart) > 0.3 * Math.min(a.alongEnd - a.alongStart, b.alongEnd - b.alongStart);
  const block = [start];
  let spacing = null, left = start.alongStart;
  // Downwards.
  for (let cur = start; ;) {
    const next = lines.filter((l) => l.across < cur.across - 0.5 * h0 && overlaps(l, cur)).sort((a, b) => b.across - a.across)[0];
    if (!next || !sameSize(next)) break;
    const gap = cur.across - next.across;
    if (gap < 0.9 * h0 || gap > 2.0 * h0 || (spacing && Math.abs(gap - spacing) > 0.2 * spacing)) break;
    if (Math.abs(next.alongStart - left) > 1.0 * h0) {
      // An indented line can only be the first line, which we've already passed going down.
      if (next.alongStart > left) break;
      if (block.length === 1 && cur.alongStart - next.alongStart < 4 * h0) left = next.alongStart; // clicked line was an indented first line
      else break;
    }
    spacing = spacing ?? gap;
    block.push(next);
    cur = next;
  }
  // Upwards (an indented line above is a first line: include it and stop).
  for (let cur = start; ;) {
    const prev = lines.filter((l) => l.across > cur.across + 0.5 * h0 && overlaps(l, cur)).sort((a, b) => a.across - b.across)[0];
    if (!prev || !sameSize(prev)) break;
    const gap = prev.across - cur.across;
    if (gap < 0.9 * h0 || gap > 2.0 * h0 || (spacing && Math.abs(gap - spacing) > 0.2 * spacing)) break;
    if (prev.alongStart < left - 1.0 * h0) break;
    spacing = spacing ?? gap;
    block.unshift(prev);
    if (prev.alongStart > left + 1.0 * h0) break;
    cur = prev;
  }
  if (block.length < 2) return null;
  left = Math.min(...block.slice(1).map((l) => l.alongStart));
  const first = block[0];
  let text = '';
  for (const l of block) {
    if (!text) text = l.text;
    else if (/[A-Za-z]-$/.test(text) && /^[a-z]/.test(l.text)) text = text.slice(0, -1) + l.text;
    else text += ` ${l.text}`;
  }
  // Alignment from where lines start and end (the last line is usually short).
  const starts = block.slice(1).map((l) => l.alongStart);
  const ends = block.slice(0, -1).map((l) => l.alongEnd);
  const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
  const centers = block.map((l) => (l.alongStart + l.alongEnd) / 2);
  const align = spread(starts) < 0.6 * h0 && spread(ends) < 0.6 * h0 && block.length >= 3 ? 'justify'
    : spread(starts) < 0.6 * h0 ? 'left' : spread(ends) < 0.6 * h0 ? 'right' : spread(centers) < 0.6 * h0 ? 'center' : 'left';
  const right = Math.max(...block.map((l) => l.alongEnd));
  const across0 = first.across;
  return {
    text, align, lineCount: block.length,
    block: {
      lines: block.map((l) => l.spec),
      origin: [left * ux - across0 * uy, left * uy + across0 * ux],
      dir, width: right - left, indent: Math.max(0, first.alongStart - left),
      lineSpacing: spacing || h0 * 1.2,
    },
  };
}

async function editParagraph(app, p, para, probe, style) {
  const size = Math.round(probe.size * 2) / 2;
  const count = h('span', { className: 'muted small' });
  const textarea = h('textarea', { name: 'text', rows: Math.min(12, Math.max(4, para.lineCount + 1)), style: { width: '100%', fontSize: '14px', lineHeight: '1.5' } }, para.text);
  const form = h('div', { style: { width: 'min(640px, 86vw)' } },
    textarea,
    h('div', { style: { display: 'flex', justifyContent: 'space-between', margin: '4px 2px 10px' } }, count, h('span', { className: 'muted small' }, 'Press Enter for a new paragraph')),
    h('div', { className: 'form-grid' },
      h('label', {}, 'Font'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
        h('select', { name: 'family' }, [['sans', 'Sans-serif (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Monospace (Courier)']].map(([v, l]) => h('option', { value: v, selected: v === style.family }, l))),
        h('label', {}, h('input', { type: 'checkbox', name: 'bold', checked: style.bold }), ' Bold'),
        h('label', {}, h('input', { type: 'checkbox', name: 'italic', checked: style.italic }), ' Italic')),
      h('label', {}, 'Size'), h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
        h('input', { type: 'number', name: 'size', value: size, min: 2, max: 200, step: 0.5, style: { width: '80px' } }),
        h('label', {}, 'Line spacing ', h('input', { type: 'number', name: 'lineSpacing', value: Math.round(para.block.lineSpacing * 10) / 10, min: 1, max: 400, step: 0.5, style: { width: '80px' } }))),
      h('label', {}, 'Align'), h('select', { name: 'align' }, [['left', 'Left'], ['justify', 'Justified'], ['center', 'Centered'], ['right', 'Right']].map(([v, l]) => h('option', { value: v, selected: v === para.align }, l))),
      h('label', {}, 'Color'), h('input', { type: 'color', name: 'color', value: probe.color }),
      h('p', { className: 'full muted small' }, `Editing a ${para.lineCount}-line paragraph. The original text is removed and your edit is re-wrapped to the same width.`)));
  const update = async () => {
    const v = formValues(form);
    const n = await E.measureParagraph(v.text, { family: v.family, bold: v.bold, italic: v.italic, size: v.size || size, width: para.block.width, indent: para.block.indent });
    count.textContent = n > para.lineCount ? `${n} lines (was ${para.lineCount}) — will extend below the original and may overlap what follows`
      : `${n} line${n === 1 ? '' : 's'} (was ${para.lineCount})`;
    count.style.color = n > para.lineCount ? 'var(--accent-text)' : '';
  };
  form.addEventListener('input', () => { clearTimeout(update.t); update.t = setTimeout(update, 150); });
  update();
  const { value } = await dialog({
    title: 'Edit paragraph', body: form,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Edit one line only', value: 'line' }, { label: 'Replace paragraph', value: 'ok', primary: true }],
  });
  if (value !== 'ok') return value;
  const v = formValues(form);
  await app.runOp('Editing paragraph', (b) => E.replaceTextBlock(b, p.index, para.block, {
    text: v.text.replace(/\r/g, ''), family: v.family, bold: v.bold, italic: v.italic, size: v.size || size, color: v.color, align: v.align, lineSpacing: v.lineSpacing,
  }));
  return 'done';
}

/**
 * Edit Text: click a line, change it, and the original text is removed from the page
 * and replaced (matching size, color and the closest standard font). Falls back to
 * covering the text when it lives somewhere Inkstone can't rewrite.
 */
export async function editText(app, e) {
  const p = app.viewer.pageFromElement(e.target);
  if (!p) return;
  const [vx, vy] = app.viewer.clientToPage(p, e.clientX, e.clientY);
  const tc = await p.page.getTextContent();
  const items = tc.items.filter((it) => it.str);
  const found = lineAt(p, items, vx, vy);
  if (!found) return toast('Click directly on a line of text to edit it');
  const probe = await E.probeTextLine(app.state.bytes, p.index, found.line);
  if (!probe.count) {
    toast('This text is inside an embedded graphic, so it will be covered and replaced instead.', 'info', 6000);
    return app.annots.editTextAt(e);
  }
  const style = E.styleFromFontName(probe.fontName || tc.styles[found.fontKey]?.fontFamily || '');
  if (!probe.fontName && /serif/i.test(tc.styles[found.fontKey]?.fontFamily || '') && !/sans/i.test(tc.styles[found.fontKey]?.fontFamily)) style.family = 'serif';
  const para = paragraphAt(items, found);
  if (para) {
    const r = await editParagraph(app, p, para, probe, style);
    if (r !== 'line') return;
  }
  const size = Math.round(probe.size * 2) / 2;
  const body = h('div', { style: { width: 'min(560px, 84vw)' } },
    h('input', { type: 'text', name: 'text', value: found.text, style: { width: '100%', fontSize: '15px' } }),
    h('div', { className: 'form-grid', style: { marginTop: '12px' } },
      h('label', {}, 'Font'), h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
        h('select', { name: 'family' }, [['sans', 'Sans-serif (Helvetica)'], ['serif', 'Serif (Times)'], ['mono', 'Monospace (Courier)']].map(([v, l]) => h('option', { value: v, selected: v === style.family }, l))),
        h('label', {}, h('input', { type: 'checkbox', name: 'bold', checked: style.bold }), ' Bold'),
        h('label', {}, h('input', { type: 'checkbox', name: 'italic', checked: style.italic }), ' Italic')),
      h('label', {}, 'Size'), h('input', { type: 'number', name: 'size', value: size, min: 2, max: 400, step: 0.5, style: { width: '90px' } }),
      h('label', {}, 'Color'), h('input', { type: 'color', name: 'color', value: probe.color }),
      h('p', { className: 'full muted small' }, `The original text${probe.fontName ? ` (${probe.fontName.replace(/^[A-Z]{6}\+/, '')})` : ''} is removed from the page and your edit is written in its place. Leave the box empty to delete the line.`)));
  const { value, form } = await dialog({ title: 'Edit text', body, buttons: [{ label: 'Cancel', value: null }, { label: 'Replace text', value: 'ok', primary: true }] });
  if (!value) return;
  const v = formValues(form);
  if (v.text === found.text && v.family === style.family && v.bold === style.bold && v.italic === style.italic && v.size === size && v.color === probe.color) return;
  await app.runOp('Editing text', (b) => E.replaceTextLine(b, p.index, found.line, { text: v.text, family: v.family, bold: v.bold, italic: v.italic, size: v.size || size, color: v.color }));
}

/** Mark every occurrence of a phrase for redaction. */
export async function findAndRedact(app) {
  const { value, form } = await dialog({
    title: 'Find & redact',
    body: `<div class="form-grid"><label>Text or pattern</label><input type="text" name="q" placeholder="e.g. John Smith">
      <label></label><label><input type="checkbox" name="regex"> Regular expression (e.g. \\d{3}-\\d{2}-\\d{4})</label>
      <label></label><label><input type="checkbox" name="cs"> Match case</label></div>
      <p class="muted">Matches are marked for redaction; review them, then use "Apply redactions".</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Mark matches', value: 'ok', primary: true }],
  });
  if (!value) return;
  const v = formValues(form);
  if (!v.q) return;
  let re;
  try {
    re = new RegExp(v.regex ? v.q : v.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), v.cs ? 'g' : 'gi');
  } catch (e) { return toast(`Bad pattern: ${e.message}`, 'error'); }
  const marks = [];
  for (const p of app.viewer.pages) {
    const tc = await p.page.getTextContent();
    for (const it of tc.items) {
      if (!it.str) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(it.str))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        marks.push({ id: uid(), type: 'redact', page: p.index, ...textBox(p, it, m.index, m.index + m[0].length), created: Date.now() });
      }
    }
  }
  if (!marks.length) return toast('No matches found');
  app.checkpoint();
  app.annots.list.push(...marks);
  app.annots.renderAll();
  app.onAnnotationsChanged();
  toast(`Marked ${marks.length} match(es) for redaction`);
}

export async function flattenAnnotations(app) {
  const list = app.annots.list.filter((a) => a.type !== 'redact');
  if (!list.length) return toast('No annotations to flatten');
  const ok = await app.runOp('Flattening annotations', (b) => E.applyAnnotations(b, list));
  if (ok) {
    app.annots.list = app.annots.list.filter((a) => a.type === 'redact');
    app.annots.renderAll();
    app.onAnnotationsChanged();
  }
}

export async function metadata(app) {
  const m = await E.getMetadata(app.state.bytes);
  const { value, form } = await dialog({
    title: 'Document properties',
    body: `<div class="form-grid">
      <label>Title</label><input type="text" name="title" value="${esc(m.title)}">
      <label>Author</label><input type="text" name="author" value="${esc(m.author)}">
      <label>Subject</label><input type="text" name="subject" value="${esc(m.subject)}">
      <label>Keywords</label><input type="text" name="keywords" value="${esc(m.keywords)}">
      <label>Creator</label><input type="text" name="creator" value="${esc(m.creator)}">
      <label>Producer</label><span class="muted">${esc(m.producer) || '—'}</span>
      <label>Created</label><span class="muted">${esc(m.created) || '—'}</span>
      <label>Modified</label><span class="muted">${esc(m.modified) || '—'}</span>
      <label>Pages</label><span class="muted">${m.pages}</span>
      <label>File size</label><span class="muted">${(app.state.bytes.length / 1024).toFixed(1)} KB</span>
      <label>Your name</label><input type="text" name="me" value="${esc(app.author())}" title="Used for comments and stamps">
      </div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }],
  });
  if (!value) return;
  const v = formValues(form);
  if (v.me.trim()) localStorage.setItem('inkstone.author', v.me.trim());
  if (['title', 'author', 'subject', 'keywords', 'creator'].some((k) => v[k] !== m[k])) await app.runOp('Updating properties', (b) => E.setMetadata(b, v));
}

// ---------- forms ----------

/** Called after dragging out a box with one of the form-field tools. */
export async function createFormField(app, tool, page, rect) {
  const type = { 'field-text': 'text', 'field-check': 'checkbox', 'field-dropdown': 'dropdown', 'field-radio': 'radio' }[tool];
  const label = { text: 'Text', checkbox: 'Check', dropdown: 'Choice', radio: 'Group' }[type];
  const existingGroups = type === 'radio' ? (await E.getFormFields(app.state.bytes)).filter((f) => f.type === 'radio') : [];
  const body = h('div', { className: 'form-grid' },
    h('label', {}, type === 'radio' ? 'Group name' : 'Field name'),
    h('input', { type: 'text', name: 'name', value: existingGroups.at(-1)?.name || `${label}${Date.now() % 10000}`, list: 'radioGroups' }),
    existingGroups.length ? h('datalist', { id: 'radioGroups' }, existingGroups.map((g) => h('option', { value: g.name }))) : null,
    type === 'radio' ? [h('label', {}, 'This choice'), h('input', { type: 'text', name: 'value', placeholder: 'e.g. Yes, Small, Option A' })] : null,
    type === 'dropdown' ? [h('label', {}, 'Choices'), h('textarea', { name: 'options', rows: 5, placeholder: 'One choice per line' })] : null,
    type === 'radio' ? h('p', { className: 'full muted small' }, 'Radio buttons with the same group name work together: only one in the group can be selected. Draw one button per choice.') : null);
  const { value, form } = await dialog({
    title: `New ${type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio button' : type === 'dropdown' ? 'dropdown' : 'text field'}`,
    body,
    validate: (f, val) => (val && !formValues(f).name.trim() ? 'Enter a name' : null),
  });
  if (!value) return;
  const v = formValues(form);
  const extra = {};
  if (type === 'dropdown') extra.options = (v.options || '').split('\n').map((s) => s.trim()).filter(Boolean);
  if (type === 'radio') extra.value = v.value?.trim();
  await app.addFormField(page, type, v.name.trim(), rect, extra);
}

/** Edit existing fields: rename, required, read-only, choices, delete. */
export async function manageFields(app) {
  const fields = (await E.getFormFields(app.state.bytes)).filter((f) => !['button', 'signature', 'unknown'].includes(f.type));
  if (!fields.length) return toast('No form fields yet. Use the field tools in the toolbar to add some.', 'info', 5000);
  const rows = fields.map((f, i) => h('tr', {},
    h('td', {}, h('input', { type: 'text', value: f.name, 'data-i': i, 'data-k': 'rename', style: { width: '100%' } })),
    h('td', { className: 'muted' }, f.type),
    h('td', {}, h('input', { type: 'checkbox', checked: !!f.required, 'data-i': i, 'data-k': 'required' })),
    h('td', {}, h('input', { type: 'checkbox', checked: !!f.readOnly, 'data-i': i, 'data-k': 'readOnly' })),
    h('td', {}, f.options && f.type !== 'radio' ? h('textarea', { rows: 2, 'data-i': i, 'data-k': 'options', style: { width: '100%' } }, f.options.join('\n')) : ''),
    h('td', {}, h('input', { type: 'checkbox', 'data-i': i, 'data-k': 'remove', title: 'Delete this field' }))));
  const body = h('table', { className: 'fields-table' },
    h('thead', {}, h('tr', {}, ['Name', 'Type', 'Required', 'Read-only', 'Choices', 'Delete'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows));
  const { value, form } = await dialog({ title: `Form fields (${fields.length})`, body, buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }] });
  if (!value) return;
  const changes = {};
  for (const el of form.querySelectorAll('[data-k]')) {
    const f = fields[+el.dataset.i];
    const c = (changes[f.name] ||= {});
    const k = el.dataset.k;
    if (k === 'rename') { if (el.value.trim() && el.value.trim() !== f.name) c.rename = el.value.trim(); }
    else if (k === 'options') { const opts = el.value.split('\n').map((s) => s.trim()).filter(Boolean); if (opts.join('\n') !== f.options.join('\n')) c.options = opts; }
    else if (k === 'remove') { if (el.checked) c.remove = true; }
    else if (el.checked !== !!f[k]) c[k] = el.checked;
  }
  for (const [n, c] of Object.entries(changes)) if (!Object.keys(c).length) delete changes[n];
  if (!Object.keys(changes).length) return;
  await app.runOp('Updating form fields', (b) => E.updateFormFields(b, changes));
}

/** Called after dragging out a box with the Link tool. */
export async function createLink(app, page, rect) {
  const { value, form } = await dialog({
    title: 'Add link',
    body: `<div class="form-grid">
      <label><input type="radio" name="kind" value="url" checked> Web address</label><input type="text" name="url" placeholder="https://example.com">
      <label><input type="radio" name="kind" value="page"> Page in this document</label><input type="number" name="page" min="1" max="${app.pageCount}" value="1">
      </div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Add link', value: 'ok', primary: true }],
    onOpen: (f) => {
      f.querySelector('[name=url]').addEventListener('focus', () => { f.querySelector('[value=url]').checked = true; });
      f.querySelector('[name=page]').addEventListener('focus', () => { f.querySelector('[value=page]').checked = true; });
    },
    validate: (f, val) => {
      if (!val) return null;
      const x = formValues(f);
      if (x.kind === 'url' && !x.url.trim()) return 'Enter a web address';
      if (x.kind === 'page' && !(x.page >= 1 && x.page <= app.pageCount)) return `Enter a page from 1 to ${app.pageCount}`;
      return null;
    },
  });
  if (!value) return;
  const v = formValues(form);
  let url = v.url.trim();
  if (v.kind === 'url' && !/^(https?:|mailto:)/i.test(url)) url = /@/.test(url) && !url.includes('/') ? `mailto:${url}` : `https://${url}`;
  await app.runOp('Adding link', (b) => E.addLink(b, page, rect, v.kind === 'url' ? { url } : { page: v.page - 1 }));
}

export async function removeLinks(app, pages) {
  const label = pages.length === 1 ? `page ${pages[0] + 1}` : `${pages.length} pages`;
  const { value } = await dialog({ title: 'Remove links', body: h('p', {}, `Remove every link on ${label}?`), buttons: [{ label: 'Cancel', value: null }, { label: 'Remove', value: 'ok', primary: true }] });
  if (value) await app.runOp('Removing links', (b) => E.removeLinks(b, pages));
}

// ---------- digital IDs & certificate signatures ----------

const desktopOnly = () => {
  if (window.inkstoneDesktop?.ids) return window.inkstoneDesktop;
  toast('Certificate signatures are available in the Inkstone desktop app.', 'info', 5000);
  return null;
};
// Errors from the desktop process arrive wrapped as "Error invoking remote method ...: Error: msg".
const cleanError = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

async function createDigitalId(desk) {
  const { value, form } = await dialog({
    title: 'Create a digital ID',
    body: `<p class="muted">Creates a personal certificate on this computer for signing documents. Recipients will see your name, but because it isn't issued by a certificate authority, their apps will show the identity as "not verified" unless they choose to trust your certificate.</p>
      <div class="form-grid">
      <label>Full name</label><input type="text" name="name" autocomplete="name">
      <label>Email</label><input type="text" name="email" autocomplete="email" placeholder="optional">
      <label>Organization</label><input type="text" name="org" placeholder="optional">
      <label>Password</label><input type="password" name="password" autocomplete="new-password" placeholder="at least 6 characters">
      <label>Confirm</label><input type="password" name="password2" autocomplete="new-password">
      <p class="full muted small">You'll need this password every time you sign. It can't be recovered, so keep it safe.</p></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create', value: 'ok', primary: true }],
    validate: (f, val) => {
      if (!val) return null;
      const v = formValues(f);
      if (!v.name.trim()) return 'Enter your name';
      if (v.password.length < 6) return 'Choose a password of at least 6 characters';
      if (v.password !== v.password2) return 'Passwords do not match';
      return null;
    },
  });
  if (!value) return null;
  const v = formValues(form);
  try {
    const id = await desk.ids.create({ name: v.name, email: v.email, org: v.org, password: v.password });
    toast(`Digital ID created for ${id.name}`);
    return id;
  } catch (e) { toast(cleanError(e), 'error', 6000); return null; }
}

async function importDigitalId(desk) {
  const [file] = await pickFiles('.pfx,.p12,application/x-pkcs12');
  if (!file) return null;
  const pw = await prompt('Import digital ID', `Password for "${file.name}"`, '', { type: 'password' });
  if (pw == null) return null;
  try {
    const id = await desk.ids.import(await readBytes(file), pw);
    toast(`Imported digital ID for ${id.name}`);
    return id;
  } catch (e) { toast(cleanError(e), 'error', 6000); return null; }
}

/** Manage digital IDs: create, import, export, delete. */
export async function digitalIds(app) {
  const desk = desktopOnly();
  if (!desk) return;
  const ids = await desk.ids.list();
  const row = (id) => h('div', { className: 'id-card' },
    h('div', {},
      h('strong', {}, id.name), id.email ? h('span', { className: 'muted' }, ` <${id.email}>`) : null,
      h('div', { className: 'muted small' },
        `${id.selfSigned ? 'Self-signed' : `Issued by ${id.issuer}`} · expires ${fmtDate(id.notAfter)}${new Date(id.notAfter) < new Date() ? ' (expired)' : ''}`)),
    h('div', { className: 'id-actions' },
      h('button', { title: 'Save a backup of this digital ID (including the private key) as a .pfx file', onclick: () => desk.ids.exportId(id.id, id.name) }, 'Back up'),
      h('button', {
        title: 'Save the public certificate to share with people who need to trust your signatures',
        onclick: async () => {
          const pw = await prompt('Export certificate', 'Digital ID password', '', { type: 'password' });
          if (pw == null) return;
          try { if (await desk.ids.exportCert(id.id, pw, id.name)) toast('Certificate saved'); } catch (e) { toast(cleanError(e), 'error'); }
        },
      }, 'Share certificate'),
      h('button', {
        className: 'danger',
        onclick: async (e) => {
          const { value } = await dialog({ title: 'Delete digital ID', body: h('p', {}, `Delete the digital ID for ${id.name}? Documents you already signed stay valid, but you won't be able to sign with it again unless you have a backup.`), buttons: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'ok', primary: true }] });
          if (!value) return;
          await desk.ids.remove(id.id);
          e.target.closest('.id-card').remove();
        },
      }, 'Delete')));
  const body = h('div', { style: { width: 'min(620px, 84vw)' } },
    ids.length ? h('div', { className: 'id-list' }, ids.map(row)) : h('p', { className: 'muted' }, 'You have no digital IDs yet. Create one, or import a .pfx/.p12 certificate from your organization or a certificate authority.'),
    h('p', { className: 'muted small' }, 'Digital IDs are stored on this computer and protected by their passwords. Private keys never leave Inkstone.'));
  const { value } = await dialog({
    title: 'Digital IDs', body,
    buttons: [{ label: 'Close', value: null }, { label: 'Import .pfx / .p12', value: 'import' }, { label: 'Create new ID', value: 'create', primary: true }],
  });
  if (value === 'create' && (await createDigitalId(desk))) return digitalIds(app);
  if (value === 'import' && (await importDigitalId(desk))) return digitalIds(app);
}

const REASONS = ['I am the author of this document', 'I approve this document', 'I have reviewed this document', 'I agree to the terms defined by this document', 'I certify the accuracy of this document'];

/** Called after dragging out the signature box with the Digital ID tool. */
export async function digitalSign(app, page, rect) {
  const desk = desktopOnly();
  if (!desk) return;
  const st = app.state;
  if (st.security) return toast('Remove password protection before adding a certificate signature.', 'error', 6000);
  if (app.annots.list.some((a) => a.type === 'redact')) return toast('Apply or remove the pending redactions before signing.', 'error', 6000);
  const alreadySigned = !!st.original && E.hasDigitalSignature(st.original);
  if (alreadySigned && (st.bytes !== st.original || app.annots.list.length)) {
    return toast('This document is already signed and has unsaved changes. Undo them before adding another signature — changing a signed document invalidates its signatures.', 'error', 8000);
  }
  let ids = await desk.ids.list();
  if (!ids.length) {
    const { value } = await dialog({ title: 'Sign with a digital ID', body: h('p', {}, 'You need a digital ID (certificate) to sign. Create one now, or import a .pfx/.p12 file.'), buttons: [{ label: 'Cancel', value: null }, { label: 'Import', value: 'import' }, { label: 'Create', value: 'create', primary: true }] });
    const made = value === 'create' ? await createDigitalId(desk) : value === 'import' ? await importDigitalId(desk) : null;
    if (!made) return;
    ids = await desk.ids.list();
  }
  const valid = ids.filter((x) => new Date(x.notAfter) > new Date());
  if (!valid.length) return toast('All your digital IDs have expired. Create or import a new one.', 'error');
  const sigs = loadSigs();
  let chosenImage = sigs[0] || null;
  const imgPicker = sigs.length ? h('div', { className: 'sig-list' }, sigs.map((src, i) => h('img', {
    src, className: i === 0 ? 'chosen' : '',
    onclick: (e) => { chosenImage = src; e.target.parentElement.querySelectorAll('img').forEach((im) => im.classList.toggle('chosen', im === e.target)); },
  }))) : null;
  const body = h('div', { className: 'form-grid', style: { width: 'min(560px, 84vw)' } },
    h('label', {}, 'Sign as'), h('select', { name: 'id' }, valid.map((x) => h('option', { value: x.id }, `${x.name}${x.email ? ` <${x.email}>` : ''}${x.selfSigned ? ' (self-signed)' : ''}`))),
    h('label', {}, 'Password'), h('input', { type: 'password', name: 'password', autocomplete: 'current-password' }),
    h('label', {}, 'Reason'), h('input', { type: 'text', name: 'reason', list: 'sigReasons', value: REASONS[1] }),
    h('datalist', { id: 'sigReasons' }, REASONS.map((r) => h('option', { value: r }))),
    h('label', {}, 'Location'), h('input', { type: 'text', name: 'location', placeholder: 'optional, e.g. Portland, OR' }),
    h('label', {}, 'Contact'), h('input', { type: 'text', name: 'contact', placeholder: 'optional' }),
    h('label', {}, 'Timestamp'), h('label', { title: 'Only a fingerprint of the signature is sent to the timestamp server — never the document.' },
      h('input', { type: 'checkbox', name: 'timestamp', checked: localStorage.getItem('inkstone.tsa') !== 'off' }),
      ' Add a trusted timestamp (contacts timestamp.digicert.com)'),
    alreadySigned
      ? h('p', { className: 'full muted small' }, 'This document is already signed, so this signature is added as an update that keeps the earlier signatures valid. It will be listed in the Signatures panel but has no visible stamp on the page.')
      : [h('label', {}, 'Appearance'), h('label', {}, h('input', { type: 'checkbox', name: 'withImage', checked: !!sigs.length, disabled: !sigs.length }), sigs.length ? ' Include my handwritten signature' : ' (save a handwritten signature with Sign to include it)'),
        imgPicker ? h('div', { className: 'full' }, imgPicker) : null],
    h('p', { className: 'full muted small' }, 'Signing saves a new copy of the document. Any later change to that copy will show as invalidating the signature.'));
  const { value, form } = await dialog({
    title: 'Sign with a digital ID', body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Sign & save…', value: 'ok', primary: true }],
    validate: (f, val) => (val && !formValues(f).password ? 'Enter your digital ID password' : null),
  });
  if (!value) return;
  const v = formValues(form);
  const id = valid.find((x) => x.id === v.id);
  setStatus('Signing…');
  try {
    let bytes, widgetRect;
    if (alreadySigned) {
      bytes = st.original;
      widgetRect = await E.pdfRectFor(bytes, page, rect);
    } else {
      const flat = await app.outputBytes();
      const now = new Date();
      const date = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      ({ bytes, widgetRect } = await E.drawSignatureAppearance(flat, page, rect, {
        name: id.name, date, reason: v.reason, location: v.location, image: v.withImage ? chosenImage : null,
      }));
    }
    try { localStorage.setItem('inkstone.tsa', v.timestamp ? 'on' : 'off'); } catch { /* storage unavailable */ }
    const result = await desk.signPdf({ bytes, id: id.id, password: v.password, reason: v.reason, location: v.location, contactInfo: v.contact, widget: { page, rect: widgetRect }, timestamp: v.timestamp });
    const signed = result.bytes;
    if (v.timestamp && !result.timestamped) toast(`Couldn't reach the timestamp server (${result.timestampError}). The signature uses your computer's clock instead.`, 'error', 8000);
    setStatus('');
    const handle = await saveBytes(signed, `${baseName(st.fileName).replace(/-signed$/, '')}-signed.pdf`);
    if (handle === undefined) return toast('Signing cancelled — nothing was saved.');
    await app.replaceWithSigned(signed, handle);
    toast(`Signed by ${id.name} and saved as ${handle?.name || 'a new file'}`, 'info', 6000);
  } catch (e) {
    setStatus('');
    toast(cleanError(e), 'error', 7000);
  }
}

/** Certificate details for one verified signature. */
export function signatureDetails(sig) {
  const c = sig.certificate || {};
  const row = (k, val) => [h('label', { className: 'muted' }, k), h('span', {}, val || '—')];
  dialog({
    title: `Signature by ${sig.name || 'unknown signer'}`,
    body: h('div', { className: 'form-grid', style: { width: 'min(560px, 84vw)' } },
      row('Signed', sig.signedAt ? new Date(sig.signedAt).toLocaleString() : 'unknown'),
      row('Timestamp', sig.timestamp?.matches
        ? `${new Date(sig.timestamp.time).toLocaleString()} — certified by ${sig.timestamp.authority || 'a timestamp authority'}`
        : sig.timestamp ? 'Present but does not match this signature' : 'None (time comes from the signer\'s computer)'),
      row('Reason', sig.reason), row('Location', sig.location), row('Contact', sig.contactInfo),
      row('Document integrity', sig.integrity ? 'Not changed since signing' : 'Altered after signing'),
      row('Covers', sig.coversWholeFile ? 'The whole current document' : 'The document as it was when signed (later changes exist)'),
      row('Certificate holder', [c.name, c.email && `<${c.email}>`, c.org].filter(Boolean).join(' ')),
      row('Issued by', c.selfSigned ? `${c.issuer} (self-signed)` : c.issuer),
      row('Valid', `${fmtDate(c.notBefore)} – ${fmtDate(c.notAfter)}`),
      row('Identity', sig.trusted ? 'Verified: chains to a trusted certificate authority' : 'Not verified: self-signed or unknown certificate authority'),
      h('label', { className: 'muted' }, 'SHA-256 fingerprint'), h('code', { style: { fontSize: '11px', wordBreak: 'break-all' } }, c.fingerprint || '—'),
      sig.problems?.length ? h('p', { className: 'full', style: { color: 'var(--accent-text)' } }, sig.problems.join(' ')) : null),
    buttons: [{ label: 'Close', value: null, primary: true }],
  });
}

// ---------- PDF/A ----------

/** Save an archival PDF/A-2b copy: preflight, fix what can be fixed, and re-check. */
export async function saveAsPdfA(app) {
  const st = app.state;
  if (app.annots.list.some((a) => a.type === 'redact')) return toast('Apply or remove the pending redactions first.', 'error');
  setStatus('Checking document…');
  const flat = await app.outputBytes();
  const pre = await E.pdfaPreflight(flat);
  setStatus('');
  const fontPages = pre.fonts.map((f) => f.page);
  const li = (t) => h('li', {}, t);
  const flattenBox = h('input', { type: 'checkbox', checked: true });
  const rasterBox = h('input', { type: 'checkbox', checked: false });
  const body = h('div', { style: { width: 'min(600px, 86vw)' } },
    h('p', {}, 'PDF/A is the ISO standard for long-term archiving. Inkstone saves a separate PDF/A-2b copy and keeps your current document as it is.'),
    h('p', { className: 'muted small', style: { margin: '0 0 4px' } }, 'Fixed automatically:'),
    h('ul', { className: 'small', style: { marginTop: 0 } },
      li('Add archival metadata and an sRGB color profile'),
      pre.scripts ? li('Remove scripts and automatic actions') : null,
      pre.attachments ? li('Remove file attachments') : null,
      pre.annotsNoAppearance ? li(`Remove ${pre.annotsNoAppearance} comment(s) that have no fixed appearance`) : null,
      app.annots.list.length ? li('Your markup is drawn into the pages') : null,
      st.security ? li('Password protection is removed (PDF/A can\'t be encrypted)') : null),
    h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, flattenBox, 'Flatten form fields (recommended)'),
    fontPages.length
      ? h('div', { className: 'sig-banner warn', style: { marginTop: '10px' } },
        h('p', { style: { margin: '0 0 6px' } }, `${fontPages.length} page(s) use fonts that aren't embedded in the file (${[...new Set(pre.fonts.flatMap((f) => f.names))].slice(0, 6).join(', ')}). PDF/A requires every font to be embedded.`),
        h('label', { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } }, rasterBox,
          h('span', {}, `Convert page${fontPages.length === 1 ? '' : 's'} ${fontPages.map((p) => p + 1).join(', ')} to images. Text on ${fontPages.length === 1 ? 'that page' : 'those pages'} won't be selectable or searchable.`)))
      : null);
  const { value } = await dialog({
    title: 'Save as PDF/A', body,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save PDF/A copy…', value: 'ok', primary: true }],
    validate: (f, val) => (val && fontPages.length && !rasterBox.checked ? 'PDF/A needs embedded fonts — tick the box to convert those pages to images, or cancel.' : null),
  });
  if (!value) return;
  try {
    setStatus('Converting to PDF/A…');
    let bytes = flat;
    if (flattenBox.checked) bytes = await E.flattenForm(bytes);
    if (fontPages.length) {
      const pdf = await openPdf(bytes);
      const reps = [];
      for (const i of fontPages) {
        const { canvas, viewport } = await renderPageToCanvas(pdf, i, 2);
        reps.push({ index: i, image: await canvasToBytes(canvas, 'image/jpeg', 0.92), png: false, vw: viewport.width / 2, vh: viewport.height / 2 });
      }
      pdf.destroy();
      bytes = await E.rasterizePages(bytes, reps);
    }
    bytes = await E.convertToPdfA(bytes);
    const check = await E.pdfaPreflight(bytes);
    setStatus('');
    const remaining = [check.fonts.length && 'non-embedded fonts', check.scripts && 'scripts', check.attachments && 'attachments', check.annotsNoAppearance && 'comments without appearance'].filter(Boolean);
    if (remaining.length) return toast(`Couldn't make a valid PDF/A copy: ${remaining.join(', ')} remain.`, 'error', 7000);
    const handle = await saveBytes(bytes, `${baseName(st.fileName)}-PDFA.pdf`);
    if (handle === undefined) return toast('Cancelled — nothing was saved.');
    toast(`Saved PDF/A-2b copy${handle?.name ? ` as ${handle.name}` : ''}. It passes Inkstone's checks; use a validator such as veraPDF for formal certification.`, 'info', 8000);
  } catch (e) {
    setStatus('');
    toast(`PDF/A conversion failed: ${e.message}`, 'error', 7000);
  }
}

// ---------- help ----------

export function shortcuts() {
  const rows = [
    ['Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+P', 'Open, save, save as, print'],
    ['Ctrl+Z / Ctrl+Y', 'Undo, redo'],
    ['Ctrl+W / Ctrl+Tab', 'Close tab, next tab (Shift for previous)'],
    ['Ctrl+F, Enter / Shift+Enter', 'Find, next / previous match'],
    ['Ctrl+H / Ctrl+U', 'Highlight / underline selected text'],
    ['Ctrl+= / Ctrl+− / Ctrl+0', 'Zoom in, out, 100%'],
    ['V H E T D R O L A N', 'Select, hand, edit text, text, draw, rectangle, ellipse, line, arrow, note'],
    ['Delete, arrow keys, Ctrl+D', 'Delete, nudge (Shift = 10pt), duplicate the selection'],
    ['Shift while drawing', 'Square/circle or 45° lines'],
    ['Page Up / Page Down', 'Previous / next page'],
    ['Esc', 'Close dialog, back to Select'],
  ];
  dialog({
    title: 'Keyboard shortcuts',
    body: h('table', { className: 'fields-table' }, h('tbody', {}, rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))),
    buttons: [{ label: 'Close', value: null, primary: true }],
  });
}

export async function about() {
  const desk = window.inkstoneDesktop;
  const info = desk?.appInfo ? await desk.appInfo() : null;
  const status = h('p', { className: 'muted small' });
  const checkBtn = desk?.checkUpdates ? h('button', {
    onclick: async () => {
      checkBtn.disabled = true;
      status.textContent = 'Checking for updates…';
      const r = await desk.checkUpdates();
      checkBtn.disabled = false;
      status.textContent = {
        current: `You're up to date (version ${r.version}).`,
        downloading: `Version ${r.version} is available and downloading. You'll be asked to restart when it's ready.`,
        unavailable: r.reason === 'portable' ? 'The portable edition doesn\'t update itself. Download the latest version to update.' : 'Updates are only available in the installed app.',
        'not-configured': 'This build has no update feed configured yet.',
        error: `Couldn't check for updates: ${r.message}`,
      }[r.state] || '';
    },
  }, 'Check for updates') : null;
  dialog({
    title: 'About Inkstone',
    body: h('div', { style: { width: 'min(460px, 84vw)', textAlign: 'center' } },
      h('img', { src: 'data:image/svg+xml,' + encodeURIComponent(document.querySelector('.logo svg').outerHTML.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')), width: 64, height: 64, alt: '' }),
      h('h3', { style: { margin: '8px 0 2px' } }, 'Inkstone'),
      h('p', { className: 'muted', style: { margin: 0 } }, info ? `Version ${info.version}${info.portable ? ' (portable)' : ''}` : 'Web version'),
      h('p', {}, 'A free, open source PDF editor. Your files stay on your computer.'),
      h('p', { className: 'muted small' }, 'MIT license. Built with pdf.js, pdf-lib, Tesseract.js, signpdf, node-forge, docx and Lucide icons.'),
      info ? h('p', { className: 'muted small' }, `Electron ${info.electron} · Chromium ${info.chrome}`) : null,
      checkBtn, status),
    buttons: [{ label: 'Close', value: null, primary: true }],
  });
}

// ---------- compare ----------

/** Words of one page with the text item and character range each came from. */
async function pageWords(page) {
  const tc = await page.getTextContent();
  const out = [];
  tc.items.forEach((it, idx) => {
    if (!it.str) return;
    for (const m of it.str.matchAll(/\S+/g)) out.push({ w: m[0], item: it, idx, from: m.index, to: m.index + m[0].length });
  });
  return out;
}

/** Word-level LCS diff. Returns ops: {t:'=',a,b} | {t:'-',a} | {t:'+',b}. */
function diffWords(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 9e6) {
    // Too large for a table: fall back to treating the page as wholly changed.
    return [...a.map((x) => ({ t: '-', a: x })), ...b.map((x) => ({ t: '+', b: x }))];
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i * W + j] = a[i].w === b[j].w ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].w === b[j].w) { ops.push({ t: '=', a: a[i++], b: b[j++] }); }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) ops.push({ t: '-', a: a[i++] });
    else ops.push({ t: '+', b: b[j++] });
  }
  while (i < n) ops.push({ t: '-', a: a[i++] });
  while (j < m) ops.push({ t: '+', b: b[j++] });
  return ops;
}

/** Compare the open document against an older version, report differences and optionally mark them. */
export async function compare(app) {
  const [file] = await pickFiles('application/pdf');
  if (!file) return;
  setStatus('Comparing…');
  let older;
  try {
    older = await openPdf(await readBytes(file));
  } catch (e) {
    setStatus('');
    return toast(`Could not open ${file.name}: ${e.message}`, 'error');
  }
  const cur = app.viewer.pages;
  const pages = Math.max(cur.length, older.numPages);
  const results = [];
  for (let i = 0; i < pages; i++) {
    setStatus(`Comparing page ${i + 1} of ${pages}…`);
    const a = i < older.numPages ? await pageWords(await older.getPage(i + 1)) : [];
    const b = cur[i] ? await pageWords(cur[i].page) : [];
    const ops = diffWords(a, b);
    const added = ops.filter((o) => o.t === '+').length, removed = ops.filter((o) => o.t === '-').length;
    results.push({ page: i, ops, added, removed, onlyOld: i >= cur.length, onlyNew: i >= older.numPages });
  }
  older.destroy();
  setStatus('');

  const changed = results.filter((r) => r.added || r.removed);
  const totals = changed.reduce((t, r) => ({ added: t.added + r.added, removed: t.removed + r.removed }), { added: 0, removed: 0 });
  const render = (r) => {
    const frag = h('div', { className: 'diff-text' });
    // Collapse long unchanged runs to a few words of context.
    let run = [];
    const flush = () => {
      if (run.length > 16) frag.append(`${run.slice(0, 6).join(' ')} … ${run.slice(-6).join(' ')} `);
      else if (run.length) frag.append(`${run.join(' ')} `);
      run = [];
    };
    for (const o of r.ops) {
      if (o.t === '=') { run.push(o.b.w); continue; }
      flush();
      frag.append(h(o.t === '+' ? 'ins' : 'del', {}, o.t === '+' ? o.b.w : o.a.w), ' ');
    }
    flush();
    return frag;
  };
  const markBox = h('input', { type: 'checkbox', checked: true });
  const body = h('div', { style: { width: 'min(680px, 86vw)' } },
    h('p', {}, changed.length
      ? `Compared with "${file.name}": ${changed.length} page(s) differ — ${totals.added} word(s) added or changed, ${totals.removed} removed.`
      : `No text differences found compared with "${file.name}".`),
    changed.length ? h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', marginBottom: '10px' } }, markBox, 'Highlight added and changed words in this document (green)') : null,
    ...changed.map((r) => h('details', { className: 'diff-page', open: changed.length <= 3 },
      h('summary', {}, `Page ${r.page + 1}`, r.onlyOld ? ' (removed page)' : r.onlyNew ? ' (new page)' : '', h('span', { className: 'muted' }, `  +${r.added} −${r.removed}`)),
      render(r))),
    h('p', { className: 'muted small' }, 'Compares the text of each page with the same page in the other file. Formatting and image changes are not detected.'));
  const { value } = await dialog({ title: 'Compare documents', body, buttons: [{ label: 'Close', value: null }, ...(changed.length ? [{ label: 'Done', value: 'ok', primary: true }] : [])] });
  if (!value || !markBox.checked) return;
  const marks = [];
  for (const r of changed) {
    const p = cur[r.page];
    if (!p) continue;
    for (const o of r.ops) if (o.t === '+') marks.push({ id: uid(), type: 'highlight', page: r.page, ...textBox(p, o.b.item, o.b.from, o.b.to), color: '#22c55e', opacity: 0.35, created: Date.now() });
  }
  if (!marks.length) return;
  app.checkpoint();
  app.annots.list.push(...marks);
  app.annots.renderAll();
  app.onAnnotationsChanged();
  toast(`Highlighted ${marks.length} changed word(s). Undo removes them all.`);
}

export async function fillForm(app) {
  const fields = await E.getFormFields(app.state.bytes);
  if (!fields.length) {
    toast('This document has no form fields. Use the Field and Checkbox tools in the toolbar to create some.', 'info', 5000);
    return;
  }
  const rows = fields.filter((f) => !['button', 'signature', 'unknown'].includes(f.type)).map((f) => {
    const n = esc(f.name);
    let input;
    if (f.type === 'checkbox') input = `<input type="checkbox" name="${n}" ${f.value ? 'checked' : ''}>`;
    else if (f.options) input = `<select name="${n}"><option value=""></option>${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.multiline) input = `<textarea name="${n}" rows="3">${esc(f.value)}</textarea>`;
    else input = `<input type="text" name="${n}" value="${esc(f.value)}">`;
    return `<label title="${n}">${n}${f.readOnly ? ' 🔒' : ''}</label>${input}`;
  });
  const { value, form } = await dialog({
    title: `Fill form (${fields.length} fields)`,
    body: `<div class="form-grid">${rows.join('')}</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply & flatten', value: 'flatten' }, { label: 'Apply', value: 'ok', primary: true }],
  });
  if (!value) return;
  const v = formValues(form);
  await app.runOp('Filling form', async (b) => {
    const filled = await E.setFormFields(b, v);
    return value === 'flatten' ? E.flattenForm(filled) : filled;
  });
}

// ---------- OCR ----------

export async function ocr(app) {
  const { value, form } = await dialog({
    title: 'Recognize text (OCR)',
    body: `<p class="muted">Adds an invisible, searchable and selectable text layer to scanned pages. Runs entirely on your computer. English works offline; other languages download their data (a few MB) the first time.</p>
      <div class="form-grid">${rangeRow()}
      <label>Language</label><select name="lang">
        <option value="eng">English</option><option value="spa">Spanish</option><option value="fra">French</option><option value="deu">German</option>
        <option value="ita">Italian</option><option value="por">Portuguese</option><option value="nld">Dutch</option><option value="pol">Polish</option>
        <option value="rus">Russian</option><option value="chi_sim">Chinese (simplified)</option><option value="jpn">Japanese</option><option value="kor">Korean</option>
      </select>
      <label>Resolution</label><select name="scale"><option value="2">Standard (144 dpi)</option><option value="3">High (216 dpi)</option></select>
      <label></label><label><input type="checkbox" name="skip" checked> Skip pages that already contain text</label></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Start OCR', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  const idx = parsePageRange(v.range, app.pageCount);
  const prog = progressDialog('Recognizing text');
  let worker;
  try {
    prog.update(0, 'Loading OCR engine…');
    const { createWorker } = await import('tesseract.js');
    // The engine and English data ship with the app; other languages download on first use.
    const local = (p) => new URL(`ocr/${p}`, document.baseURI).href;
    worker = await createWorker(v.lang, 1, {
      workerPath: local('worker.min.js'),
      corePath: local('core'),
      workerBlobURL: false,
      ...(v.lang === 'eng' ? { langPath: local('lang') } : {}),
    });
    const scale = Number(v.scale);
    const results = [];
    for (const [k, i] of idx.entries()) {
      if (prog.cancelled) break;
      if (v.skip && (await pageText(app.state.pdf, i)).trim().length > 20) continue;
      prog.update(k / idx.length, `Page ${i + 1} (${k + 1} of ${idx.length})…`);
      const { canvas } = await renderPageToCanvas(app.state.pdf, i, scale);
      const { data } = await worker.recognize(canvas);
      const words = (data.words || [])
        .filter((w) => w.text?.trim() && w.confidence > 30)
        .map((w) => ({ text: w.text, x: w.bbox.x0 / scale, y: w.bbox.y0 / scale, w: (w.bbox.x1 - w.bbox.x0) / scale, h: (w.bbox.y1 - w.bbox.y0) / scale }));
      if (words.length) results.push({ index: i, words });
    }
    prog.close();
    if (prog.cancelled && !results.length) return;
    if (!results.length) return toast('No new text recognized (pages may already contain text).');
    await app.runOp('Adding text layer', (b) => E.addInvisibleText(b, results));
    toast(`OCR complete: ${results.reduce((n, r) => n + r.words.length, 0)} words on ${results.length} page(s)`);
  } catch (e) {
    prog.close();
    console.error(e);
    toast(`OCR failed: ${e.message || e}. Languages other than English need an internet connection the first time.`, 'error', 7000);
  } finally {
    worker?.terminate();
  }
}

// ---------- protect ----------

export async function encrypt(app) {
  const { value, form } = await dialog({
    title: 'Encrypt with password',
    body: `<p class="muted">AES-256 encryption is applied when you save.</p>
      <div class="form-grid">
      <label>Open password</label><input type="password" name="user" autocomplete="new-password">
      <label>Confirm</label><input type="password" name="user2" autocomplete="new-password">
      <label>Permissions password</label><input type="password" name="owner" autocomplete="new-password" placeholder="optional, restricts editing">
      <label>Allow</label><div>
        <label><input type="checkbox" name="printing" checked> Printing</label><br>
        <label><input type="checkbox" name="copying" checked> Copying text &amp; images</label><br>
        <label><input type="checkbox" name="modifying"> Editing</label><br>
        <label><input type="checkbox" name="annotating" checked> Commenting</label><br>
        <label><input type="checkbox" name="fillingForms" checked> Filling forms</label><br>
        <label><input type="checkbox" name="documentAssembly"> Page assembly</label>
      </div></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', value: 'ok', primary: true }],
    validate: (f, val) => {
      if (!val) return null;
      const x = formValues(f);
      if (!x.user && !x.owner) return 'Enter at least one password';
      if (x.user !== x.user2) return 'Passwords do not match';
      return null;
    },
  });
  if (!value) return;
  const v = formValues(form);
  app.checkpoint();
  app.state.security = {
    userPassword: v.user,
    ownerPassword: v.owner || v.user || undefined,
    permissions: {
      printing: v.printing ? 'highResolution' : false, copying: v.copying, modifying: v.modifying, annotating: v.annotating,
      fillingForms: v.fillingForms, documentAssembly: v.documentAssembly, contentAccessibility: true,
    },
  };
  toast('Encryption will be applied when you save.');
}

export async function removeSecurity(app) {
  if (!app.state.security) return toast('This document is not protected.');
  app.checkpoint();
  app.state.security = null;
  toast('Security removed. Save to write an unprotected copy.');
}

// ---------- optimize & export ----------

export async function compress(app) {
  const before = (await app.outputBytes()).length;
  const { value, form } = await dialog({
    title: 'Compress / optimize',
    body: `<div class="form-grid">
      <label><input type="radio" name="mode" value="lossless" checked> Lossless</label><span class="muted">Remove unused objects and pack the file structure.</span>
      <label><input type="radio" name="mode" value="raster"> Strong (lossy)</label><span class="muted">Convert pages to JPEG images. Text becomes non-selectable unless you run OCR afterwards. Best for scans.</span>
      <label>Resolution</label><select name="dpi"><option value="1">72 dpi (smallest)</option><option value="1.5" selected>108 dpi</option><option value="2">144 dpi</option><option value="3">216 dpi</option></select>
      <label>JPEG quality</label><input type="range" name="q" min="0.3" max="0.95" step="0.05" value="0.7">
      <p class="full muted">Current size: ${(before / 1024).toFixed(1)} KB</p></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Compress', value: 'ok', primary: true }],
  });
  if (!value) return;
  const v = formValues(form);
  const ok = await app.runOp('Compressing', async (bytes) => {
    if (v.mode === 'lossless') return E.finalize(await E.load(bytes));
    const flat = await app.outputBytes();
    const pdf = await openPdf(flat);
    const reps = [];
    for (let i = 0; i < pdf.numPages; i++) {
      setStatus(`Compressing page ${i + 1} of ${pdf.numPages}…`);
      const { canvas, viewport } = await renderPageToCanvas(pdf, i, Number(v.dpi));
      reps.push({ index: i, image: await canvasToBytes(canvas, 'image/jpeg', v.q), png: false, vw: viewport.width / Number(v.dpi), vh: viewport.height / Number(v.dpi) });
    }
    pdf.destroy();
    return E.rasterizePages(flat, reps);
  });
  if (ok) {
    if (v.mode !== 'lossless') { app.annots.list = []; app.annots.renderAll(); app.onAnnotationsChanged(); }
    const after = app.state.bytes.length;
    toast(`Size: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB (${Math.round((1 - after / before) * 100)}% smaller)`, 'info', 6000);
  }
}

export async function exportImages(app) {
  const { value, form } = await dialog({
    title: 'Export pages as images',
    body: `<div class="form-grid">
      <label>Format</label><select name="fmt"><option value="png">PNG</option><option value="jpeg">JPEG</option></select>
      <label>Resolution</label><select name="dpi"><option value="1">72 dpi</option><option value="2" selected>144 dpi</option><option value="4.1667">300 dpi</option></select>
      ${rangeRow()}</div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Export', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  const idx = parsePageRange(v.range, app.pageCount);
  const pdf = await openPdf(await app.outputBytes());
  const name = baseName(app.state.fileName);
  const ext = v.fmt === 'png' ? 'png' : 'jpg';
  const files = [];
  for (const [k, i] of idx.entries()) {
    setStatus(`Exporting page ${k + 1} of ${idx.length}…`);
    const { canvas } = await renderPageToCanvas(pdf, i, Number(v.dpi));
    files.push({ name: `${name}_p${String(i + 1).padStart(3, '0')}.${ext}`, data: await canvasToBytes(canvas, `image/${v.fmt}`, 0.92) });
  }
  pdf.destroy();
  setStatus('');
  if (files.length === 1) return downloadBlob(files[0].data, files[0].name, `image/${v.fmt}`);
  const zip = new JSZip();
  files.forEach((f) => zip.file(f.name, f.data));
  downloadBlob(await zip.generateAsync({ type: 'blob' }), `${name}_images.zip`, 'application/zip');
}

/**
 * Export to Word: rebuild paragraphs from the PDF's text (lines joined, headings and
 * bold/italic detected), with page images for scanned pages that have no text.
 */
export async function exportWord(app) {
  const { value, form } = await dialog({
    title: 'Export to Word',
    body: `<p class="muted">Creates an editable .docx from the document's text. Simple documents convert well; complex layouts, tables and columns come out approximate.</p>
      <div class="form-grid">${rangeRow()}
      <label></label><label><input type="checkbox" name="images" checked> Include scanned pages as images</label>
      <label></label><label><input type="checkbox" name="keepLines"> Keep the PDF's line breaks (don't reflow paragraphs)</label></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Export', value: 'ok', primary: true }],
    validate: rangeValidator(app),
  });
  if (!value) return;
  const v = formValues(form);
  const idx = parsePageRange(v.range, app.pageCount);
  const D = await import('docx');
  const pdf = await openPdf(await app.outputBytes());
  const sections = [];
  try {
    for (const [n, i] of idx.entries()) {
      setStatus(`Converting page ${n + 1} of ${idx.length}…`);
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      // Rendering loads the fonts (so their real names reveal bold/italic) and gives a page image for scans.
      const { canvas } = await renderPageToCanvas(pdf, i, 1.5);
      const tc = await page.getTextContent();
      const fontStyle = (key) => {
        let name = '';
        try { name = page.commonObjs.get(key)?.name || ''; } catch { /* not loaded */ }
        const st = E.styleFromFontName(name || tc.styles[key]?.fontFamily || '');
        if (!name && /serif/i.test(tc.styles[key]?.fontFamily || '') && !/sans/i.test(tc.styles[key]?.fontFamily)) st.family = 'serif';
        return st;
      };
      // Collect items in visual (top-left) coordinates, grouped into lines.
      const items = tc.items.filter((it) => it.str?.trim()).map((it) => {
        const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
        return { it, x, y, h: Math.hypot(it.transform[2], it.transform[3]), w: it.width, st: fontStyle(it.fontName) };
      }).sort((a, b) => a.y - b.y || a.x - b.x);
      const lines = [];
      for (const t of items) {
        const line = lines.find((l) => Math.abs(l.y - t.y) < Math.max(l.h, t.h) * 0.4);
        if (line) { line.parts.push(t); line.h = Math.max(line.h, t.h); } else lines.push({ y: t.y, h: t.h, parts: [t] });
      }
      lines.forEach((l) => { l.parts.sort((a, b) => a.x - b.x); l.x = l.parts[0].x; });
      lines.sort((a, b) => a.y - b.y);
      const sizes = lines.map((l) => l.h).sort((a, b) => a - b);
      const body = sizes[Math.floor(sizes.length / 2)] || 11;
      const children = [];
      const runsFor = (line) => line.parts.flatMap((t, k) => {
        const prev = line.parts[k - 1];
        const gap = prev ? t.x - (prev.x + prev.w) : 0;
        const text = (prev && gap > t.h * 0.2 && !prev.it.str.endsWith(' ') && !t.it.str.startsWith(' ') ? ' ' : '') + t.it.str;
        return [{ text, bold: t.st.bold, italics: t.st.italic, size: Math.round(t.h * 2), font: t.st.family === 'serif' ? 'Times New Roman' : t.st.family === 'mono' ? 'Courier New' : 'Arial' }];
      });
      // Merge lines into paragraphs unless there's a larger gap, an indent change or a size change.
      let para = null;
      const flush = () => {
        if (!para) return;
        const heading = para.h >= body * 1.6 ? D.HeadingLevel.HEADING_1 : para.h >= body * 1.25 ? D.HeadingLevel.HEADING_2 : undefined;
        children.push(new D.Paragraph({
          heading,
          spacing: { after: Math.round(body * 6) },
          children: para.runs.map((r) => (r.br ? new D.TextRun({ break: 1 }) : new D.TextRun({ text: r.text, bold: r.bold || undefined, italics: r.italics || undefined, size: heading ? undefined : r.size, font: heading ? undefined : r.font }))),
        }));
        para = null;
      };
      lines.forEach((line, k) => {
        const prev = lines[k - 1];
        const newPara = !para || !prev || line.y - prev.y > Math.max(line.h, prev.h) * 1.65 || Math.abs(line.h - prev.h) > body * 0.2 || Math.abs(line.x - prev.x) > body * 1.5;
        if (newPara) { flush(); para = { h: line.h, runs: [] }; }
        else if (v.keepLines) para.runs.push({ br: true });
        else {
          // Reflow: join with a space, or remove a hyphen that splits a word across lines.
          const lastRun = para.runs[para.runs.length - 1];
          if (lastRun && /[A-Za-z]-$/.test(lastRun.text)) lastRun.text = lastRun.text.slice(0, -1);
          else if (lastRun && !lastRun.text.endsWith(' ')) lastRun.text += ' ';
        }
        para.runs.push(...runsFor(line));
      });
      flush();
      const textChars = items.reduce((c, t) => c + t.it.str.length, 0);
      if (v.images && textChars < 20) {
        const png = await canvasToBytes(canvas, 'image/png');
        const maxW = 600; // pixels at 96 dpi, about the printable width of a page
        const w = Math.min(maxW, vp.width * (96 / 72)), hgt = w * (vp.height / vp.width);
        children.push(new D.Paragraph({ children: [new D.ImageRun({ type: 'png', data: png, transformation: { width: w, height: hgt } })] }));
      }
      if (!children.length) children.push(new D.Paragraph({ children: [] }));
      const twips = (pt) => Math.round(pt * 20);
      sections.push({
        properties: { page: { size: { width: twips(vp.width), height: twips(vp.height) }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
        children,
      });
    }
  } finally {
    pdf.destroy();
    setStatus('');
  }
  const doc = new D.Document({ creator: 'Inkstone', title: baseName(app.state.fileName), sections });
  const blob = await D.Packer.toBlob(doc);
  downloadBlob(blob, `${baseName(app.state.fileName)}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  toast('Word document created');
}

export async function exportText(app) {
  const parts = [];
  for (let i = 0; i < app.pageCount; i++) parts.push(`--- Page ${i + 1} ---\n${await pageText(app.state.pdf, i)}`);
  downloadBlob(parts.join('\n\n'), `${baseName(app.state.fileName)}.txt`, 'text/plain;charset=utf-8');
}
