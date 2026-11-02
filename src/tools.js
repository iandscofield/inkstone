// Dialog-driven document tools.
import JSZip from 'jszip';
import * as E from './lib/engine.js';
import { renderPageToCanvas, canvasToBytes, pageText, openPdf } from './lib/pdfjs.js';
import { h, toast, dialog, formValues, pickFiles, downloadBlob, parsePageRange, baseName, setStatus, uid } from './lib/ui.js';

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

const SIG_KEY = 'pdfpro.signatures';
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY)) || []; } catch { return []; } };

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] > 10) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  if (x1 <= x0) return null;
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 8;
  out.height = y1 - y0 + 8;
  out.getContext('2d').drawImage(c, x0 - 4, y0 - 4, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export async function signature(app) {
  const pad = h('canvas', { className: 'sigpad', width: 560, height: 180 });
  const ctx = pad.getContext('2d');
  ctx.lineWidth = 2.6;
  ctx.lineCap = ctx.lineJoin = 'round';
  let drawing = false, drawn = false;
  const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * (pad.width / r.width), (e.clientY - r.top) * (pad.height / r.height)]; };
  pad.addEventListener('pointerdown', (e) => { drawing = true; drawn = true; pad.setPointerCapture(e.pointerId); ctx.strokeStyle = form.querySelector('[name=ink]').value; ctx.beginPath(); ctx.moveTo(...pos(e)); });
  pad.addEventListener('pointermove', (e) => { if (drawing) { ctx.lineTo(...pos(e)); ctx.stroke(); } });
  pad.addEventListener('pointerup', () => { drawing = false; });

  let picked = null;
  const sigs = loadSigs();
  const list = h('div', { className: 'sig-list' }, sigs.map((src, i) => h('span', {},
    h('img', { src, title: 'Use this signature', onclick: (e) => { picked = src; e.target.closest('.modal').querySelector('.foot .primary').click(); } }),
    h('button', { title: 'Forget', onclick: (e) => { const s = loadSigs(); s.splice(i, 1); localStorage.setItem(SIG_KEY, JSON.stringify(s)); e.target.parentElement.remove(); } }, '×'))));
  const form = h('div', {},
    h('p', { className: 'muted' }, 'Draw your signature, or type it below. Signatures are stored only in this browser.'),
    pad,
    h('div', { className: 'form-grid', style: { marginTop: '10px' } },
      h('label', {}, 'Or type'), h('input', { type: 'text', name: 'typed', placeholder: 'Your name' }),
      h('label', {}, 'Ink'), h('input', { type: 'color', name: 'ink', value: '#1a237e' }),
      h('label', {}, ''), h('label', {}, h('input', { type: 'checkbox', name: 'remember', checked: true }), ' Remember this signature')),
    sigs.length ? h('div', {}, h('h4', { style: { margin: '12px 0 0' } }, 'Saved signatures'), list) : null);

  const { value } = await dialog({
    title: 'Fill & Sign',
    body: form,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Clear pad', value: 'clear' }, { label: 'Place signature', value: 'ok', primary: true }],
    onOpen: () => {},
  });
  if (value === 'clear') return signature(app);
  if (!value) return;
  let src = picked;
  if (!src) {
    const v = formValues(form);
    let c;
    if (v.typed.trim()) {
      c = document.createElement('canvas');
      c.width = 900; c.height = 220;
      const t = c.getContext('2d');
      t.fillStyle = v.ink;
      t.font = 'italic 110px "Segoe Script", "Brush Script MT", "Lucida Handwriting", cursive';
      t.textBaseline = 'middle';
      t.fillText(v.typed.trim(), 20, 110);
    } else if (drawn) c = pad;
    else return toast('Draw or type a signature first', 'error');
    const trimmed = trimCanvas(c);
    if (!trimmed) return toast('Signature is empty', 'error');
    src = trimmed.toDataURL('image/png');
    if (v.remember) localStorage.setItem(SIG_KEY, JSON.stringify([src, ...loadSigs()].slice(0, 6)));
  }
  const img = await loadImage(src);
  const w = 160;
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
export async function applyRedactions(app) {
  const marks = app.annots.list.filter((a) => a.type === 'redact');
  if (!marks.length) { toast('Nothing to redact. Use the Redact tool or "Find & redact" to mark content first.'); return true; }
  const pages = [...new Set(marks.map((a) => a.page))].sort((a, b) => a - b);
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
    return E.rasterizePages(bytes, replacements);
  });
  if (ok) {
    app.annots.list = app.annots.list.filter((a) => a.type !== 'redact');
    app.annots.renderAll();
    app.onAnnotationsChanged();
    toast(`Redacted ${marks.length} area(s) on ${pages.length} page(s). Run OCR to make the remaining text searchable again.`, 'info', 6000);
  }
  return ok;
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
        const [a, b, c, d, e, f] = it.transform;
        const fh = Math.hypot(c, d);
        const len = it.str.length || 1;
        const ux = a / (Math.hypot(a, b) || 1), uy = b / (Math.hypot(a, b) || 1);
        const s0 = (m.index / len) * it.width, s1 = ((m.index + m[0].length) / len) * it.width;
        // Corners of the match box in PDF space, then to visual coords.
        const corners = [[s0, -0.25 * fh], [s1, -0.25 * fh], [s1, 0.95 * fh], [s0, 0.95 * fh]].map(([sx, sy]) =>
          p.base.convertToViewportPoint(e + sx * ux - sy * uy, f + sx * uy + sy * ux));
        const xs = corners.map((q) => q[0]), ys = corners.map((q) => q[1]);
        const x = Math.min(...xs), y = Math.min(...ys);
        marks.push({ id: uid(), type: 'redact', page: p.index, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, created: Date.now() });
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
  if (v.me.trim()) localStorage.setItem('pdfpro.author', v.me.trim());
  if (['title', 'author', 'subject', 'keywords', 'creator'].some((k) => v[k] !== m[k])) await app.runOp('Updating properties', (b) => E.setMetadata(b, v));
}

// ---------- forms ----------

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
    body: `<p class="muted">Adds an invisible, searchable and selectable text layer to scanned pages. Runs locally; the OCR engine and language data (~10 MB) are downloaded the first time.</p>
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
    worker = await createWorker(v.lang);
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
    toast(`OCR failed: ${e.message || e}. An internet connection is required the first time.`, 'error', 7000);
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

export async function exportText(app) {
  const parts = [];
  for (let i = 0; i < app.pageCount; i++) parts.push(`--- Page ${i + 1} ---\n${await pageText(app.state.pdf, i)}`);
  downloadBlob(parts.join('\n\n'), `${baseName(app.state.fileName)}.txt`, 'text/plain;charset=utf-8');
}
