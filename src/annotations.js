// Annotation model + interactive editing on each page's SVG overlay.
//
// Annotations live in "visual" page coordinates (points from the top-left of the
// page as displayed, i.e. a pdf.js viewport at scale 1). They stay editable for the
// whole session and are flattened into the PDF on save/export (see engine.drawAnnotations).
import { h, uid, clone, prompt, toast } from './lib/ui.js';
import { arrowHead, TEXT_PAD, LINE_HEIGHT } from './lib/engine.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  return el;
};

const RECT_TYPES = new Set(['rect', 'ellipse', 'highlight', 'underline', 'whiteout', 'redact', 'text', 'stamp', 'image']);
const DRAG_TOOLS = new Set(['rect', 'ellipse', 'highlight', 'underline', 'whiteout', 'redact', 'line', 'arrow', 'ink', 'text', 'field-text', 'field-check', 'field-dropdown', 'field-radio', 'link']);
const FONT = 'Helvetica, Arial, sans-serif';
export const TYPE_LABELS = {
  rect: 'Rectangle', ellipse: 'Ellipse', highlight: 'Highlight', underline: 'Underline', whiteout: 'Whiteout',
  redact: 'Redaction', line: 'Line', arrow: 'Arrow', ink: 'Drawing', text: 'Text', stamp: 'Stamp', image: 'Image', note: 'Note',
};

const measureCtx = document.createElement('canvas').getContext('2d');
function textWidth(text, size, bold = false) {
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
  return measureCtx.measureText(text).width;
}

export function bbox(a) {
  if (RECT_TYPES.has(a.type)) return { x: a.x, y: a.y, w: a.w, h: a.h };
  if (a.type === 'note') return { x: a.x, y: a.y, w: 20, h: 20 };
  if (a.type === 'line' || a.type === 'arrow') {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  if (a.type === 'ink') {
    const xs = a.points.map((p) => p[0]), ys = a.points.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function translate(a, dx, dy) {
  if ('x' in a) { a.x += dx; a.y += dy; }
  if ('x1' in a) { a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; }
  if (a.points) a.points = a.points.map(([x, y]) => [x + dx, y + dy]);
}

/** Resize so the bbox's bottom-right corner lands at (px, py). `orig` is the annotation at drag start. */
function resizeTo(a, orig, px, py) {
  const b = bbox(orig);
  if (a.type === 'line' || a.type === 'arrow') { a.x2 = px; a.y2 = py; return; }
  if (a.type === 'ink') {
    const sx = Math.max(5, px - b.x) / Math.max(1, b.w), sy = Math.max(5, py - b.y) / Math.max(1, b.h);
    a.points = orig.points.map(([x, y]) => [b.x + (x - b.x) * sx, b.y + (y - b.y) * sy]);
    return;
  }
  if ('w' in a) {
    a.w = Math.max(6, px - a.x);
    a.h = Math.max(4, py - a.y);
    if (a.type === 'image' && a.keepAspect !== false) a.h = a.w * (orig.h / orig.w);
  }
}

export function fitText(a) {
  const lines = (a.text || '').split('\n');
  const size = a.fontSize || 12;
  a.w = Math.max(20, Math.max(...lines.map((l) => textWidth(l, size))) + TEXT_PAD * 2 + 2);
  a.h = lines.length * size * LINE_HEIGHT + TEXT_PAD * 2 - size * (LINE_HEIGHT - 1);
}

function shape(a, { draft = false, selected = false } = {}) {
  const g = s('g', { class: draft ? 'draft' : 'ann', 'data-id': a.id });
  const color = a.color || '#000000';
  const width = a.width ?? 2;
  const op = a.opacity ?? 1;
  const b = bbox(a);
  switch (a.type) {
    case 'rect':
      g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, stroke: color, 'stroke-width': width, fill: a.fill || 'none', 'fill-opacity': a.fill ? a.fillOpacity ?? 1 : null, opacity: op }));
      break;
    case 'ellipse':
      g.append(s('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, stroke: color, 'stroke-width': width, fill: a.fill || 'none', 'fill-opacity': a.fill ? a.fillOpacity ?? 1 : null, opacity: op }));
      break;
    case 'highlight':
      g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: color, opacity: a.opacity ?? 0.4, style: 'mix-blend-mode:multiply' }));
      break;
    case 'underline': {
      const y = a.strike ? a.y + a.h / 2 : a.y + a.h - width / 2;
      g.append(s('line', { x1: a.x, y1: y, x2: a.x + a.w, y2: y, stroke: color, 'stroke-width': width, opacity: op }));
      break;
    }
    case 'whiteout':
      g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.fill || '#ffffff', stroke: selected || draft ? '#9ca3af' : 'none', 'stroke-dasharray': '3 2', 'stroke-width': 0.6 }));
      break;
    case 'redact':
      g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: '#000', 'fill-opacity': 0.75, stroke: '#ef4444', 'stroke-width': 1.2 }));
      break;
    case 'line':
    case 'arrow': {
      const attrs = { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', opacity: op, fill: 'none' };
      g.append(s('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, ...attrs }));
      if (a.type === 'arrow') {
        const [p1, p2] = arrowHead(a, width);
        g.append(s('polyline', { points: `${p1} ${a.x2},${a.y2} ${p2}`, ...attrs }));
      }
      break;
    }
    case 'ink':
      g.append(s('polyline', { points: a.points.map((p) => p.join(',')).join(' '), stroke: color, 'stroke-width': width, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: op }));
      break;
    case 'text': {
      if (a.fill) g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.fill }));
      const size = a.fontSize || 12;
      const t = s('text', { fill: color, 'font-size': size, 'font-family': FONT, opacity: op, 'xml:space': 'preserve' });
      (a.text || '').split('\n').forEach((line, i) => {
        const span = s('tspan', { x: a.x + TEXT_PAD, y: a.y + TEXT_PAD + size * 0.85 + i * size * LINE_HEIGHT });
        span.textContent = line || ' ';
        t.append(span);
      });
      g.append(t);
      break;
    }
    case 'stamp': {
      g.append(s('rect', { x: a.x, y: a.y, width: a.w, height: a.h, stroke: color, 'stroke-width': 3, fill: 'none', rx: 2, opacity: op }));
      const size = Math.min(a.h * 0.55, (a.w - 12) / Math.max(1, textWidth(a.text, 1, true)));
      const t = s('text', { x: a.x + a.w / 2, y: a.y + a.h / 2 + size * 0.36, 'text-anchor': 'middle', fill: color, 'font-size': size, 'font-weight': 'bold', 'font-family': FONT, opacity: op });
      t.textContent = a.text;
      g.append(t);
      break;
    }
    case 'image':
      g.append(s('image', { href: a.src, x: a.x, y: a.y, width: a.w, height: a.h, preserveAspectRatio: 'none', opacity: op }));
      break;
    case 'note': {
      g.append(s('rect', { x: a.x, y: a.y, width: 20, height: 20, rx: 3, fill: a.color || '#f6c026', stroke: '#a16207', 'stroke-width': 1 }));
      g.append(s('path', { d: `M${a.x + 4} ${a.y + 7}h12M${a.x + 4} ${a.y + 11}h12M${a.x + 4} ${a.y + 15}h8`, stroke: '#713f12', 'stroke-width': 1.3 }));
      const title = s('title');
      title.textContent = a.text;
      g.append(title);
      break;
    }
  }
  if (!draft) {
    // Transparent hit area so thin shapes are easy to grab.
    const pad = 4;
    g.prepend(s('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: 'transparent', 'pointer-events': 'all' }));
  }
  return g;
}

export class Annotator {
  constructor(app) {
    this.app = app;
    this.list = [];
    this.selectedId = null;
    this.tool = 'select';
    this.pending = null; // {kind:'image'|'stamp', ...} awaiting a click to place
    this.drag = null;
  }

  get viewer() { return this.app.viewer; }
  get selected() { return this.list.find((a) => a.id === this.selectedId) || null; }

  style() {
    return {
      color: document.getElementById('colorInput').value,
      width: Number(document.getElementById('widthInput').value),
      fontSize: Number(document.getElementById('fontSizeInput').value),
    };
  }

  setTool(tool) {
    this.tool = tool;
    if (tool !== 'place') this.pending = null;
    if (tool !== 'select') this.select(null);
  }

  attachPage(p) {
    p.svg.addEventListener('pointerdown', (e) => this.onDown(e, p));
    p.svg.addEventListener('pointermove', (e) => this.onMove(e, p));
    p.svg.addEventListener('pointerup', (e) => this.onUp(e, p));
    p.svg.addEventListener('dblclick', (e) => {
      const g = e.target.closest('.ann');
      if (g) this.editContent(this.list.find((a) => a.id === g.dataset.id));
    });
    this.renderPage(p.index);
  }

  renderAll() { this.viewer.pages.forEach((p) => this.renderPage(p.index)); }

  renderPage(i) {
    const p = this.viewer.pages[i];
    if (!p) return;
    p.svg.replaceChildren();
    for (const a of this.list) if (a.page === i) p.svg.append(shape(a, { selected: a.id === this.selectedId }));
    const sel = this.selected;
    if (sel && sel.page === i) {
      const b = bbox(sel);
      p.svg.append(s('rect', { class: 'sel-box', x: b.x - 3, y: b.y - 3, width: b.w + 6, height: b.h + 6, 'vector-effect': 'non-scaling-stroke' }));
      if (sel.type !== 'note') {
        const hs = 8 / this.viewer.scale;
        const hx = sel.type === 'line' || sel.type === 'arrow' ? sel.x2 : b.x + b.w;
        const hy = sel.type === 'line' || sel.type === 'arrow' ? sel.y2 : b.y + b.h;
        p.svg.append(s('rect', { class: 'handle', x: hx - hs / 2, y: hy - hs / 2, width: hs, height: hs, 'pointer-events': 'all', 'vector-effect': 'non-scaling-stroke' }));
      }
    }
    if (this.drag?.draft && this.drag.p === p) p.svg.append(shape(this.drag.draft, { draft: true }));
  }

  changed(pages) {
    for (const i of new Set(pages)) this.renderPage(i);
    this.app.onAnnotationsChanged();
  }

  select(id) {
    const prev = this.selected;
    this.selectedId = id;
    const cur = this.selected;
    if (prev) this.renderPage(prev.page);
    if (cur && cur !== prev) this.renderPage(cur.page);
    this.app.renderProps(cur);
  }

  add(a, { select = true } = {}) {
    this.app.checkpoint();
    a.id = uid();
    a.created = Date.now();
    this.list.push(a);
    this.changed([a.page]);
    if (select && this.tool === 'select') this.select(a.id);
    return a;
  }

  update(a, patch, { checkpoint = true } = {}) {
    if (checkpoint) this.app.checkpoint();
    Object.assign(a, patch);
    if (a.type === 'text' && ('text' in patch || 'fontSize' in patch)) fitText(a);
    this.changed([a.page]);
    this.app.renderProps(a);
  }

  remove(a) {
    if (!a) return;
    this.app.checkpoint();
    this.list = this.list.filter((x) => x !== a);
    if (this.selectedId === a.id) this.select(null);
    this.changed([a.page]);
  }

  bringToFront(a) {
    this.app.checkpoint();
    this.list = [...this.list.filter((x) => x !== a), a];
    this.changed([a.page]);
  }

  duplicate(a) {
    const c = clone(a);
    translate(c, 12, 12);
    this.add(c);
  }

  // ---------- pointer interaction ----------

  pt(e, p) { return this.viewer.clientToPage(p, e.clientX, e.clientY); }

  onDown(e, p) {
    if (e.button !== 0) return;
    const [x, y] = this.pt(e, p);
    const st = this.style();

    if (this.tool === 'select') {
      const target = e.target;
      const sel = this.selected;
      if (target.classList.contains('handle') && sel) {
        this.drag = { mode: 'resize', p, a: sel, orig: clone(sel), started: false };
      } else {
        const g = target.closest('.ann');
        if (!g) return;
        this.select(g.dataset.id);
        this.drag = { mode: 'move', p, a: this.selected, x, y, started: false };
      }
      p.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }

    if (this.tool === 'place' && this.pending) {
      this.place(p, x, y);
      e.preventDefault();
      return;
    }

    if (this.tool === 'note') {
      e.preventDefault();
      this.createNote(p.index, x, y);
      return;
    }

    if (DRAG_TOOLS.has(this.tool)) {
      const base = { type: this.tool, page: p.index, color: st.color, width: st.width };
      let draft;
      if (this.tool === 'ink') draft = { ...base, points: [[x, y]] };
      else if (this.tool === 'line' || this.tool === 'arrow') draft = { ...base, x1: x, y1: y, x2: x, y2: y };
      else draft = { ...base, x, y, w: 0, h: 0 };
      if (this.tool === 'highlight') draft.color = st.color === '#d93025' ? '#ffd400' : st.color;
      if (this.tool.startsWith('field') || this.tool === 'link') Object.assign(draft, { type: 'rect', color: this.tool === 'link' ? '#2563eb' : '#4060b0', width: 1 });
      this.drag = { mode: 'create', p, x0: x, y0: y, draft, tool: this.tool };
      p.svg.setPointerCapture(e.pointerId);
      e.preventDefault();
    }
  }

  onMove(e, p) {
    const d = this.drag;
    if (!d || d.p !== p) return;
    let [x, y] = this.pt(e, p);
    if (d.mode === 'move') {
      if (!d.started) {
        if (Math.hypot(x - d.x, y - d.y) < 2) return;
        this.app.checkpoint();
        d.started = true;
      }
      translate(d.a, x - d.x, y - d.y);
      d.x = x;
      d.y = y;
      this.renderPage(p.index);
    } else if (d.mode === 'resize') {
      if (!d.started) { this.app.checkpoint(); d.started = true; }
      resizeTo(d.a, d.orig, x, y);
      this.renderPage(p.index);
    } else if (d.mode === 'create') {
      const a = d.draft;
      if (e.shiftKey && (a.type === 'line' || a.type === 'arrow')) {
        // Snap to 45° increments.
        const ang = Math.round(Math.atan2(y - d.y0, x - d.x0) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(x - d.x0, y - d.y0);
        x = d.x0 + len * Math.cos(ang);
        y = d.y0 + len * Math.sin(ang);
      }
      if (a.type === 'ink') a.points.push([x, y]);
      else if ('x1' in a) { a.x2 = x; a.y2 = y; }
      else {
        let w = x - d.x0, hh = y - d.y0;
        if (e.shiftKey) { const m = Math.max(Math.abs(w), Math.abs(hh)); w = Math.sign(w || 1) * m; hh = Math.sign(hh || 1) * m; }
        Object.assign(a, { x: Math.min(d.x0, d.x0 + w), y: Math.min(d.y0, d.y0 + hh), w: Math.abs(w), h: Math.abs(hh) });
      }
      this.renderPage(p.index);
    }
  }

  async onUp(e, p) {
    const d = this.drag;
    if (!d || d.p !== p) return;
    this.drag = null;
    if (d.mode === 'move' || d.mode === 'resize') {
      if (d.started) this.changed([p.index]);
      this.app.renderProps(this.selected);
      return;
    }
    this.renderPage(p.index);
    const a = d.draft;
    const b = bbox(a);
    const tiny = b.w < 3 && b.h < 3;
    if (d.tool === 'text') {
      await this.createText(p.index, a.x, a.y);
      return;
    }
    if (tiny && a.type !== 'ink') return;
    if (d.tool.startsWith('field-') || d.tool === 'link') {
      // Form fields and links are written straight into the document.
      await this.app.createFromRect(d.tool, p.index, b);
      return;
    }
    if (a.type === 'ink' && a.points.length < 2) a.points.push([a.points[0][0] + 0.5, a.points[0][1] + 0.5]);
    if (a.type === 'highlight') a.opacity = 0.4;
    if (a.type === 'whiteout') a.fill = '#ffffff';
    this.add(a, { select: false });
  }

  // ---------- creation helpers ----------

  async createText(page, x, y, { text = '', color, fontSize } = {}) {
    const st = this.style();
    const value = await prompt('Add text', null, text, { multiline: true });
    if (!value) return null;
    const a = { type: 'text', page, x, y, text: value, color: color || st.color, fontSize: fontSize || st.fontSize };
    fitText(a);
    return this.add(a);
  }

  async createNote(page, x, y) {
    const text = await prompt('Add comment', null, '', { multiline: true });
    if (!text) return;
    this.add({ type: 'note', page, x: x - 10, y: y - 10, text, color: '#f6c026', author: this.app.author() });
  }

  async editContent(a) {
    if (!a) return;
    if (a.type === 'text' || a.type === 'note') {
      const v = await prompt(a.type === 'note' ? 'Edit comment' : 'Edit text', null, a.text, { multiline: true });
      if (v != null && v !== '') this.update(a, { text: v });
    } else if (a.type === 'stamp') {
      const v = await prompt('Edit stamp', null, a.text);
      if (v) this.update(a, { text: v });
    }
  }

  startPlacing(pending) {
    this.pending = pending;
    this.app.setTool('place', { keepPending: true });
    toast('Click on a page to place it');
  }

  place(p, x, y) {
    const pd = this.pending;
    this.pending = null;
    const base = { page: p.index, x: x - pd.w / 2, y: y - pd.h / 2, w: pd.w, h: pd.h };
    if (pd.kind === 'image') this.add({ type: 'image', src: pd.src, ...base }, { select: false });
    if (pd.kind === 'stamp') this.add({ type: 'stamp', text: pd.text, color: pd.color, ...base }, { select: false });
    this.app.setTool('select');
    this.select(this.list[this.list.length - 1].id);
  }

  /** Create highlight/underline/strikeout annotations from the current text selection. */
  markSelection(type = 'highlight', strike = false) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { toast('Select some text first'); return false; }
    const rects = [];
    for (let r = 0; r < sel.rangeCount; r++) rects.push(...sel.getRangeAt(r).getClientRects());
    const st = this.style();
    const out = [];
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const p = this.viewer.pageFromElement(el);
      if (!p) continue;
      const [x, y] = this.viewer.clientToPage(p, r.left, r.top);
      const [x2, y2] = this.viewer.clientToPage(p, r.right, r.bottom);
      // Skip near-duplicates (nested spans report overlapping rects).
      if (out.some((o) => o.page === p.index && Math.abs(o.x - x) < 1 && Math.abs(o.y - y) < 1)) continue;
      out.push({ type, page: p.index, x, y, w: x2 - x, h: y2 - y, color: type === 'highlight' ? (st.color === '#d93025' ? '#ffd400' : st.color) : st.color, width: Math.max(1, st.width / 2), opacity: type === 'highlight' ? 0.4 : 1, strike });
    }
    if (!out.length) { toast('Selection is not on a page'); return false; }
    this.app.checkpoint();
    for (const a of out) { a.id = uid(); a.created = Date.now(); this.list.push(a); }
    sel.removeAllRanges();
    this.changed(out.map((a) => a.page));
    return true;
  }

  /** "Edit Text": cover an existing text run with whiteout and replace it with an editable text box. */
  async editTextAt(e) {
    const span = e.target.closest('.textLayer span');
    const p = this.viewer.pageFromElement(e.target);
    if (!span || !p || !span.textContent.trim()) { toast('Click directly on a line of text to edit it'); return; }
    const r = span.getBoundingClientRect();
    const [x, y] = this.viewer.clientToPage(p, r.left, r.top);
    const [x2, y2] = this.viewer.clientToPage(p, r.right, r.bottom);
    const hgt = y2 - y;
    const fontSize = Math.max(4, Math.round(hgt * 0.82 * 2) / 2);
    const value = await prompt('Edit text', 'The original text will be covered and replaced with your edit.', span.textContent, { multiline: true });
    if (value == null || value === span.textContent) return;
    this.app.checkpoint();
    const white = { id: uid(), type: 'whiteout', page: p.index, x: x - 1, y: y - 1, w: x2 - x + 2, h: hgt + 2, fill: '#ffffff', created: Date.now() };
    this.list.push(white);
    if (value.trim()) {
      const t = { id: uid(), type: 'text', page: p.index, x: x - TEXT_PAD, y: y + (hgt - fontSize * 1.1) / 2 - TEXT_PAD, text: value, color: '#000000', fontSize, created: Date.now() };
      fitText(t);
      this.list.push(t);
    }
    this.changed([p.index]);
  }

  // ---------- page-op bookkeeping ----------

  /** Re-index annotations after a page operation. map(oldIndex) -> newIndex or -1 to drop. */
  remap(map) {
    this.list = this.list.filter((a) => {
      const n = map(a.page);
      if (n < 0) return false;
      a.page = n;
      return true;
    });
    if (!this.selected) this.selectedId = null;
  }

  takePages(indices) {
    const set = new Set(indices);
    const taken = this.list.filter((a) => set.has(a.page));
    this.list = this.list.filter((a) => !set.has(a.page));
    return taken;
  }

  snapshot() { return clone(this.list); }
  restore(list) { this.list = clone(list); this.selectedId = null; }
}
