// Page thumbnails: navigation, multi-select, drag-and-drop reordering.
import { h } from './lib/ui.js';
import { pdfjsLib } from './lib/pdfjs.js';

const THUMB_W = 140;

export class Thumbnails {
  constructor(el, { onNavigate, onReorder, onSelectionChange, onDropFiles }) {
    this.el = el;
    this.cb = { onNavigate, onReorder, onSelectionChange, onDropFiles };
    this.items = [];
    this.selected = new Set();
    this.anchor = 0;
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) this.render(this.items[+e.target.dataset.index]);
    }, { root: el.parentElement, rootMargin: '300px 0px' });
  }

  setDocument(pdf, { keepSelection = false } = {}) {
    this.observer.disconnect();
    this.pdf = pdf;
    this.el.innerHTML = '';
    this.items = [];
    if (!keepSelection) this.selected = new Set();
    if (!pdf) return;
    this.selected = new Set([...this.selected].filter((i) => i < pdf.numPages));
    for (let i = 0; i < pdf.numPages; i++) {
      const canvas = h('canvas', { width: THUMB_W, height: THUMB_W * 1.3 });
      const div = h('div', { className: 'thumb', draggable: true, title: `Page ${i + 1}` }, canvas, h('div', { className: 'num' }, i + 1));
      div.dataset.index = i;
      div.addEventListener('click', (e) => this.onClick(e, i));
      div.addEventListener('dragstart', (e) => this.onDragStart(e, i));
      div.addEventListener('dragover', (e) => this.onDragOver(e, div));
      div.addEventListener('dragleave', () => div.classList.remove('drop-before', 'drop-after'));
      div.addEventListener('drop', (e) => this.onDrop(e, i, div));
      this.el.append(div);
      const item = { index: i, div, canvas, rendered: false };
      this.items.push(item);
      this.observer.observe(div);
    }
    this.paintSelection();
  }

  async render(item) {
    if (!item || item.rendered || !this.pdf) return;
    item.rendered = true;
    const pdf = this.pdf;
    const page = await pdf.getPage(item.index + 1);
    const base = page.getViewport({ scale: 1 });
    const scale = (THUMB_W / base.width) * Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale });
    const c = item.canvas;
    c.width = vp.width;
    c.height = vp.height;
    c.style.width = `${THUMB_W}px`;
    c.style.height = `${(THUMB_W * base.height) / base.width}px`;
    try {
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;
    } catch { item.rendered = false; }
  }

  setCurrent(i) {
    for (const it of this.items) it.div.classList.toggle('current', it.index === i);
    const cur = this.items[i];
    if (cur) {
      const box = this.el.parentElement;
      const top = cur.div.offsetTop, bottom = top + cur.div.offsetHeight;
      if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight) cur.div.scrollIntoView({ block: 'nearest' });
    }
    if (!this.selected.size) this.anchor = i;
  }

  onClick(e, i) {
    if (e.shiftKey) {
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)];
      this.selected = new Set(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    } else if (e.ctrlKey || e.metaKey) {
      this.selected.has(i) ? this.selected.delete(i) : this.selected.add(i);
      this.anchor = i;
    } else {
      this.selected = new Set([i]);
      this.anchor = i;
    }
    this.paintSelection();
    this.cb.onNavigate(i);
  }

  selectAll() {
    this.selected = new Set(this.items.map((it) => it.index));
    this.paintSelection();
  }

  paintSelection() {
    for (const it of this.items) it.div.classList.toggle('selected', this.selected.has(it.index));
    this.cb.onSelectionChange?.([...this.selected]);
  }

  /** Selected pages, or the current page if nothing is selected. */
  targets(current) {
    return this.selected.size ? [...this.selected].sort((a, b) => a - b) : [current];
  }

  onDragStart(e, i) {
    if (!this.selected.has(i)) { this.selected = new Set([i]); this.paintSelection(); }
    e.dataTransfer.setData('application/x-inkstone-pages', JSON.stringify([...this.selected]));
    e.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(e, div) {
    const isPages = e.dataTransfer.types.includes('application/x-inkstone-pages');
    const isFiles = e.dataTransfer.types.includes('Files');
    if (!isPages && !isFiles) return;
    e.preventDefault();
    e.stopPropagation();
    const r = div.getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    div.classList.toggle('drop-after', after);
    div.classList.toggle('drop-before', !after);
  }

  onDrop(e, i, div) {
    const after = div.classList.contains('drop-after');
    div.classList.remove('drop-before', 'drop-after');
    const target = after ? i + 1 : i;
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      this.cb.onDropFiles?.([...e.dataTransfer.files], target);
      return;
    }
    const raw = e.dataTransfer.getData('application/x-inkstone-pages');
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    const moving = JSON.parse(raw).sort((a, b) => a - b);
    const all = this.items.map((it) => it.index);
    const rest = all.filter((x) => !moving.includes(x));
    const insertAt = rest.filter((x) => x < target).length;
    const order = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
    if (order.every((v, k) => v === k)) return;
    this.selected = new Set(moving.map((m) => order.indexOf(m)));
    this.cb.onReorder(order);
  }
}
