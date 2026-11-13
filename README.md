# Inkstone

A free, open source PDF editor for Windows and the browser. Files are processed locally and never leave your computer, and English OCR works offline.

## Features

| Area | What you can do |
| --- | --- |
| **View** | Several documents open at once in tabs. Continuous scroll, zoom (fit width, fit page, presets, Ctrl +/−), page thumbnails, clickable links, text selection, full-text search with highlights, dark mode |
| **Organize pages** | Drag-and-drop reorder, rotate, delete, duplicate, insert blank pages, extract, split (every N pages or by ranges → .zip), combine/insert PDFs and images, reverse order, crop |
| **Comment & mark up** | Text boxes, highlight / underline / strikeout (drag an area, or select text and press Ctrl+H), freehand drawing, rectangles, ellipses, lines, arrows, sticky-note comments, stamps (presets or custom, with optional name and date), images. **Markup stays editable**: it's visible in every PDF reader after you save, and when you reopen the file in Inkstone it comes back as objects you can move, change or delete |
| **Edit** | Edit Text: click a line of existing text to replace it. White-out. Watermarks. Headers, footers and page numbers. Bates numbering. Add links to web pages or other pages, and remove them. Create and edit bookmarks (add, nest, rename, reorder, delete). Document properties |
| **Fill & sign** | Draw, type, or upload an image of your signature (white paper backgrounds are removed automatically), or reuse a saved one. Fill form fields. Create text fields, checkboxes, dropdowns and radio button groups. Manage fields: rename, mark required or read-only, edit choices, delete. Flatten forms |
| **Review** | Compare with another version: a word-by-word report of what changed on each page, with added or changed words highlighted in the document |
| **Redact** | Mark areas by hand, or use **Find & redact** with plain text or regular expressions (e.g. `\d{3}-\d{2}-\d{4}`). Applying redactions rasterizes the affected pages, so the content is permanently removed rather than just covered. It can also scrub hidden information: document properties, XMP metadata, attachments, scripts and automatic actions |
| **Scan & OCR** | Recognize text in scanned pages (12 languages; English is built in and works offline). Adds an invisible text layer, so scans become searchable and selectable |
| **Digital signatures** (desktop app) | Sign with a certificate (PKCS#7, `adbe.pkcs7.detached`): drag where the signature goes, and Inkstone draws a visible signature (your handwritten image, name, date, reason, location) and saves a signed copy. Additional signatures are appended so earlier ones stay valid. **Digital IDs**: create a self-signed ID, or import a `.pfx`/`.p12` from your organization or a certificate authority. Back up IDs, share the public certificate, delete. A **Signatures panel** checks every signature when a PDF opens: whether the document changed since signing, whether the signature matches the certificate, and whether the signer's identity chains to a trusted certificate authority. Saving changes to a signed file warns first, and an unchanged signed file is saved byte-for-byte |
| **Protect** | AES-256 password encryption with permission controls (printing, copying, editing, commenting, form filling, assembly). Opens password-protected PDFs. Remove security |
| **Optimize & export** | Lossless optimization (removes unused objects, uses object streams) or strong lossy compression (JPEG rasterization). Export pages as PNG/JPEG. Export text. Print |
| **Productivity** | Undo/redo per document (up to 40 steps, capped at about 400 MB for large files), keyboard shortcuts, drag & drop files, Save in place, unsaved-changes warning |

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

Inkstone is also packaged as a desktop app with [Electron](https://www.electronjs.org). Compared with the browser version, it adds:

- native Open and Save dialogs
- Save that writes back to the file you opened
- registration as a handler for `.pdf` files, so you can use "Open with" and double-click PDFs
- a prompt about unsaved changes when you close the window
- no Windows title bar: the app draws its own header, and the native window buttons are overlaid on it in the current theme

| Command | What it does |
| --- | --- |
| `npm run desktop` | Build the web app and run it in Electron |
| `npm run desktop:dev` | Run in Electron against the Vite dev server, with live reload |
| `npm run dist` | Build `release/Inkstone-Setup-<version>.exe` (installer) and `release/Inkstone-Portable-<version>.exe` (no install needed) |
| `npm run dist:dir` | Build an unpacked app in `release/win-unpacked/` for quick testing |
| `npm run icon` | Regenerate `build/icon.png` |

The installers are **not code-signed**, so Windows SmartScreen will warn the first time you run them. Choose "More info → Run anyway", or sign the builds with your own certificate (see electron-builder's `win.certificateFile` option). The `package.json` `build` section also has macOS (dmg) and Linux (AppImage) targets, but you have to build them on those platforms.

In the desktop app, the page is served from a private `app://` scheme in a sandboxed, context-isolated window. A small preload bridge exposes only open, save and write, and it can only write to files you opened or chose in a Save dialog. Links in documents open in your normal browser.

## Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Ctrl+O / Ctrl+S / Ctrl+Shift+S / Ctrl+P | Open / Save / Save as / Print |
| Ctrl+W / Ctrl+Tab (Shift for back) | Close tab / switch tabs |
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
- **Annotations** live on an SVG overlay in page coordinates. When you save, they are drawn into each page so every reader shows them. Inkstone also stores the editable objects in the page (`/InkstoneMarkup`), along with the content streams that hold the drawing (`/InkstoneStreams`). On open, it removes those streams and restores the objects. If another program has since rewritten the page, the drawing is left as it is. Sticky notes are also written as standard PDF comments. Print and export always flatten.
- **Digital signatures** run in the desktop app's main process ([electron/signing.mjs](electron/signing.mjs)), using [@signpdf](https://github.com/vbuch/node-signpdf) and [node-forge](https://github.com/digitalbazaar/forge). Digital IDs are stored as password-protected PKCS#12 files in the app's user-data folder, and private keys never reach the page. The first signature rewrites the file with a classic cross-reference table. Later signatures are incremental updates. Verification parses each signature's PKCS#7 data, checks the message digest against the signed byte ranges, verifies the signature with the certificate's public key, and checks the chain against Node's bundled root certificates.
- **OCR:** [Tesseract.js](https://github.com/naptha/tesseract.js) runs in a Web Worker. The engine and English data are copied into the app at build time (see `vite.config.js`), so English works offline.
- **Icons:** [Lucide](https://lucide.dev) (ISC license).

```
src/
  main.js          app shell: tabs, state, history, open/save, bookmarks, commands, shortcuts
  viewer.js        page viewer (lazy rendering, text layer, search, links)
  thumbnails.js    page sidebar with multi-select and drag reorder
  annotations.js   annotation model and interactive editing
  tools.js         dialog-driven tools (merge, split, watermark, OCR, redaction, compare, fields, links, ...)
  lib/engine.js    PDF manipulation (pure bytes -> bytes)
  lib/pdfjs.js     pdf.js setup and rendering helpers
  lib/ui.js        DOM, dialogs, toasts, file IO
electron/
  main.mjs         desktop shell: app:// protocol, dialogs, file association
  signing.mjs      digital IDs, certificate signing and verification
  preload.cjs      minimal bridge exposed to the page as window.inkstoneDesktop
```

## Known limitations

- **Edit Text** covers the original run with white-out and places new text on top, in Helvetica. The original glyphs are still in the file underneath. To remove content for real, use redaction.
- Markup made in other programs (for example, highlights from another PDF editor) is shown and listed in Comments, but it can't be edited as objects.
- Compare checks text only, page by page. It doesn't detect formatting or image changes, or text that moved to a different page.
- Applying redactions and strong compression turn the affected pages into images. Run OCR afterwards to make them searchable again.
- OCR in languages other than English downloads that language's data the first time.
- Digital signature limitations:
  - Signing is only available in the desktop app.
  - Signatures use your computer's clock, not a trusted timestamp server.
  - Only RSA certificates are supported.
  - Signatures added to an already-signed document have no visible stamp.
  - Self-signed IDs show as "identity not verified" to recipients unless they choose to trust your certificate.
  - "Trusted" means the certificate chains to a standard public certificate authority. It doesn't use the Windows certificate store or Adobe's trust list.
- Not implemented yet: PDF/A conversion and export to Office formats.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Adobe.
