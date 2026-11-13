// Document engine: every operation takes PDF bytes and returns new PDF bytes.
// Built on @cantoo/pdf-lib (a maintained pdf-lib fork with encryption support).
import {
  PDFDocument, StandardFonts, rgb, degrees, LineCapStyle,
  PDFName, PDFNumber, PDFString, PDFHexString, PDFRef, PDFDict, PDFArray, PDFStream, PDFRawStream,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList, PDFButton, PDFSignature,
  decodePDFRawStream,
} from '@cantoo/pdf-lib';
import { hexToRgb01 } from './ui.js';
import { findTextOps, opsOnLine } from './contentstream.js';

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

// ---------- PDF/A-2b ----------

/** A small sRGB-like ICC v2 display profile (D50, sRGB primaries, gamma 2.2) for the output intent. */
function srgbIccProfile() {
  const enc = (s) => [...s].map((c) => c.charCodeAt(0));
  const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const s15 = (v) => u32(Math.round(v * 65536) >>> 0);
  const pad4 = (a) => { while (a.length % 4) a.push(0); return a; };
  const desc = (text) => pad4([...enc('desc'), 0, 0, 0, 0, ...u32(text.length + 1), ...enc(text), 0, ...u32(0), ...u32(0), 0, 0, 0, ...new Array(67).fill(0)]);
  const xyz = (x, y, z) => [...enc('XYZ '), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)];
  const curv = [...enc('curv'), 0, 0, 0, 0, ...u32(1), 0x02, 0x33, 0, 0];
  const text = (t) => pad4([...enc('text'), 0, 0, 0, 0, ...enc(t), 0]);
  const tags = [
    ['desc', desc('sRGB (Inkstone)')], ['cprt', text('No copyright, use freely')], ['wtpt', xyz(0.9642, 1, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)], ['gXYZ', xyz(0.3851, 0.7169, 0.0971)], ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', curv], ['gTRC', curv], ['bTRC', curv],
  ];
  let offset = 128 + 4 + tags.length * 12;
  const table = [...u32(tags.length)];
  const data = [];
  for (const [sig, bytes] of tags) {
    table.push(...enc(sig), ...u32(offset), ...u32(bytes.length));
    data.push(...bytes);
    offset += bytes.length;
  }
  const header = [
    ...u32(offset), ...u32(0), 0x02, 0x10, 0, 0, ...enc('mntr'), ...enc('RGB '), ...enc('XYZ '),
    0, 0x07, 0, 0x01, 0, 0x01, 0, 0, 0, 0, 0, 0, // date 2025-01-01
    ...enc('acsp'), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0),
    ...s15(0.9642), ...s15(1), ...s15(0.8249), ...u32(0),
  ];
  while (header.length < 128) header.push(0);
  return new Uint8Array([...header, ...table, ...data]);
}

const xmlEscape = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

/** Write PDF/A-2b XMP metadata matching the document information dictionary. */
function writePdfAMetadata(doc) {
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  const created = doc.getCreationDate() ? new Date(Math.floor(doc.getCreationDate().getTime() / 1000) * 1000) : now;
  doc.setCreationDate(created);
  doc.setModificationDate(now);
  doc.setProducer(APP_NAME);
  doc.setCreator(doc.getCreator() || APP_NAME);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const title = doc.getTitle(), author = doc.getAuthor(), subject = doc.getSubject(), keywords = doc.getKeywords();
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
<dc:format>application/pdf</dc:format>
${title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title>` : ''}
${author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>` : ''}
${subject ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(subject)}</rdf:li></rdf:Alt></dc:description>` : ''}
${keywords ? `<pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>` : ''}
<pdf:Producer>${APP_NAME}</pdf:Producer>
<xmp:CreatorTool>${xmlEscape(doc.getCreator())}</xmp:CreatorTool>
<xmp:CreateDate>${iso(created)}</xmp:CreateDate><xmp:ModifyDate>${iso(now)}</xmp:ModifyDate><xmp:MetadataDate>${iso(now)}</xmp:MetadataDate>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const bytes = new TextEncoder().encode(xmp);
  const stream = doc.context.stream(bytes, { Type: 'Metadata', Subtype: 'XML', Length: bytes.length });
  doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
}

function hasPdfAMetadata(doc) {
  const m = doc.catalog.lookupMaybe(PDFName.of('Metadata'), PDFStream);
  if (!m) return false;
  try {
    const raw = m instanceof PDFRawStream ? decodePDFRawStream(m).decode() : m.getContents();
    return new TextDecoder().decode(raw).includes('pdfaid:part');
  } catch { return false; }
}

/** Font names used without embedded font programs, walking forms and annotation appearances. */
function nonEmbeddedFonts(doc, resources, seen = new Set()) {
  const out = new Set();
  if (!(resources instanceof PDFDict) || seen.has(resources)) return out;
  seen.add(resources);
  const fonts = resources.lookupMaybe(PDFName.of('Font'), PDFDict);
  for (const [, ref] of fonts?.entries() || []) {
    const f = doc.context.lookup(ref);
    if (!(f instanceof PDFDict) || f.get(PDFName.of('Subtype'))?.toString() === '/Type3') continue;
    const target = f.get(PDFName.of('Subtype'))?.toString() === '/Type0' ? f.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict) : f;
    const fd = target?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict);
    if (!fd || !['FontFile', 'FontFile2', 'FontFile3'].some((k) => fd.get(PDFName.of(k)))) {
      out.add((f.get(PDFName.of('BaseFont'))?.toString() || '/unknown').slice(1).replace(/^[A-Z]{6}\+/, ''));
    }
  }
  const xobjects = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  for (const [, ref] of xobjects?.entries() || []) {
    const x = doc.context.lookup(ref);
    if (x instanceof PDFStream && x.dict.get(PDFName.of('Subtype'))?.toString() === '/Form') {
      for (const n of nonEmbeddedFonts(doc, x.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), seen)) out.add(n);
    }
  }
  return out;
}

const AP_EXEMPT = new Set(['/Link', '/Popup']);

/**
 * Check what stands between a document and PDF/A-2b.
 * Returns {fonts: [{page, names}], scripts, attachments, annotsNoAppearance, needAppearances, isPdfA}
 */
export async function pdfaPreflight(bytes) {
  const doc = await load(bytes);
  const fonts = [];
  let annotsNoAppearance = 0;
  doc.getPages().forEach((page, i) => {
    const names = nonEmbeddedFonts(doc, page.node.Resources());
    for (const a of page.node.Annots()?.asArray() || []) {
      const d = doc.context.lookup(a);
      if (!(d instanceof PDFDict) || AP_EXEMPT.has(d.get(PDFName.of('Subtype'))?.toString())) continue;
      const ap = d.lookupMaybe(PDFName.of('AP'), PDFDict);
      const n = ap?.lookup(PDFName.of('N'));
      if (!n) { annotsNoAppearance++; continue; }
      const streams = n instanceof PDFStream ? [n] : n instanceof PDFDict ? n.entries().map(([, r]) => doc.context.lookup(r)) : [];
      for (const s of streams) if (s instanceof PDFStream) for (const fn of nonEmbeddedFonts(doc, s.dict.lookupMaybe(PDFName.of('Resources'), PDFDict))) names.add(fn);
    }
    if (names.size) fonts.push({ page: i, names: [...names] });
  });
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  return {
    fonts,
    scripts: !!(names?.get(PDFName.of('JavaScript')) || doc.catalog.get(PDFName.of('OpenAction')) || doc.catalog.get(PDFName.of('AA'))),
    attachments: !!names?.get(PDFName.of('EmbeddedFiles')),
    annotsNoAppearance,
    needAppearances: acro?.get(PDFName.of('NeedAppearances'))?.toString() === 'true',
    isPdfA: hasPdfAMetadata(doc),
  };
}

/**
 * Apply the automatic PDF/A-2b fixes. Pages with non-embedded fonts must already have
 * been rasterized by the caller.
 */
export const convertToPdfA = (bytes) =>
  edit(bytes, (doc) => {
    // Scripts, automatic actions and attachments aren't allowed (document properties are kept).
    for (const k of ['OpenAction', 'AA']) doc.catalog.delete(PDFName.of(k));
    const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (names) for (const k of ['JavaScript', 'EmbeddedFiles']) names.delete(PDFName.of(k));
    for (const page of doc.getPages()) {
      page.node.delete(PDFName.of('AA'));
      const arr = page.node.Annots();
      if (!arr) continue;
      for (let j = arr.size() - 1; j >= 0; j--) {
        const d = arr.lookupMaybe(j, PDFDict);
        if (!d) continue;
        const sub = d.get(PDFName.of('Subtype'))?.toString();
        if (sub === '/FileAttachment' || sub === '/Sound' || sub === '/Movie') { arr.remove(j); continue; }
        if (d.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('S'))?.toString() === '/JavaScript') d.delete(PDFName.of('A'));
        if (!AP_EXEMPT.has(sub) && !d.lookupMaybe(PDFName.of('AP'), PDFDict)?.get(PDFName.of('N'))) { arr.remove(j); continue; }
        // Annotations must print and may not be hidden.
        const flags = d.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() || 0;
        d.set(PDFName.of('F'), PDFNumber.of((flags | 4) & ~(1 | 2 | 32)));
        d.delete(PDFName.of('AA'));
      }
    }
    doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)?.delete(PDFName.of('NeedAppearances'));
    const icc = doc.context.register(doc.context.flateStream(srgbIccProfile(), { N: 3 }));
    doc.catalog.set(PDFName.of('OutputIntents'), doc.context.obj([doc.context.obj({
      Type: 'OutputIntent', S: 'GTS_PDFA1', OutputConditionIdentifier: PDFString.of('sRGB IEC61966-2.1'), Info: PDFString.of('sRGB IEC61966-2.1'), DestOutputProfile: icc,
    })]));
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    doc.context.trailerInfo.ID = doc.context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
    writePdfAMetadata(doc);
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

// ---------- real text editing ----------

/** The page's content streams decoded and joined, as a latin1 string (one char per byte). */
function pageContentString(doc, page) {
  const parts = [];
  for (const ref of contentRefs(page)) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFStream)) continue;
    const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents?.() || new Uint8Array();
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    parts.push(s);
  }
  return parts.join('\n');
}

/** Glyph-width lookup for the fonts in a page's resources (enough to follow text positions). */
function fontInfoFor(page) {
  const fonts = page.node.Resources()?.lookupMaybe(PDFName.of('Font'), PDFDict);
  const cache = new Map();
  const num = (x) => (x && typeof x.asNumber === 'function' ? x.asNumber() : 0);
  return (name) => {
    if (!name || !fonts) return null;
    if (cache.has(name)) return cache.get(name);
    let info = null;
    const f = fonts.lookupMaybe(PDFName.of(name), PDFDict);
    if (f) {
      const baseFont = f.get(PDFName.of('BaseFont'))?.decodeText?.() || f.get(PDFName.of('BaseFont'))?.asString?.() || '';
      const subtype = f.get(PDFName.of('Subtype'))?.toString();
      if (subtype === '/Type0') {
        const desc = f.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)?.lookupMaybe(0, PDFDict);
        const dw = num(desc?.lookup(PDFName.of('DW'))) || 1000;
        const widths = new Map();
        const w = desc?.lookupMaybe(PDFName.of('W'), PDFArray)?.asArray() || [];
        for (let i = 0; i < w.length;) {
          const first = num(desc.context.lookup(w[i]));
          const next = desc.context.lookup(w[i + 1]);
          if (next instanceof PDFArray) {
            next.asArray().forEach((x, k) => widths.set(first + k, num(desc.context.lookup(x))));
            i += 2;
          } else {
            const last = num(next), width = num(desc.context.lookup(w[i + 2]));
            for (let c = first; c <= last; c++) widths.set(c, width);
            i += 3;
          }
        }
        info = { twoByte: true, width: (c) => widths.get(c) ?? dw, baseFont };
      } else {
        const first = num(f.lookup(PDFName.of('FirstChar')));
        const widths = f.lookupMaybe(PDFName.of('Widths'), PDFArray)?.asArray().map((x) => num(f.context.lookup(x)));
        const missing = num(f.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)?.lookup(PDFName.of('MissingWidth')));
        const fallback = /Courier/i.test(baseFont) ? 600 : missing || 500;
        info = { twoByte: false, width: (c) => widths?.[c - first] ?? fallback, baseFont };
      }
    }
    cache.set(name, info);
    return info;
  };
}

/** Map a PDF font name such as "ABCDEF+TimesNewRomanPS-BoldItalicMT" to a style. */
export function styleFromFontName(name = '') {
  const n = name.replace(/^[A-Z]{6}\+/, '');
  return {
    family: /Courier|Mono|Consol|Menlo|Typewriter/i.test(n) ? 'mono' : /Times|Serif|Georgia|Garamond|Cambria|Palatino|Book|Minion|Roman(?!.*Sans)/i.test(n) && !/Sans/i.test(n) ? 'serif' : 'sans',
    bold: /Bold|Black|Heavy|Semibold|Demi|,B\b/i.test(n),
    italic: /Italic|Oblique|,I\b/i.test(n),
  };
}

const STD = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

/**
 * Find the text runs on a line. line: {origin:[x,y], dir:[ux,uy], height, length} in PDF space.
 * Returns {count, color:'#rrggbb', size, fontName} describing the original text.
 */
export async function probeTextLine(bytes, pageIndex, line) {
  const doc = await load(bytes);
  const page = doc.getPage(pageIndex);
  const fi = fontInfoFor(page);
  const ops = opsOnLine(findTextOps(pageContentString(doc, page), fi), line);
  const first = ops[0];
  const toHex = (rgbArr) => `#${rgbArr.map((v) => Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, '0')).join('')}`;
  return { count: ops.length, color: first ? toHex(first.fill) : '#000000', size: first ? first.height : line.height, fontName: first ? fi(first.font)?.baseFont || '' : '' };
}

/**
 * Remove the original text on a line from the page and draw `repl` in its place.
 * repl: {text, family:'sans'|'serif'|'mono', bold, italic, size, color}
 * Throws if the text can't be found in the page's own drawing instructions
 * (for example when it lives inside a form XObject).
 */
export const replaceTextLine = (bytes, pageIndex, line, repl) =>
  edit(bytes, async (doc) => {
    const page = doc.getPage(pageIndex);
    const src = pageContentString(doc, page);
    const ops = opsOnLine(findTextOps(src, fontInfoFor(page)), line);
    if (!ops.length) throw Object.assign(new Error('The original text could not be located in the page content.'), { code: 'NOT_FOUND' });
    // Splice the operators out (keeping any line moves they implied), back to front.
    let out = src;
    for (const op of [...ops].sort((a, b) => b.s - a.s)) out = `${out.slice(0, op.s)}${op.replace ? ` ${op.replace} ` : ' '}${out.slice(op.e)}`;
    const bytesOut = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytesOut[i] = out.charCodeAt(i) & 255;
    page.node.set(CONTENTS, doc.context.register(doc.context.flateStream(bytesOut)));
    if (repl.text) {
      const variants = STD[repl.family] || STD.sans;
      const font = await doc.embedFont(variants[(repl.bold ? 1 : 0) + (repl.italic ? 2 : 0)]);
      const angle = (Math.atan2(line.dir[1], line.dir[0]) * 180) / Math.PI;
      page.drawText(safeText(font, repl.text), { x: line.origin[0], y: line.origin[1], size: repl.size, font, color: color(repl.color), rotate: degrees(angle) });
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
  if (!security && hasPdfAMetadata(doc)) {
    // Keep a PDF/A file's XMP metadata in step with its document information.
    writePdfAMetadata(doc);
    return finalize(doc);
  }
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
