# PDF Pro

A free, open source PDF editor that runs entirely in your browser. Files are processed locally and never leave your computer. The one exception is the OCR engine, which is downloaded once on first use.

## Features

| Area | What you can do |
| --- | --- |
| **View** | Continuous scroll, zoom (fit width, fit page, presets, Ctrl +/−), page thumbnails, bookmarks/outline, clickable links, text selection, full-text search with highlights, dark mode |
| **Organize pages** | Drag-and-drop reorder, rotate, delete, duplicate, insert blank pages, extract, split (every N pages or by ranges → .zip), combine/insert PDFs and images, reverse order, crop |
| **Comment & mark up** | Text boxes, highlight / underline / strikeout (drag an area, or select text and press Ctrl+H), freehand drawing, rectangles, ellipses, lines, arrows, sticky-note comments (saved as real PDF comments), stamps (presets or custom, with optional name and date), images |
| **Edit** | Edit Text: click a line of existing text to replace it. White-out. Watermarks. Headers, footers and page numbers. Bates numbering. Document properties (metadata) |
| **Fill & sign** | Draw, type or reuse a saved signature. Fill existing form fields (text, checkbox, dropdown, list, radio). Create new text fields and checkboxes. Flatten forms |
| **Redact** | Mark areas by hand, or use **Find & redact** with plain text or regular expressions (e.g. `\d{3}-\d{2}-\d{4}`). Applying redactions rasterizes the affected pages, so the hidden content is permanently removed rather than just covered |
| **Scan & OCR** | Recognize text in scanned pages (12 languages). Adds an invisible text layer, so scans become searchable and selectable |
| **Protect** | AES-256 password encryption with permission controls (printing, copying, editing, commenting, form filling, assembly). Opens password-protected PDFs. Remove security |
| **Optimize & export** | Lossless optimization (removes unused objects, uses object streams) or strong lossy compression (JPEG rasterization). Export pages as PNG/JPEG. Export text. Print |
| **Productivity** | Unlimited-session undo/redo (40 steps), keyboard shortcuts, drag & drop files, Save in place (File System Access API in Chromium browsers), unsaved-changes warning |

## Getting started

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. To create a static build you can host anywhere (it is just files, with no server code), run:

```bash
npm run build
```

The output goes to `dist/`. You can also open a document on launch with `?file=<url>` (same-origin or CORS-enabled URLs).

## Desktop app (Windows)

PDF Pro is also packaged as a desktop app with [Electron](https://www.electronjs.org). Compared with the browser version, it adds:

- native Open and Save dialogs
- Save that writes back to the file you opened
- registration as a handler for `.pdf` files, so you can use "Open with" and double-click PDFs
- a prompt about unsaved changes when you close the window

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build the web app and run it in Electron |
| `npm run desktop:dev` | Run in Electron against the Vite dev server, with live reload |
| `npm run dist` | Build `release/PDF-Pro-Setup-<version>.exe` (installer) and `release/PDF-Pro-Portable-<version>.exe` (no install needed) |
| `npm run dist:dir` | Build an unpacked app in `release/win-unpacked/` for quick testing |
| `npm run icon` | Regenerate `build/icon.png` |

The installers are **not code-signed**, so Windows SmartScreen will warn the first time you run them. Choose "More info → Run anyway", or sign the builds with your own certificate (see electron-builder's `win.certificateFile` option). The `package.json` `build` section also has macOS (dmg) and Linux (AppImage) targets, but you have to build them on those platforms.

In the desktop app, the page is served from a private `app://` scheme in a sandboxed, context-isolated window. A small preload bridge exposes only open, save and write, and it can only write to files you opened or chose in a Save dialog. Links in documents open in your normal browser.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+P | Open / Save / Save as / Print |
| Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) | Undo / Redo |
| Ctrl+F, Enter / Shift+Enter | Find, next / previous match |
| Ctrl+H / Ctrl+U | Highlight / underline the selected text |
| Ctrl+= / Ctrl+− / Ctrl+0 | Zoom in / out / 100% |
| V, H, E, T, D, R, O, L, A, N | Select, Hand, Edit text, Text, Draw, Rectangle, Ellipse, Line, Arrow, Note |
| Delete, arrow keys (+Shift), Ctrl+D | Delete, nudge or duplicate the selected annotation |
| Shift while drawing | Constrain to square/circle or 45° lines |
| Esc | Back to the Select tool |

## How it works

- **Rendering:** [pdf.js](https://github.com/mozilla/pdf.js) draws the pages, the text layer, links and outlines.
- **Editing:** [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) is a maintained pdf-lib fork that adds encryption and decryption. Every operation in [src/lib/engine.js](src/lib/engine.js) takes PDF bytes in and returns new bytes, which keeps undo simple: it is a stack of snapshots.
- **Annotations** live on an SVG overlay in page coordinates and stay editable for the whole session. When you save, print or export, they are drawn into the PDF ("flattened"). Sticky notes are written as standard PDF comment annotations instead.
- **OCR:** [Tesseract.js](https://github.com/naptha/tesseract.js) runs in a Web Worker.

```
src/
  main.js          app shell: state, history, open/save, commands, shortcuts
  viewer.js        page viewer (lazy rendering, text layer, search, links)
  thumbnails.js    page sidebar with multi-select and drag reorder
  annotations.js   annotation model and interactive editing
  tools.js         dialog-driven tools (merge, split, watermark, OCR, redaction, ...)
  lib/engine.js    PDF manipulation (pure bytes -> bytes)
  lib/pdfjs.js     pdf.js setup and rendering helpers
  lib/ui.js        DOM, dialogs, toasts, file IO
electron/
  main.mjs         desktop shell: app:// protocol, dialogs, file association
  preload.cjs      minimal bridge exposed to the page as window.pdfProDesktop
```

## Known limitations

- **Edit Text** covers the original run with white-out and places new text on top, in Helvetica. The original glyphs are still in the file underneath. To remove content for real, use redaction.
- When you save, annotations are flattened into the page, so after reopening they can't be edited as objects. Sticky notes stay real comments.
- Applying redactions and strong compression turn the affected pages into images. Run OCR afterwards to make them searchable again.
- Not implemented yet: digital (certificate) signatures, document comparison, PDF/A conversion, and export to Office formats.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Adobe.
