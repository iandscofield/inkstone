// Document engine: every operation takes PDF bytes and returns new PDF bytes.
// Built on @cantoo/pdf-lib (a maintained pdf-lib fork with encryption support).
import {
  PDFDocument, StandardFonts, rgb, degrees, LineCapStyle,
  PDFName, PDFNumber, PDFString, PDFHexString, PDFRef, PDFDict, PDFArray, PDFStream,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList, PDFButton, PDFSignature,
} from '@cantoo/pdf-lib';
import { hexToRgb01 } from './ui.js';

export const APP_NAME = 'Inkstone';

// ---------- loading / saving ----------

export async function load(bytes, opts = {}) {
  return PDFDocument.load(bytes, { updateMetadata: false, ...opts });
}

/** Detect encryption; returns {encrypted}. */
export async function inspect(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  return { encrypted: doc.isEncrypted };
}

/** Decrypt an encrypted PDF with a password; returns unencrypted bytes. Throws on bad password. */
export async function decrypt(bytes, password) {
  const doc = await PDFDocument.load(bytes, { password, updateMetadata: false });
  return finalize(doc);
}

/** Drop indirect objects that are no longer reachable (e.g. removed pages, redacted content). */
export function collectGarbage(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [ctx.trailerInfo.Root, ctx.trailerInfo.Info];
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o instanceof PDFRef) {
      if (seen.has(o.tag)) continue;
      seen.add(o.tag);
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      stack.push(...o.asArray());
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!seen.has(ref.tag)) ctx.delete(ref);
}

export async function finalize(doc, { gc = true } = {}) {
  await doc.flush();
  if (gc) collectGarbage(doc);
  return doc.save({ useObjectStreams: true });
}

async function edit(bytes, fn) {
  const doc = await load(bytes);
  await fn(doc);
  return finalize(doc);
}

// ---------- geometry ----------
// "Visual" coordinates: points from the top-left of the page as displayed (rotation applied),
// identical to a pdf.js viewport at scale 1.

export function pageGeom(page) {
  const { x, y, width, height } = page.getCropBox();
  const r = (((page.getRotation().angle || 0) % 360) + 360) % 360;
  return { x0: x, y0: y, x1: x + width, y1: y + height, r, vw: r % 180 ? height : width, vh: r % 180 ? width : height };
}

export function v2p(g, vx, vy) {
  switch (g.r) {
    case 90: return [g.x0 + vy, g.y0 + vx];
    case 180: return [g.x1 - vx, g.y0 + vy];
    case 270: return [g.x1 - vy, g.y1 - vx];
    default: return [g.x0 + vx, g.y1 - vy];
  }
}

function visualRectToPdf(g, x, y, w, hgt) {
  const [ax, ay] = v2p(g, x, y);
  const [bx, by] = v2p(g, x + w, y + hgt);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

const color = (hex) => rgb(...hexToRgb01(hex || '#000000'));

/** WinAnsi-safe text for standard fonts. */
function safeText(font, s) {
  try { font.encodeText(s); return s; } catch {
    return [...s].map((ch) => { try { font.encodeText(ch); return ch; } catch { return '?'; } }).join('');
  }
}

/** Draw text whose baseline-left starts at visual (vx, vy), upright as displayed. */
function drawTextVisual(page, g, text, vx, vy, { font, size, color: c, opacity = 1, angle = 0 }) {
  const [x, y] = v2p(g, vx, vy);
  page.drawText(safeText(font, text), { x, y, size, font, color: c, opacity, rotate: degrees(g.r + angle) });
}

function pathFromVisual(g, pts, close) {
  const f = (n) => n.toFixed(2);
  return pts.map(([vx, vy], i) => {
    const [x, y] = v2p(g, vx, vy);
    return `${i ? 'L' : 'M'}${f(x)} ${f(-y)}`;
  }).join(' ') + (close ? ' Z' : '');
}

function ellipsePoints(x, y, w, hgt, n = 72) {
  const cx = x + w / 2, cy = y + hgt / 2;
  return Array.from({ length: n }, (_, i) => {
    const t = (i / n) * Math.PI * 2;
    return [cx + (w / 2) * Math.cos(t), cy + (hgt / 2) * Math.sin(t)];
  });
}

const rectPoints = (x, y, w, hgt) => [[x, y], [x + w, y], [x + w, y + hgt], [x, y + hgt]];

function dataUrlToBytes(url) {
  const [head, b64] = url.split(',');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return { bytes: out, png: head.includes('png') };
}

// ---------- annotations (flattened into page content) ----------

export const TEXT_PAD = 3;
export const LINE_HEIGHT = 1.2;

/** Draw a list of annotation objects (see annotations.js for the model) into the document. */
export async function drawAnnotations(doc, annots) {
  if (!annots.length) return;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages = doc.getPages();
  const images = new Map();

  for (const a of annots) {
    const page = pages[a.page];
    if (!page) continue;
    const g = pageGeom(page);
    const stroke = color(a.color);
    const width = a.width ?? 2;
    const opacity = a.opacity ?? 1;
    const svg = (pts, close, o = {}) => page.drawSvgPath(pathFromVisual(g, pts, close), { x: 0, y: 0, ...o });

    switch (a.type) {
      case 'rect':
      case 'ellipse': {
        const pts = a.type === 'rect' ? rectPoints(a.x, a.y, a.w, a.h) : ellipsePoints(a.x, a.y, a.w, a.h);
        const o = { borderColor: stroke, borderWidth: width, borderOpacity: opacity };
        if (a.fill) Object.assign(o, { color: color(a.fill), opacity: opacity * (a.fillOpacity ?? 1) });
        svg(pts, true, o);
        break;
      }
      case 'highlight':
        svg(rectPoints(a.x, a.y, a.w, a.h), true, { color: color(a.color), opacity: a.opacity ?? 0.4 });
        break;
      case 'underline': {
        const yy = a.strike ? a.y + a.h / 2 : a.y + a.h - width / 2;
        svg([[a.x, yy], [a.x + a.w, yy]], false, { borderColor: stroke, borderWidth: width, borderOpacity: opacity });
        break;
      }
      case 'whiteout':
        svg(rectPoints(a.x, a.y, a.w, a.h), true, { color: color(a.fill || '#ffffff') });
        break;
      case 'redact':
        svg(rectPoints(a.x, a.y, a.w, a.h), true, { color: rgb(0, 0, 0) });
        break;
      case 'line':
      case 'arrow': {
        const o = { borderColor: stroke, borderWidth: width, borderOpacity: opacity, borderLineCap: LineCapStyle.Round };
        svg([[a.x1, a.y1], [a.x2, a.y2]], false, o);
        if (a.type === 'arrow') for (const p of arrowHead(a, width)) svg([p, [a.x2, a.y2]], false, o);
        break;
      }
      case 'ink':
        if (a.points.length > 1) svg(a.points, false, { borderColor: stroke, borderWidth: width, borderOpacity: opacity, borderLineCap: LineCapStyle.Round });
        break;
      case 'text': {
        if (a.fill) svg(rectPoints(a.x, a.y, a.w, a.h), true, { color: color(a.fill) });
        const size = a.fontSize || 12;
        a.text.split('\n').forEach((line, i) => {
          drawTextVisual(page, g, line, a.x + TEXT_PAD, a.y + TEXT_PAD + size * 0.85 + i * size * LINE_HEIGHT, { font, size, color: stroke, opacity });
        });
        break;
      }
      case 'stamp': {
        svg(rectPoints(a.x, a.y, a.w, a.h), true, { borderColor: stroke, borderWidth: 3, borderOpacity: opacity });
        const text = safeText(bold, a.text);
        const size = Math.min(a.h * 0.55, (a.w - 12) / Math.max(1, bold.widthOfTextAtSize(text, 1)));
        const tw = bold.widthOfTextAtSize(text, size);
        drawTextVisual(page, g, text, a.x + (a.w - tw) / 2, a.y + a.h / 2 + size * 0.36, { font: bold, size, color: stroke, opacity });
        break;
      }
      case 'image': {
        let img = images.get(a.src);
        if (!img) {
          const { bytes, png } = dataUrlToBytes(a.src);
          img = png ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          images.set(a.src, img);
        }
        const [x, y] = v2p(g, a.x, a.y + a.h);
        page.drawImage(img, { x, y, width: a.w, height: a.h, rotate: degrees(g.r), opacity });
        break;
      }
      case 'note':
        addNoteAnnotation(doc, page, g, a);
        break;
    }
  }
}

export function arrowHead(a, width = 2) {
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const len = 8 + width * 2.5;
  return [-0.45, 0.45].map((d) => [a.x2 - len * Math.cos(ang + d), a.y2 - len * Math.sin(ang + d)]);
}

/** Sticky notes become real PDF comment annotations so other viewers show them as comments. */
function addNoteAnnotation(doc, page, g, a) {
  const [x, y] = v2p(g, a.x, a.y);
  const [r, gg, b] = hexToRgb01(a.color || '#f6c026');
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Text',
    Rect: [x, y - 20, x + 20, y],
    Contents: PDFHexString.fromText(a.text || ''),
    T: PDFHexString.fromText(a.author || 'Inkstone'),
    M: PDFString.fromDate(new Date()),
    Name: 'Comment',
    C: [r, gg, b],
    F: 4,
    Open: false,
    InkstoneNote: true,
  });
  page.node.addAnnot(doc.context.register(annot));
}

export async function applyAnnotations(bytes, annots) {
  return edit(bytes, (doc) => drawAnnotations(doc, annots));
}

// ---------- editable markup round-trip ----------
// On save, markup is drawn into each page (so every PDF reader shows it) and the
// editable objects are stored alongside, together with the content streams that
// hold the drawing. On open, those streams are removed and the objects restored.

const MARKUP_KEY = PDFName.of('InkstoneMarkup');
const STREAMS_KEY = PDFName.of('InkstoneStreams');
const CONTENTS = PDFName.of('Contents');

function contentRefs(page) {
  const c = page.node.get(CONTENTS);
  if (c instanceof PDFRef) return [c];
  if (c instanceof PDFArray) return c.asArray().filter((x) => x instanceof PDFRef);
  return [];
}

export async function saveEditableAnnotations(bytes, annots) {
  const list = annots.filter((a) => a.type !== 'redact');
  const doc = await load(bytes);
  const pages = doc.getPages();
  const byPage = new Map();
  for (const a of list) if (pages[a.page]) byPage.set(a.page, [...(byPage.get(a.page) || []), a]);
  const before = new Map([...byPage.keys()].map((i) => [i, new Set(contentRefs(pages[i]).map((r) => r.tag))]));
  await drawAnnotations(doc, list);
  await doc.flush();
  for (const [i, items] of byPage) {
    const page = pages[i];
    const added = contentRefs(page).filter((r) => !before.get(i).has(r.tag));
    page.node.set(STREAMS_KEY, doc.context.obj(added));
    page.node.set(MARKUP_KEY, PDFHexString.fromText(JSON.stringify(items.map(({ page: _p, ...rest }) => rest))));
  }
  return finalize(doc);
}

/** Returns {bytes, annots}: bytes with Inkstone's drawn markup removed, and the editable objects. */
export async function extractEditableAnnotations(bytes) {
  const doc = await load(bytes);
  const annots = [];
  let changed = false;
  doc.getPages().forEach((page, i) => {
    const raw = page.node.get(MARKUP_KEY);
    if (!raw) return;
    changed = true;
    const streams = page.node.lookupMaybe(STREAMS_KEY, PDFArray)?.asArray().filter((x) => x instanceof PDFRef) || [];
    page.node.delete(MARKUP_KEY);
    page.node.delete(STREAMS_KEY);
    const contents = page.node.get(CONTENTS);
    const tags = new Set(contentRefs(page).map((r) => r.tag));
    // If another program rewrote the page, the drawing can't be separated safely: keep it flattened.
    if (!(contents instanceof PDFArray) || !streams.every((r) => tags.has(r.tag))) return;
    let items;
    try { items = JSON.parse(raw.decodeText()); } catch { return; }
    const drop = new Set(streams.map((r) => r.tag));
    page.node.set(CONTENTS, doc.context.obj(contents.asArray().filter((x) => !(x instanceof PDFRef && drop.has(x.tag)))));
    // Sticky notes are restored from the saved objects, so drop the comment annotations written for them.
    const arr = page.node.Annots();
    if (arr) {
      for (let j = arr.size() - 1; j >= 0; j--) {
        if (arr.lookupMaybe(j, PDFDict)?.get(PDFName.of('InkstoneNote'))) arr.remove(j);
      }
    }
    for (const a of items) annots.push({ ...a, page: i });
  });
  if (!changed) return { bytes, annots };
  return { bytes: await finalize(doc), annots };
}

// ---------- page organization ----------

export const rotatePages = (bytes, indices, delta) =>
  edit(bytes, (doc) => {
    const pages = doc.getPages();
    for (const i of indices) {
      const p = pages[i];
      p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360));
    }
  });

export const deletePages = (bytes, indices) =>
  edit(bytes, (doc) => {
    if (indices.length >= doc.getPageCount()) throw new Error('A document must keep at least one page.');
    [...indices].sort((a, b) => b - a).forEach((i) => doc.removePage(i));
  });

/** `order` lists old page indices in their new order. */
export const reorderPages = (bytes, order) =>
  edit(bytes, (doc) => {
    // Flatten the page tree into a single Kids array in the new order, pushing
    // inherited attributes down to each leaf first so nothing is lost.
    const pages = doc.getPages();
    const rootRef = doc.catalog.get(PDFName.of('Pages'));
    const root = doc.catalog.Pages();
    for (const p of pages) {
      for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
        const k = PDFName.of(key);
        if (!p.node.get(k)) {
          const v = p.node.getInheritableAttribute(k);
          if (v) p.node.set(k, v);
        }
      }
      p.node.set(PDFName.of('Parent'), rootRef);
    }
    root.set(PDFName.of('Kids'), doc.context.obj(order.map((i) => pages[i].ref)));
    root.set(PDFName.of('Count'), PDFNumber.of(order.length));
    doc.pageCache?.invalidate?.();
  });

export const duplicatePages = (bytes, indices) =>
  edit(bytes, async (doc) => {
    const sorted = [...indices].sort((a, b) => b - a);
    for (const i of sorted) {
      const [copy] = await doc.copyPages(doc, [i]);
      doc.insertPage(i + 1, copy);
    }
  });

export const insertBlankPage = (bytes, at, size) =>
  edit(bytes, (doc) => {
    const ref = doc.getPage(Math.max(0, Math.min(at - 1, doc.getPageCount() - 1)));
    const g = ref ? pageGeom(ref) : null;
    doc.insertPage(at, size || (g ? [g.vw, g.vh] : [612, 792]));
  });

export async function createBlank(size = [612, 792], count = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage(size);
  doc.setProducer(APP_NAME);
  return doc.save();
}

/** Insert all pages of `other` (PDF bytes) at index `at`. */
export const insertDocument = (bytes, otherBytes, at) =>
  edit(bytes, async (doc) => {
    const src = await load(otherBytes);
    const copies = await doc.copyPages(src, src.getPageIndices());
    copies.forEach((p, i) => doc.insertPage(at + i, p));
  });

export async function extractPages(bytes, indices) {
  const src = await load(bytes);
  const out = await PDFDocument.create();
  const copies = await out.copyPages(src, indices);
  copies.forEach((p) => out.addPage(p));
  out.setTitle(src.getTitle() || '');
  out.setProducer(APP_NAME);
  return out.save({ useObjectStreams: true });
}

export async function imagesToPdf(images) {
  const doc = await PDFDocument.create();
  for (const { bytes, type } of images) {
    const img = type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const scale = 0.75; // 96 dpi pixels -> points
    const page = doc.addPage([img.width * scale, img.height * scale]);
    page.drawImage(img, { x: 0, y: 0, width: img.width * scale, height: img.height * scale });
  }
  doc.setProducer(APP_NAME);
  return doc.save();
}

/** Margins are in visual points: {top, right, bottom, left}. */
export const cropPages = (bytes, indices, m) =>
  edit(bytes, (doc) => {
    const pages = doc.getPages();
    for (const i of indices) {
      const g = pageGeom(pages[i]);
      const r = visualRectToPdf(g, m.left, m.top, g.vw - m.left - m.right, g.vh - m.top - m.bottom);
      if (r.width < 10 || r.height < 10) throw new Error('Margins are larger than the page.');
      pages[i].setCropBox(r.x, r.y, r.width, r.height);
    }
  });

/** Replace a page with a raster image (PNG/JPEG bytes) covering the visual page. */
export const rasterizePages = (bytes, replacements) =>
  edit(bytes, async (doc) => {
    for (const { index, image, png, vw, vh } of replacements) {
      const img = png ? await doc.embedPng(image) : await doc.embedJpg(image);
      const page = doc.insertPage(index, [vw, vh]);
      page.drawImage(img, { x: 0, y: 0, width: vw, height: vh });
      doc.removePage(index + 1);
    }
  });

// ---------- stamping: watermark / header & footer / Bates ----------

const FONTS = { Helvetica: StandardFonts.Helvetica, 'Helvetica-Bold': StandardFonts.HelveticaBold, 'Times-Roman': StandardFonts.TimesRoman, Courier: StandardFonts.Courier };

export const addWatermark = (bytes, indices, o) =>
  edit(bytes, async (doc) => {
    const font = await doc.embedFont(FONTS[o.font] || StandardFonts.HelveticaBold);
    const pages = doc.getPages();
    const text = safeText(font, o.text);
    for (const i of indices) {
      const page = pages[i];
      const g = pageGeom(page);
      const size = o.fontSize;
      const tw = font.widthOfTextAtSize(text, size);
      const th = font.heightAtSize(size, { descender: false }) * 0.7;
      // Center the rotated text on the visual page centre.
      const t = (o.angle * Math.PI) / 180;
      const vx = g.vw / 2 - (tw / 2) * Math.cos(t) - (th / 2) * Math.sin(t);
      const vy = g.vh / 2 + (tw / 2) * Math.sin(t) - (th / 2) * Math.cos(t) + th;
      drawTextVisual(page, g, text, vx, vy, { font, size, color: color(o.color), opacity: o.opacity, angle: o.angle });
    }
  });

function fillTokens(tpl, ctx) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in ctx ? ctx[k] : m));
}

/**
 * o: {topLeft, topCenter, topRight, bottomLeft, bottomCenter, bottomRight, fontSize, color, margin, start, font}
 * Tokens: {page} {total} {date} {title} {bates}
 */
export const addHeaderFooter = (bytes, indices, o) =>
  edit(bytes, async (doc) => {
    const font = await doc.embedFont(FONTS[o.font] || StandardFonts.Helvetica);
    const pages = doc.getPages();
    const total = indices.length;
    const date = new Date().toLocaleDateString();
    const title = doc.getTitle() || o.fileName || '';
    indices.forEach((pi, n) => {
      const page = pages[pi];
      const g = pageGeom(page);
      const ctx = {
        page: (o.start ?? 1) + n, total, date, title,
        bates: `${o.batesPrefix || ''}${String((o.batesStart ?? 1) + n).padStart(o.batesDigits || 6, '0')}${o.batesSuffix || ''}`,
      };
      const size = o.fontSize || 10;
      const m = o.margin ?? 30;
      const slots = [
        ['topLeft', 'l', m + size], ['topCenter', 'c', m + size], ['topRight', 'r', m + size],
        ['bottomLeft', 'l', g.vh - m], ['bottomCenter', 'c', g.vh - m], ['bottomRight', 'r', g.vh - m],
      ];
      for (const [key, align, vy] of slots) {
        if (!o[key]) continue;
        const text = safeText(font, fillTokens(o[key], ctx));
        const tw = font.widthOfTextAtSize(text, size);
        const vx = align === 'l' ? m : align === 'c' ? (g.vw - tw) / 2 : g.vw - m - tw;
        drawTextVisual(page, g, text, vx, vy, { font, size, color: color(o.color) });
      }
    });
  });

// ---------- OCR text layer ----------

/** words: [{text, x, y, w, h}] in visual points. Adds invisible, selectable/searchable text. */
export const addInvisibleText = (bytes, pageWords) =>
  edit(bytes, async (doc) => {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const pages = doc.getPages();
    for (const { index, words } of pageWords) {
      const page = pages[index];
      const g = pageGeom(page);
      for (const w of words) {
        const text = safeText(font, w.text);
        if (!text.trim()) continue;
        const unit = font.widthOfTextAtSize(text, 1);
        const size = Math.max(1, Math.min(w.h * 1.4, w.w / Math.max(unit, 0.01)));
        drawTextVisual(page, g, text, w.x, w.y + w.h * 0.85, { font, size, color: rgb(0, 0, 0), opacity: 0 });
      }
    }
  });

// ---------- forms ----------

function fieldType(f) {
  if (f instanceof PDFTextField) return 'text';
  if (f instanceof PDFCheckBox) return 'checkbox';
  if (f instanceof PDFDropdown) return 'dropdown';
  if (f instanceof PDFOptionList) return 'list';
  if (f instanceof PDFRadioGroup) return 'radio';
  if (f instanceof PDFButton) return 'button';
  if (f instanceof PDFSignature) return 'signature';
  return 'unknown';
}

export async function getFormFields(bytes) {
  const doc = await load(bytes);
  return doc.getForm().getFields().map((f) => {
    const type = fieldType(f);
    const out = { name: f.getName(), type, readOnly: f.isReadOnly(), required: f.isRequired() };
    try {
      if (type === 'text') Object.assign(out, { value: f.getText() || '', multiline: f.isMultiline() });
      else if (type === 'checkbox') out.value = f.isChecked();
      else if (type === 'dropdown' || type === 'list') Object.assign(out, { value: f.getSelected()[0] || '', options: f.getOptions() });
      else if (type === 'radio') Object.assign(out, { value: f.getSelected() || '', options: f.getOptions() });
    } catch { /* malformed field */ }
    return out;
  });
}

export const setFormFields = (bytes, values) =>
  edit(bytes, (doc) => {
    const form = doc.getForm();
    for (const [name, v] of Object.entries(values)) {
      const f = form.getFieldMaybe(name);
      if (!f) continue;
      const type = fieldType(f);
      if (type === 'text') f.setText(v || undefined);
      else if (type === 'checkbox') v ? f.check() : f.uncheck();
      else if ((type === 'dropdown' || type === 'list' || type === 'radio') && v) f.select(v);
      else if (type === 'radio' && !v) f.clear();
    }
  });

export const flattenForm = (bytes) => edit(bytes, (doc) => doc.getForm().flatten());

/**
 * type: text | checkbox | dropdown | radio. extra: {options: string[]} for dropdowns,
 * {value} for a radio button (buttons sharing a name form one group).
 */
export const addFormField = (bytes, pageIndex, type, name, rect, extra = {}) =>
  edit(bytes, (doc) => {
    const form = doc.getForm();
    const existing = form.getFieldMaybe(name);
    if (existing && !(type === 'radio' && existing instanceof PDFRadioGroup)) throw new Error(`A field named "${name}" already exists.`);
    const page = doc.getPage(pageIndex);
    const g = pageGeom(page);
    const r = visualRectToPdf(g, rect.x, rect.y, rect.w, rect.h);
    const opts = { ...r, borderColor: rgb(0.3, 0.4, 0.7), borderWidth: 1, backgroundColor: rgb(0.93, 0.95, 1), rotate: degrees(g.r) };
    if (type === 'checkbox') form.createCheckBox(name).addToPage(page, opts);
    else if (type === 'dropdown') {
      const dd = form.createDropdown(name);
      dd.addOptions(extra.options?.length ? extra.options : ['Option 1']);
      dd.addToPage(page, opts);
    } else if (type === 'radio') {
      const group = existing || form.createRadioGroup(name);
      const value = extra.value || `Choice ${group.getOptions().length + 1}`;
      if (group.getOptions().includes(value)) throw new Error(`Group "${name}" already has a choice "${value}".`);
      group.addOptionToPage(value, page, opts);
    } else {
      const tf = form.createTextField(name);
      if (rect.h > 40) tf.enableMultiline();
      tf.addToPage(page, opts);
    }
  });

/** changes: {[name]: {required, readOnly, remove, options, rename}} */
export const updateFormFields = (bytes, changes) =>
  edit(bytes, (doc) => {
    const form = doc.getForm();
    for (const [name, c] of Object.entries(changes)) {
      const f = form.getFieldMaybe(name);
      if (!f) continue;
      if (c.remove) { form.removeField(f); continue; }
      if (c.required != null) c.required ? f.enableRequired() : f.disableRequired();
      if (c.readOnly != null) c.readOnly ? f.enableReadOnly() : f.disableReadOnly();
      if (c.options && (f instanceof PDFDropdown || f instanceof PDFOptionList)) f.setOptions(c.options);
      if (c.rename && c.rename !== name) {
        if (form.getFieldMaybe(c.rename)) throw new Error(`A field named "${c.rename}" already exists.`);
        f.acroField.setPartialName(c.rename);
      }
    }
  });

// ---------- hidden data ----------

/**
 * Remove information a reader doesn't see on the page: document properties, XMP
 * metadata, embedded files, scripts and automatic actions.
 */
export const scrubHiddenData = (bytes) =>
  edit(bytes, (doc) => {
    const cat = doc.catalog;
    for (const k of ['Metadata', 'OpenAction', 'AA', 'PieceInfo', 'SpiderInfo', 'Threads', 'Collection']) cat.delete(PDFName.of(k));
    const names = cat.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (names) for (const k of ['EmbeddedFiles', 'JavaScript']) names.delete(PDFName.of(k));
    doc.context.trailerInfo.Info = doc.context.register(doc.context.obj({}));
    for (const page of doc.getPages()) {
      for (const k of ['AA', 'PieceInfo', 'Metadata']) page.node.delete(PDFName.of(k));
      const arr = page.node.Annots();
      if (!arr) continue;
      for (let j = arr.size() - 1; j >= 0; j--) {
        const a = arr.lookupMaybe(j, PDFDict);
        const sub = a?.get(PDFName.of('Subtype'))?.toString();
        if (sub === '/FileAttachment' || sub === '/Sound' || sub === '/Movie') arr.remove(j);
        else if (a) { a.delete(PDFName.of('AA')); if (a.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('S'))?.toString() === '/JavaScript') a.delete(PDFName.of('A')); }
      }
    }
  });

// ---------- certificate signature appearance ----------

/**
 * Draw the visible part of a digital signature into the page: an optional handwritten
 * signature image plus "Digitally signed by …" details. Returns the bytes and the
 * widget rectangle in PDF space for the signature field.
 */
export async function drawSignatureAppearance(bytes, pageIndex, rect, { name, date, reason, location, image }) {
  let widgetRect;
  const out = await edit(bytes, async (doc) => {
    const page = doc.getPage(pageIndex);
    const g = pageGeom(page);
    const r = visualRectToPdf(g, rect.x, rect.y, rect.w, rect.h);
    widgetRect = [r.x, r.y, r.x + r.width, r.y + r.height];
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const pad = Math.min(6, rect.h * 0.08);
    let textX = rect.x + pad;
    let textW = rect.w - pad * 2;
    if (image) {
      const { bytes: imgBytes, png } = dataUrlToBytes(image);
      const img = png ? await doc.embedPng(imgBytes) : await doc.embedJpg(imgBytes);
      const boxW = rect.w * 0.45 - pad;
      const boxH = rect.h - pad * 2;
      const s = Math.min(boxW / img.width, boxH / img.height);
      const w = img.width * s, hgt = img.height * s;
      const ix = rect.x + pad + (boxW - w) / 2, iy = rect.y + pad + (boxH - hgt) / 2;
      const [x, y] = v2p(g, ix, iy + hgt);
      page.drawImage(img, { x, y, width: w, height: hgt, rotate: degrees(g.r) });
      textX = rect.x + rect.w * 0.45 + pad;
      textW = rect.w * 0.55 - pad * 2;
    }
    const lines = [
      { t: 'Digitally signed by', f: font, k: 0.8 },
      { t: name, f: bold, k: 1.15 },
      { t: `Date: ${date}`, f: font, k: 0.8 },
      ...(reason ? [{ t: `Reason: ${reason}`, f: font, k: 0.8 }] : []),
      ...(location ? [{ t: `Location: ${location}`, f: font, k: 0.8 }] : []),
    ].map((l) => ({ ...l, t: safeText(l.f, l.t) }));
    const units = lines.reduce((n, l) => n + l.k * 1.25, 0);
    // Fit both the box height and the widest line.
    let size = (rect.h - pad * 2) / units;
    for (const l of lines) size = Math.min(size, textW / Math.max(1, l.f.widthOfTextAtSize(l.t, l.k)));
    let y = rect.y + pad + ((rect.h - pad * 2) - units * size) / 2;
    const ink = rgb(0.1, 0.14, 0.35);
    for (const l of lines) {
      y += l.k * size * 1.25;
      drawTextVisual(page, g, l.t, textX, y - l.k * size * 0.3, { font: l.f, size: l.k * size, color: ink });
    }
  });
  return { bytes: out, widgetRect };
}

/** A visual rectangle on a page as [x1, y1, x2, y2] in PDF user space. */
export async function pdfRectFor(bytes, pageIndex, rect) {
  const doc = await load(bytes);
  const r = visualRectToPdf(pageGeom(doc.getPage(pageIndex)), rect.x, rect.y, rect.w, rect.h);
  return [r.x, r.y, r.x + r.width, r.y + r.height];
}

/** True if the document already contains a certificate signature. */
export function hasDigitalSignature(bytes) {
  // ByteRange only appears in signature dictionaries; scanning raw bytes avoids a full parse.
  const needle = [47, 66, 121, 116, 101, 82, 97, 110, 103, 101]; // "/ByteRange"
  outer: for (let i = 0; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

// ---------- links ----------

/** target: {url} or {page} (0-based). */
export const addLink = (bytes, pageIndex, rect, target) =>
  edit(bytes, (doc) => {
    const page = doc.getPage(pageIndex);
    const r = visualRectToPdf(pageGeom(page), rect.x, rect.y, rect.w, rect.h);
    const dict = { Type: 'Annot', Subtype: 'Link', Rect: [r.x, r.y, r.x + r.width, r.y + r.height], Border: [0, 0, 0], F: 4 };
    if (target.url) dict.A = doc.context.obj({ S: 'URI', URI: PDFString.of(target.url) });
    else dict.Dest = doc.context.obj([doc.getPage(target.page).ref, 'Fit']);
    page.node.addAnnot(doc.context.register(doc.context.obj(dict)));
  });

/** Remove every link annotation on the given pages. */
export const removeLinks = (bytes, indices) =>
  edit(bytes, (doc) => {
    for (const i of indices) {
      const arr = doc.getPage(i).node.Annots();
      if (!arr) continue;
      for (let j = arr.size() - 1; j >= 0; j--) {
        if (arr.lookupMaybe(j, PDFDict)?.get(PDFName.of('Subtype'))?.toString() === '/Link') arr.remove(j);
      }
    }
  });

// ---------- bookmarks ----------

/** Replace the document outline. tree: [{title, page?, url?, children?}] */
export const setOutline = (bytes, tree) =>
  edit(bytes, (doc) => {
    const ctx = doc.context;
    const pageRefs = doc.getPages().map((p) => p.ref);
    const outlinesKey = PDFName.of('Outlines');
    if (!tree.length) { doc.catalog.delete(outlinesKey); return; }
    const count = (items) => items.reduce((n, it) => n + 1 + count(it.children || []), 0);
    const build = (items, parentRef) => {
      const refs = items.map(() => ctx.nextRef());
      items.forEach((it, i) => {
        const dict = { Title: PDFHexString.fromText(it.title || 'Untitled'), Parent: parentRef };
        if (i > 0) dict.Prev = refs[i - 1];
        if (i < refs.length - 1) dict.Next = refs[i + 1];
        if (it.url) dict.A = ctx.obj({ S: 'URI', URI: PDFString.of(it.url) });
        else if (pageRefs[it.page]) dict.Dest = ctx.obj([pageRefs[it.page], 'Fit']);
        if (it.children?.length) {
          const [first, last] = build(it.children, refs[i]);
          Object.assign(dict, { First: first, Last: last, Count: count(it.children) });
        }
        ctx.assign(refs[i], ctx.obj(dict));
      });
      return [refs[0], refs[refs.length - 1]];
    };
    const rootRef = ctx.nextRef();
    const [first, last] = build(tree, rootRef);
    ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: count(tree) }));
    doc.catalog.set(outlinesKey, rootRef);
  });

// ---------- metadata & security ----------

export async function getMetadata(bytes) {
  const doc = await load(bytes);
  return {
    title: doc.getTitle() || '', author: doc.getAuthor() || '', subject: doc.getSubject() || '',
    keywords: doc.getKeywords() || '', creator: doc.getCreator() || '', producer: doc.getProducer() || '',
    created: doc.getCreationDate()?.toLocaleString() || '', modified: doc.getModificationDate()?.toLocaleString() || '',
    pages: doc.getPageCount(),
  };
}

export const setMetadata = (bytes, m) =>
  edit(bytes, (doc) => {
    doc.setTitle(m.title, { showInWindowTitleBar: true });
    doc.setAuthor(m.author);
    doc.setSubject(m.subject);
    doc.setKeywords(m.keywords.split(/[,;]\s*/).filter(Boolean));
    doc.setCreator(m.creator);
  });

/** Final output for Save: stamp modification date, optionally encrypt. */
export async function prepareForSave(bytes, security) {
  const doc = await load(bytes);
  doc.setModificationDate(new Date());
  doc.setProducer(`${APP_NAME} (open source)`);
  if (security) {
    await doc.flush();
    collectGarbage(doc);
    doc.encrypt({
      userPassword: security.userPassword || '',
      ownerPassword: security.ownerPassword || security.userPassword,
      permissions: security.permissions,
    });
    return doc.save({ useObjectStreams: true });
  }
  return finalize(doc);
}

export { PDFName };
