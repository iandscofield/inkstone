// Visual compare: render matching pages of two documents, find the regions whose
// pixels differ, and show them side by side, as a red/cyan overlay, or highlighted.
import { openPdf } from './lib/pdfjs.js';
import { h, toast, pickFiles, readBytes, setStatus, uid } from './lib/ui.js';

const DETECT_WIDTH = 900; // pixels used for change detection
const CELL = 6; // detection grid cell size in pixels
const THRESHOLD = 48; // per-channel difference that counts as changed

async function renderAtWidth(pdf, index, width) {
  const page = await pdf.getPage(index + 1);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / base.width });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, base, scale: vp.scale };
}

/** Bounding boxes (in canvas pixels) of regions that differ between two same-width canvases. */
function diffRegions(a, b) {
  const w = Math.min(a.width, b.width), hgt = Math.min(a.height, b.height);
  const da = a.getContext('2d').getImageData(0, 0, w, hgt).data;
  const db = b.getContext('2d').getImageData(0, 0, w, hgt).data;
  const cols = Math.ceil(w / CELL), rows = Math.ceil(hgt / CELL);
  const marked = new Uint8Array(cols * rows);
  for (let y = 0; y < hgt; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (Math.abs(da[i] - db[i]) > THRESHOLD || Math.abs(da[i + 1] - db[i + 1]) > THRESHOLD || Math.abs(da[i + 2] - db[i + 2]) > THRESHOLD) {
        marked[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]++;
      }
    }
  }
  // A cell counts if a few pixels changed (ignores single-pixel antialiasing noise).
  const on = (c, r) => c >= 0 && r >= 0 && c < cols && r < rows && marked[r * cols + c] >= 3;
  // Areas present in only one page (a taller page) are changes too.
  const extra = [];
  if (a.height !== b.height) extra.push({ x: 0, y: hgt, w, h: Math.abs(a.height - b.height) });
  const seen = new Uint8Array(cols * rows);
  const boxes = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!on(c, r) || seen[r * cols + c]) continue;
      // Flood fill, bridging gaps of one cell so a changed word becomes one box.
      let minC = c, maxC = c, minR = r, maxR = r;
      const stack = [[c, r]];
      seen[r * cols + c] = 1;
      while (stack.length) {
        const [cc, rr] = stack.pop();
        minC = Math.min(minC, cc); maxC = Math.max(maxC, cc); minR = Math.min(minR, rr); maxR = Math.max(maxR, rr);
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const nc = cc + dx, nr = rr + dy;
          if (on(nc, nr) && !seen[nr * cols + nc]) { seen[nr * cols + nc] = 1; stack.push([nc, nr]); }
        }
      }
      boxes.push({ x: minC * CELL, y: minR * CELL, w: (maxC - minC + 1) * CELL, h: (maxR - minR + 1) * CELL });
    }
  }
  return [...boxes, ...extra];
}

/** Red/cyan overlay: content only in the old page shows red, only in the new page cyan. */
function overlayCanvas(oldC, newC) {
  const w = Math.max(oldC.width, newC.width), hgt = Math.max(oldC.height, newC.height);
  const out = document.createElement('canvas');
  out.width = w; out.height = hgt;
  const oc = document.createElement('canvas'); oc.width = w; oc.height = hgt;
  const nc = document.createElement('canvas'); nc.width = w; nc.height = hgt;
  for (const [c, src] of [[oc, oldC], [nc, newC]]) { const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, hgt); x.drawImage(src, 0, 0); }
  const o = oc.getContext('2d').getImageData(0, 0, w, hgt).data;
  const n = nc.getContext('2d').getImageData(0, 0, w, hgt).data;
  const ctx = out.getContext('2d');
  const img = ctx.createImageData(w, hgt);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lo = 0.3 * o[i] + 0.59 * o[i + 1] + 0.11 * o[i + 2];
    const ln = 0.3 * n[i] + 0.59 * n[i + 1] + 0.11 * n[i + 2];
    d[i] = ln; d[i + 1] = lo; d[i + 2] = lo; d[i + 3] = 255;
    // Unchanged content renders grey rather than black so changes stand out.
    if (Math.abs(lo - ln) < 40) { const g = 255 - (255 - lo) * 0.45; d[i] = d[i + 1] = d[i + 2] = g; }
  }
  ctx.putImageData(img, 0, 0);
  return out;
}

function drawBoxes(canvas, boxes, scale, style) {
  const ctx = canvas.getContext('2d');
  ctx.save();
  for (const b of boxes) {
    const x = b.x * scale - 3, y = b.y * scale - 3, w = b.w * scale + 6, hh = b.h * scale + 6;
    if (style === 'fill') { ctx.fillStyle = 'rgba(250, 204, 21, 0.35)'; ctx.fillRect(x, y, w, hh); }
    ctx.strokeStyle = style === 'fill' ? 'rgba(234, 88, 12, 0.9)' : 'rgba(220, 38, 38, 0.9)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, hh);
  }
  ctx.restore();
}

export async function visualCompare(app) {
  const [file] = await pickFiles('application/pdf');
  if (!file) return;
  let older;
  try {
    older = await openPdf(await readBytes(file));
  } catch (e) {
    return toast(`Could not open ${file.name}: ${e.message}`, 'error');
  }
  const current = app.state.pdf;
  const total = Math.max(current.numPages, older.numPages);
  const results = new Array(total).fill(null);

  // ---- the view ----
  let index = app.current < total ? app.current : 0;
  let mode = 'side';
  const stage = h('div', { className: 'cmp-stage' });
  const pageLabel = h('span', { className: 'cmp-page' });
  const list = h('div', { className: 'cmp-list' });
  const summary = h('span', { className: 'muted small' }, 'Analyzing pages…');
  const modeBtns = ['side', 'overlay', 'diff'].map((m) => h('button', {
    className: m === mode ? 'active' : '',
    onclick: () => { mode = m; modeBtns.forEach((b) => b.classList.toggle('active', b.dataset.mode === m)); show(); },
    'data-mode': m,
  }, { side: 'Side by side', overlay: 'Overlay', diff: 'Differences' }[m]));
  const close = () => { view.remove(); document.removeEventListener('keydown', onKey, true); older.destroy(); };
  const markBtn = h('button', { onclick: () => markInDocument() }, 'Mark changes in document');
  const view = h('div', { className: 'cmp-view', role: 'dialog', 'aria-label': 'Visual compare' },
    h('header', { className: 'cmp-head' },
      h('div', { className: 'cmp-title' }, h('strong', {}, 'Visual compare'), h('span', { className: 'muted small' }, `${file.name} (older)  →  ${app.state.fileName} (current)`)),
      h('div', { className: 'seg-tabs' }, modeBtns),
      h('div', { className: 'cmp-nav' },
        h('button', { className: 'icon sm', title: 'Previous page', 'aria-label': 'Previous page', onclick: () => go(index - 1) }, '‹'),
        pageLabel,
        h('button', { className: 'icon sm', title: 'Next page', 'aria-label': 'Next page', onclick: () => go(index + 1) }, '›')),
      markBtn,
      h('button', { className: 'primary', onclick: close }, 'Close')),
    h('div', { className: 'cmp-body' },
      h('aside', { className: 'cmp-side' }, summary, list),
      stage),
    h('footer', { className: 'cmp-legend muted small' }));
  document.body.append(view);
  const onKey = (e) => {
    if (document.querySelector('.modal-back')) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); go(index + 1); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); go(index - 1); }
  };
  document.addEventListener('keydown', onKey, true);

  async function analyze(i) {
    if (results[i]) return results[i];
    const hasNew = i < current.numPages, hasOld = i < older.numPages;
    const res = { index: i, onlyNew: hasNew && !hasOld, onlyOld: hasOld && !hasNew, boxes: [] };
    if (hasNew && hasOld) {
      const [a, b] = await Promise.all([renderAtWidth(older, i, DETECT_WIDTH), renderAtWidth(current, i, DETECT_WIDTH)]);
      res.boxes = diffRegions(a.canvas, b.canvas);
      res.scaleNew = b.scale; // detection pixels per PDF point on the current page
    }
    results[i] = res;
    return res;
  }

  function renderList() {
    list.replaceChildren(...results.map((r, i) => {
      const label = !r ? '…' : r.onlyNew ? 'new page' : r.onlyOld ? 'removed' : r.boxes.length ? `${r.boxes.length} change${r.boxes.length === 1 ? '' : 's'}` : 'no changes';
      const changed = r && (r.onlyNew || r.onlyOld || r.boxes.length);
      return h('button', { className: `cmp-item${i === index ? ' active' : ''}${changed ? ' changed' : ''}`, onclick: () => go(i) }, h('span', {}, `Page ${i + 1}`), h('span', { className: 'muted' }, label));
    }));
  }

  async function show() {
    pageLabel.textContent = `Page ${index + 1} of ${total}`;
    renderList();
    const legend = view.querySelector('.cmp-legend');
    legend.textContent = mode === 'overlay' ? 'Red: only in the older version · Cyan: only in the current version · Grey: unchanged'
      : mode === 'diff' ? 'Highlighted: areas that changed' : 'Boxes mark areas that changed';
    stage.replaceChildren(h('div', { className: 'muted', style: { padding: '40px' } }, 'Rendering…'));
    const r = await analyze(index);
    const shown = index;
    const avail = Math.max(300, stage.clientWidth - 48);
    const width = Math.min(1600, mode === 'side' ? (avail - 24) / 2 : Math.min(avail, 1100)) * Math.min(2, devicePixelRatio || 1);
    const [oldR, newR] = await Promise.all([
      index < older.numPages ? renderAtWidth(older, index, width) : null,
      index < current.numPages ? renderAtWidth(current, index, width) : null,
    ]);
    if (shown !== index) return;
    const k = width / DETECT_WIDTH;
    const frame = (canvas, caption) => h('figure', { className: 'cmp-frame' }, canvas || h('div', { className: 'cmp-missing' }, 'No page'), h('figcaption', {}, caption));
    const css = (c) => { if (c) { c.style.width = `${c.width / Math.min(2, devicePixelRatio || 1)}px`; } return c; };
    if (mode === 'side') {
      if (oldR) drawBoxes(oldR.canvas, r.boxes, k);
      if (newR) drawBoxes(newR.canvas, r.boxes, k);
      stage.replaceChildren(h('div', { className: 'cmp-pair' }, frame(css(oldR?.canvas), 'Older'), frame(css(newR?.canvas), 'Current')));
    } else if (mode === 'overlay') {
      const c = oldR && newR ? overlayCanvas(oldR.canvas, newR.canvas) : (newR || oldR).canvas;
      stage.replaceChildren(frame(css(c), oldR && newR ? 'Overlay' : r.onlyNew ? 'New page (not in the older version)' : 'Removed page (only in the older version)'));
    } else {
      const c = (newR || oldR).canvas;
      drawBoxes(c, r.boxes, k, 'fill');
      stage.replaceChildren(frame(css(c), newR ? 'Current' : 'Older'));
    }
  }

  function go(i) {
    if (i < 0 || i >= total) return;
    index = i;
    show();
  }

  async function markInDocument() {
    markBtn.disabled = true;
    for (let i = 0; i < total; i++) await analyze(i);
    const marks = [];
    for (const r of results) {
      if (!r?.boxes.length || r.index >= current.numPages) continue;
      const s = r.scaleNew;
      for (const b of r.boxes) marks.push({ id: uid(), type: 'rect', page: r.index, x: b.x / s - 2, y: b.y / s - 2, w: b.w / s + 4, h: b.h / s + 4, color: '#f97316', width: 1.5, created: Date.now() });
    }
    markBtn.disabled = false;
    if (!marks.length) return toast('No visual differences to mark.');
    app.checkpoint();
    app.annots.list.push(...marks);
    app.annots.renderAll();
    app.onAnnotationsChanged();
    toast(`Marked ${marks.length} changed area(s) with orange boxes. Undo removes them.`, 'info', 6000);
  }

  await show();
  // Analyze the rest in the background to fill in the page list.
  for (let i = 0; i < total; i++) {
    if (!view.isConnected) return;
    setStatus(`Comparing page ${i + 1} of ${total}…`);
    await analyze(i);
    renderList();
  }
  setStatus('');
  const changed = results.filter((r) => r.onlyNew || r.onlyOld || r.boxes.length).length;
  summary.textContent = changed ? `${changed} of ${total} page${total === 1 ? '' : 's'} changed` : 'No visual differences found';
}
