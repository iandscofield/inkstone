// Continuous-scroll page viewer with lazy rendering, text layer, links, and search highlights.
import { pdfjsLib } from './lib/pdfjs.js';
import { h } from './lib/ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export class Viewer {
  constructor(wrap, container, { onPageChange, onPageCreated, onZoom }) {
    this.wrap = wrap;
    this.el = container;
    this.onPageChange = onPageChange;
    this.onPageCreated = onPageCreated;
    this.onZoom = onZoom;
    this.pdf = null;
    this.pages = [];
    this.scale = 1;
    this.zoomMode = 'fit-width';
    this.current = 0;
    this.search = null;
    this.observer = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = this.pages[+e.target.dataset.index];
        if (!p) continue;
        p.visible = e.isIntersecting;
        if (p.visible) this.renderPage(p);
      }
    }, { root: wrap, rootMargin: '600px 0px' });
    wrap.addEventListener('scroll', () => this.updateCurrent(), { passive: true });
    new ResizeObserver(() => { if (this.zoomMode.startsWith('fit')) this.setZoom(this.zoomMode); }).observe(wrap);
    this.initPan();
  }

  async setDocument(pdf, { keepPosition = false } = {}) {
    const prevScroll = keepPosition ? { top: this.wrap.scrollTop, left: this.wrap.scrollLeft } : null;
    for (const p of this.pages) p.task?.cancel();
    this.observer.disconnect();
    this.pdf = pdf;
    this.el.innerHTML = '';
    this.pages = [];
    if (!pdf) return;
    const all = await Promise.all(Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)));
    if (this.pdf !== pdf) return;
    for (const [i, page] of all.entries()) {
      const vp = page.getViewport({ scale: 1 });
      const div = h('div', { className: 'page' });
      div.dataset.index = i;
      const canvas = h('canvas', { className: 'render' });
      const text = h('div', { className: 'textLayer' });
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'annots');
      svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      const links = h('div', { className: 'links' });
      div.append(canvas, text, svg, links, h('div', { className: 'page-label' }, `${i + 1}`));
      this.el.append(div);
      const p = { index: i, page, base: vp, div, canvas, text, svg, links, renderedScale: 0 };
      this.pages.push(p);
      this.observer.observe(div);
      this.onPageCreated?.(p);
      this.addLinks(p);
    }
    this.applyScale(this.zoomMode === 'custom' ? this.scale : this.computeScale(this.zoomMode));
    if (prevScroll) {
      this.wrap.scrollTop = prevScroll.top;
      this.wrap.scrollLeft = prevScroll.left;
    } else {
      this.wrap.scrollTop = 0;
    }
    this.updateCurrent(true);
  }

  computeScale(mode) {
    if (!this.pages.length) return 1;
    const avail = this.wrap.clientWidth - 48;
    const maxW = Math.max(...this.pages.map((p) => p.base.width));
    if (mode === 'fit-width') return Math.max(0.1, avail / maxW);
    if (mode === 'fit-page') {
      const p = this.pages[this.current] || this.pages[0];
      return Math.max(0.1, Math.min(avail / p.base.width, (this.wrap.clientHeight - 40) / p.base.height));
    }
    return Number(mode) || 1;
  }

  setZoom(mode) {
    if (!this.pages.length) return;
    const anchor = this.current;
    const offset = this.pageOffsetRatio();
    if (mode === 'in' || mode === 'out') {
      const s = this.scale;
      const next = mode === 'in' ? ZOOM_STEPS.find((z) => z > s + 0.01) : [...ZOOM_STEPS].reverse().find((z) => z < s - 0.01);
      mode = String(next ?? s);
    }
    this.zoomMode = ['fit-width', 'fit-page'].includes(mode) ? mode : 'custom';
    this.applyScale(this.computeScale(mode));
    this.scrollToPage(anchor, offset);
  }

  applyScale(scale) {
    this.scale = scale;
    for (const p of this.pages) {
      p.div.style.width = `${p.base.width * scale}px`;
      p.div.style.height = `${p.base.height * scale}px`;
      p.div.style.setProperty('--scale-factor', scale);
      if (p.visible) this.renderPage(p);
    }
    this.onZoom?.(scale, this.zoomMode);
  }

  pageOffsetRatio() {
    const p = this.pages[this.current];
    if (!p) return 0;
    return (this.wrap.scrollTop - p.div.offsetTop) / p.div.offsetHeight;
  }

  scrollToPage(i, ratio = 0) {
    const p = this.pages[Math.max(0, Math.min(i, this.pages.length - 1))];
    if (!p) return;
    this.wrap.scrollTop = p.div.offsetTop + ratio * p.div.offsetHeight - (ratio ? 0 : 10);
    this.current = p.index;
    this.onPageChange?.(p.index);
  }

  updateCurrent(force) {
    const mid = this.wrap.scrollTop + this.wrap.clientHeight / 3;
    let cur = 0;
    for (const p of this.pages) {
      if (p.div.offsetTop <= mid) cur = p.index;
      else break;
    }
    if (cur !== this.current || force) {
      this.current = cur;
      this.onPageChange?.(cur);
    }
  }

  async renderPage(p) {
    if (p.renderedScale === this.scale || !this.pdf) return;
    const scale = this.scale;
    p.renderedScale = scale;
    p.task?.cancel();
    const dpr = window.devicePixelRatio || 1;
    const vp = p.page.getViewport({ scale: scale * dpr });
    // Render to an offscreen canvas then swap, so the page never flashes blank.
    const off = document.createElement('canvas');
    off.width = Math.floor(vp.width);
    off.height = Math.floor(vp.height);
    p.task = p.page.render({ canvasContext: off.getContext('2d'), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE });
    try {
      await p.task.promise;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.error(e);
      return;
    }
    if (p.renderedScale !== scale) return;
    off.className = 'render';
    p.canvas.replaceWith(off);
    p.canvas = off;
    await this.renderTextLayer(p);
  }

  async renderTextLayer(p) {
    p.text.innerHTML = '';
    p.textLayer?.cancel?.();
    const viewport = p.page.getViewport({ scale: this.scale });
    p.textLayer = new pdfjsLib.TextLayer({ textContentSource: p.page.streamTextContent(), container: p.text, viewport });
    try {
      await p.textLayer.render();
    } catch { return; }
    this.highlightSearch(p);
  }

  async addLinks(p) {
    const annots = await p.page.getAnnotations();
    p.annotations = annots;
    const { width, height } = p.base;
    for (const a of annots) {
      if (a.subtype !== 'Link') continue;
      const [x1, y1, x2, y2] = p.base.convertToViewportRectangle(a.rect);
      const style = {
        left: `${(Math.min(x1, x2) / width) * 100}%`, top: `${(Math.min(y1, y2) / height) * 100}%`,
        width: `${(Math.abs(x2 - x1) / width) * 100}%`, height: `${(Math.abs(y2 - y1) / height) * 100}%`,
      };
      if (a.url) {
        p.links.append(h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer', title: a.url, style }));
      } else if (a.dest) {
        p.links.append(h('a', { href: '#', title: 'Go to destination', style, onclick: (e) => { e.preventDefault(); this.goToDest(a.dest); } }));
      }
    }
  }

  async goToDest(dest) {
    try {
      const explicit = typeof dest === 'string' ? await this.pdf.getDestination(dest) : dest;
      if (!explicit) return;
      const idx = typeof explicit[0] === 'number' ? explicit[0] : await this.pdf.getPageIndex(explicit[0]);
      this.scrollToPage(idx);
    } catch (e) { console.warn('Bad destination', e); }
  }

  /** Map a client point to visual page coords (scale 1) for the page under it. */
  clientToPage(p, clientX, clientY) {
    const r = p.div.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * p.base.width, ((clientY - r.top) / r.height) * p.base.height];
  }

  pageFromElement(el) {
    const div = el?.closest?.('.page');
    return div ? this.pages[+div.dataset.index] : null;
  }

  // ---------- search ----------

  async find(query) {
    this.search = null;
    this.pages.forEach((p) => this.highlightSearch(p));
    if (!query || !this.pdf) return { total: 0 };
    const q = query.toLowerCase();
    const matches = [];
    for (const p of this.pages) {
      const tc = await p.page.getTextContent();
      let n = 0;
      for (const it of tc.items) {
        const s = (it.str || '').toLowerCase();
        for (let k = s.indexOf(q); k >= 0; k = s.indexOf(q, k + q.length)) matches.push({ page: p.index, n: n++ });
      }
    }
    this.search = { query: q, matches, cur: matches.length ? 0 : -1 };
    // Start from the first match at or after the current page.
    const start = matches.findIndex((m) => m.page >= this.current);
    if (start > 0) this.search.cur = start;
    this.pages.forEach((p) => this.highlightSearch(p));
    this.revealMatch();
    return { total: matches.length };
  }

  stepMatch(dir) {
    const s = this.search;
    if (!s?.matches.length) return;
    s.cur = (s.cur + dir + s.matches.length) % s.matches.length;
    this.pages.forEach((p) => this.highlightSearch(p));
    this.revealMatch();
  }

  revealMatch() {
    const s = this.search;
    const m = s?.matches[s.cur];
    if (!m) return;
    const p = this.pages[m.page];
    const mark = p.text.querySelector('mark.current');
    if (mark) mark.scrollIntoView({ block: 'center', inline: 'nearest' });
    else {
      this.scrollToPage(m.page);
      // The text layer may still be rendering; retry once it is.
      setTimeout(() => p.text.querySelector('mark.current')?.scrollIntoView({ block: 'center' }), 400);
    }
  }

  highlightSearch(p) {
    for (const mk of p.text.querySelectorAll('mark')) mk.replaceWith(document.createTextNode(mk.textContent));
    p.text.normalize();
    const s = this.search;
    if (!s?.matches.length) return;
    const cur = s.matches[s.cur];
    let n = 0;
    for (const span of p.text.querySelectorAll('span')) {
      if (span.children.length) continue;
      const text = span.textContent;
      const lower = text.toLowerCase();
      if (!lower.includes(s.query)) continue;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (let k = lower.indexOf(s.query); k >= 0; k = lower.indexOf(s.query, k + s.query.length)) {
        frag.append(text.slice(last, k));
        const isCur = cur && cur.page === p.index && cur.n === n;
        frag.append(h('mark', { className: isCur ? 'current' : '' }, text.slice(k, k + s.query.length)));
        last = k + s.query.length;
        n++;
      }
      frag.append(text.slice(last));
      span.textContent = '';
      span.append(frag);
    }
  }

  // ---------- hand tool ----------

  initPan() {
    let start = null;
    this.wrap.addEventListener('pointerdown', (e) => {
      if (!document.body.classList.contains('tool-pan') || e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, top: this.wrap.scrollTop, left: this.wrap.scrollLeft };
      this.wrap.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    this.wrap.addEventListener('pointermove', (e) => {
      if (!start) return;
      this.wrap.scrollTop = start.top - (e.clientY - start.y);
      this.wrap.scrollLeft = start.left - (e.clientX - start.x);
    });
    const end = () => { start = null; };
    this.wrap.addEventListener('pointerup', end);
    this.wrap.addEventListener('pointercancel', end);
  }
}
