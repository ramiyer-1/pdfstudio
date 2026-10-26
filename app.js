/* PDF Studio — combine images, PDFs and documents into one PDF, entirely in the browser. */
(() => {
  'use strict';

  // ---------- constants ----------
  const PAGE_SIZES = { // points (1/72 in), portrait
    a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a3: [841.89, 1190.55], a5: [419.53, 595.28],
  };
  const QUALITY = {
    original: { max: Infinity, q: 0.95, raster: 2.5 },
    high: { max: 3000, q: 0.9, raster: 2 },
    balanced: { max: 2000, q: 0.8, raster: 1.6 },
    small: { max: 1400, q: 0.68, raster: 1.2 },
  };
  const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#ef4444', '#06b6d4', '#a855f7', '#84cc16', '#ec4899', '#f97316', '#3b82f6'];
  const THUMB_W = 400;
  const TEXT_PAGE = { W: 1240, H: 1754, M: 118 }; // A4 at 150 dpi
  const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif';
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
  const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|log|xml|yaml|yml|ini|conf|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|sql|css|scss)$/i;
  const MONO_EXT = /\.(csv|tsv|json|log|xml|yaml|yml|ini|conf|js|mjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|cs|php|sh|sql|css|scss)$/i;

  // ---------- state ----------
  const state = {
    pages: [],              // { id, kind: 'pdf'|'image'|'blank', src, index, rot, name }
    sources: new Map(),     // id -> { id, name, kind, blob, bytes, pdfjs, color, order, textPage, mime }
    selected: new Set(),
    history: [], future: [],
    result: null,
    busy: false,
  };
  let uid = 0, sourceCount = 0;
  const nid = (p) => `${p}${++uid}`;

  // ---------- dom ----------
  const $ = (id) => document.getElementById(id);
  const grid = $('grid'), dropzone = $('dropzone'), toolbar = $('toolbar'), panel = $('panel');
  const fileInput = $('fileInput'), folderInput = $('folderInput'), cameraInput = $('cameraInput');

  // ---------- utils ----------
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const norm = (deg) => ((deg % 360) + 360) % 360;
  const fmtBytes = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, type = '', ms = 3200) {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), ms);
    return t;
  }

  const scripts = {};
  function loadScript(src) {
    return scripts[src] ||= new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = res;
      s.onerror = () => { delete scripts[src]; rej(new Error(`Failed to load ${src}`)); };
      document.head.appendChild(s);
    });
  }
  const loadPdfLib = () => loadScript('vendor/pdf-lib.min.js').then(() => window.PDFLib);
  async function loadPdfJs() {
    await loadScript('vendor/pdf.min.js');
    const lib = window.pdfjsLib;
    if (!lib.GlobalWorkerOptions.workerSrc) {
      if (location.protocol === 'file:') await loadScript('vendor/pdf.worker.min.js'); // workers can't load from file://
      lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    return lib;
  }

  function canvasToBlob(canvas, type = 'image/jpeg', q = 0.9) {
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Canvas export failed'))), type, q));
  }

  // Decode any browser-supported image (EXIF orientation applied).
  async function decodeImage(blob) {
    if (window.createImageBitmap && !/svg/.test(blob.type)) {
      try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
    }
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      if (!img.naturalWidth) { img.width = 1200; img.height = 1200; }
      return img;
    } finally { URL.revokeObjectURL(url); }
  }
  const dims = (d) => [d.width || d.naturalWidth, d.height || d.naturalHeight];
  const release = (d) => d && d.close && d.close();

  // JPEG EXIF orientation (1 = normal). Raw JPEG bytes are only embedded when this is 1.
  function jpegOrientation(bytes) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (v.getUint16(0) !== 0xffd8) return 1;
    let off = 2;
    while (off + 4 < v.byteLength) {
      const marker = v.getUint16(off);
      const len = v.getUint16(off + 2);
      if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
        const t = off + 10, le = v.getUint16(t) === 0x4949;
        const ifd = t + v.getUint32(t + 4, le);
        const n = v.getUint16(ifd, le);
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12;
          if (v.getUint16(e, le) === 0x0112) return v.getUint16(e + 8, le);
        }
        return 1;
      }
      if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
      off += 2 + len;
    }
    return 1;
  }

  // ---------- settings ----------
  const opts = {
    name: 'combined', size: 'auto', orient: 'auto', margin: 0, fit: 'contain', quality: 'high',
    resizePdf: false, gray: false, numbers: 'none', watermark: '', title: '', author: '',
  };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };

  function initSettings() {
    Object.assign(opts, store.get('pdfstudio.opts') || {});
    $('optName').value = opts.name;
    $('optSize').value = opts.size;
    $('optResizePdf').checked = opts.resizePdf;
    $('optGray').checked = opts.gray;
    $('optNumbers').value = opts.numbers;
    $('optWatermark').value = opts.watermark;
    $('optTitle').value = opts.title;
    $('optAuthor').value = opts.author;
    const segMap = { optOrient: 'orient', optMargin: 'margin', optFit: 'fit', optQuality: 'quality' };
    document.querySelectorAll('.seg').forEach((seg) => {
      const key = segMap[seg.dataset.name];
      const sync = () => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(opts[key])));
      sync();
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        opts[key] = key === 'margin' ? Number(b.dataset.v) : b.dataset.v;
        sync(); saveSettings();
      });
    });
    const bind = (id, key, prop = 'value', ev = 'input') => $(id).addEventListener(ev, () => { opts[key] = $(id)[prop]; saveSettings(); });
    bind('optName', 'name'); bind('optSize', 'size', 'value', 'change');
    bind('optResizePdf', 'resizePdf', 'checked', 'change'); bind('optGray', 'gray', 'checked', 'change');
    bind('optNumbers', 'numbers', 'value', 'change'); bind('optWatermark', 'watermark');
    bind('optTitle', 'title'); bind('optAuthor', 'author');
    updateSettingsUI();
  }
  function saveSettings() { store.set('pdfstudio.opts', opts); updateSettingsUI(); }
  function updateSettingsUI() {
    $('rowOrient').style.opacity = opts.size === 'auto' ? '.45' : '';
    $('qualityNote').textContent = { original: '— largest file', high: '— recommended', balanced: '— smaller file', small: '— email-friendly' }[opts.quality];
  }

  // ---------- history ----------
  const snapshot = () => state.pages.map((p) => ({ ...p }));
  function commit() {
    state.history.push(snapshot());
    if (state.history.length > 100) state.history.shift();
    state.future = [];
  }
  function undo() {
    if (!state.history.length) return;
    state.future.push(snapshot());
    state.pages = state.history.pop();
    pruneSelection(); render();
  }
  function redo() {
    if (!state.future.length) return;
    state.history.push(snapshot());
    state.pages = state.future.pop();
    pruneSelection(); render();
  }
  function pruneSelection() {
    const ids = new Set(state.pages.map((p) => p.id));
    for (const id of state.selected) if (!ids.has(id)) state.selected.delete(id);
  }

  // ---------- adding files ----------
  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => f && f.size !== undefined && !/(^|\/)\.[^/]*$/.test(f.name || ''));
    if (!files.length) return;
    files.sort((a, b) => natural.compare(a.webkitRelativePath || a.name, b.webkitRelativePath || b.name));
    const status = toast(`Reading ${files.length} file${files.length > 1 ? 's' : ''}…`, '', 600000);
    const added = [];
    let failed = 0;
    for (const file of files) {
      try {
        added.push(...await importFile(file));
      } catch (err) {
        failed++;
        console.error(file.name, err);
        toast(`Couldn't read “${file.name}”: ${err.message || err}`, 'err', 5000);
      }
    }
    status.remove();
    if (added.length) {
      commit();
      state.pages.push(...added);
      render();
      toast(`Added ${added.length} page${added.length > 1 ? 's' : ''}`, 'ok', 1800);
      requestAnimationFrame(() => grid.lastElementChild?.previousElementSibling?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
    } else if (!failed) toast('No supported files found', 'err');
  }

  function newSource(file, extra) {
    const s = { id: nid('s'), name: file.name || 'Pasted image', blob: file, color: COLORS[sourceCount % COLORS.length], order: sourceCount++, ...extra };
    state.sources.set(s.id, s);
    return s;
  }
  const pageOf = (s, index = 0, label = s.name) => ({ id: nid('p'), kind: s.kind, src: s.id, index, rot: 0, name: label });

  async function importFile(file) {
    const name = file.name || '';
    const type = file.type || '';
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) return importPdf(file);
    if (/\.(heic|heif)$/i.test(name) || /heic|heif/.test(type)) return importHeic(file);
    if (type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|svg|avif|ico)$/i.test(name)) {
      const s = newSource(file, { kind: 'image', mime: type || guessMime(name) });
      return [pageOf(s)];
    }
    if (/\.docx$/i.test(name)) return importDocx(file);
    if (/\.html?$/i.test(name) || type === 'text/html') {
      const doc = new DOMParser().parseFromString(await file.text(), 'text/html');
      return importRendered(file, await htmlToBlocks(doc.body));
    }
    if (type.startsWith('text/') || TEXT_EXT.test(name) || type === 'application/json') {
      return importRendered(file, textToBlocks(await file.text(), MONO_EXT.test(name)));
    }
    if (/\.(doc|ppt|pptx|xls|xlsx|odt|pages|key|numbers)$/i.test(name)) {
      throw new Error('this format can’t be converted in the browser — export it to PDF first, then add the PDF');
    }
    throw new Error('unsupported file type');
  }
  function guessMime(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif' }[ext] || '';
  }

  async function importPdf(file) {
    const pdfjs = await loadPdfJs();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
    let password = null;
    task.onPassword = (update, reason) => {
      const pw = prompt(reason === 2 ? `Wrong password. Try again for “${file.name}”:` : `“${file.name}” is password-protected. Enter password:`);
      if (pw === null) { task.destroy(); return; }
      password = pw; update(pw);
    };
    let doc;
    try { doc = await task.promise; } catch (e) {
      if (/password|destroy/i.test(String(e && (e.name + e.message)))) throw new Error('password required');
      throw new Error('not a valid PDF');
    }
    const s = newSource(file, { kind: 'pdf', bytes, pdfjs: doc, password });
    const n = doc.numPages;
    return Array.from({ length: n }, (_, i) => pageOf(s, i, n > 1 ? `${s.name} · p${i + 1}` : s.name));
  }

  async function importHeic(file) {
    let blob = file;
    try {
      const bmp = await createImageBitmap(file); // Safari decodes HEIC natively
      release(bmp);
    } catch {
      await loadScript('vendor/heic2any.min.js');
      const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      blob = Array.isArray(out) ? out[0] : out;
    }
    const s = newSource(file, { kind: 'image', blob, mime: blob.type || 'image/jpeg' });
    return [pageOf(s)];
  }

  async function importDocx(file) {
    await loadScript('vendor/mammoth.browser.min.js');
    const { value } = await window.mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() });
    const doc = new DOMParser().parseFromString(value, 'text/html');
    return importRendered(file, await htmlToBlocks(doc.body));
  }

  async function importRendered(file, blocks) {
    const blobs = await renderBlocks(blocks);
    const color = COLORS[sourceCount % COLORS.length];
    const order = sourceCount++;
    return blobs.map((blob, i) => {
      const s = { id: nid('s'), name: file.name, blob, kind: 'image', mime: 'image/png', textPage: true, color, order };
      state.sources.set(s.id, s);
      return pageOf(s, 0, blobs.length > 1 ? `${file.name} · p${i + 1}` : file.name);
    });
  }

  // ---------- text / html → page images ----------
  function textToBlocks(text, mono) {
    const size = mono ? 19 : 23;
    return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n')
      .map((line) => ({ type: 'p', runs: [{ t: line }], size, mono, pre: true, after: 0 }));
  }

  async function htmlToBlocks(root) {
    const blocks = [];
    const HEAD = { H1: 1.9, H2: 1.55, H3: 1.3, H4: 1.15, H5: 1.05, H6: 1 };
    const base = 23;
    const images = [];

    function runsOf(node, style, out, imgs) {
      for (const c of node.childNodes) {
        if (c.nodeType === 3) out.push({ t: c.textContent.replace(/\s+/g, ' '), ...style });
        else if (c.nodeType === 1) {
          const tag = c.tagName;
          if (tag === 'BR') out.push({ t: '\n' });
          else if (tag === 'IMG') imgs.push(c.getAttribute('src'));
          else if (tag === 'UL' || tag === 'OL') continue; // nested lists handled by caller
          else runsOf(c, { b: style.b || /^(B|STRONG|TH)$/.test(tag), i: style.i || /^(I|EM)$/.test(tag) }, out, imgs);
        }
      }
      return out;
    }
    function para(node, extra = {}) {
      const imgs = [];
      const runs = runsOf(node, { b: !!extra.bold }, [], imgs);
      if (runs.some((r) => r.t.trim())) blocks.push({ type: 'p', runs, size: base, after: 12, ...extra });
      for (const src of imgs) if (src) { const b = { type: 'img', src }; blocks.push(b); images.push(b); }
    }
    function list(node, depth) {
      let n = 1;
      for (const li of node.children) {
        if (li.tagName !== 'LI') continue;
        const prefix = node.tagName === 'OL' ? `${n++}.` : (depth % 2 ? '◦' : '•');
        para(li, { indent: 44 * (depth + 1), prefix, after: 6 });
        for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') list(sub, depth + 1);
      }
      blocks.push({ type: 'gap', h: 8 });
    }
    function walk(node) {
      for (const el of node.children) {
        const tag = el.tagName;
        if (HEAD[tag]) para(el, { size: Math.round(base * HEAD[tag]), bold: true, before: 14, after: 10 });
        else if (tag === 'UL' || tag === 'OL') list(el, 0);
        else if (tag === 'PRE') blocks.push(...textToBlocks(el.textContent, true), { type: 'gap', h: 12 });
        else if (tag === 'TABLE') {
          for (const tr of el.querySelectorAll('tr')) {
            const runs = [];
            [...tr.children].forEach((cell, i) => {
              if (i) runs.push({ t: '  │  ' });
              runs.push({ t: cell.textContent.replace(/\s+/g, ' ').trim(), b: cell.tagName === 'TH' });
            });
            blocks.push({ type: 'p', runs, size: base - 3, after: 4, rule: true });
          }
          blocks.push({ type: 'gap', h: 14 });
        } else if (tag === 'HR') blocks.push({ type: 'hr' });
        else if (tag === 'IMG') { const b = { type: 'img', src: el.getAttribute('src') }; blocks.push(b); images.push(b); }
        else if (/^(DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|NAV|FIGURE|BLOCKQUOTE|BODY|FORM|DL)$/.test(tag) && [...el.children].some((c) => /^(P|DIV|H\d|UL|OL|TABLE|PRE|SECTION|BLOCKQUOTE|FIGURE|IMG)$/.test(c.tagName))) walk(el);
        else if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD)$/.test(tag)) continue;
        else para(el, tag === 'BLOCKQUOTE' ? { indent: 40 } : {});
      }
    }
    walk(root);
    await Promise.all(images.map(async (b) => {
      try {
        if (!b.src || !/^(data:|blob:)/.test(b.src)) throw 0;
        const img = new Image(); img.src = b.src; await img.decode(); b.img = img;
      } catch { b.type = 'gap'; b.h = 0; }
    }));
    return blocks;
  }

  async function renderBlocks(blocks) {
    const { W, H, M } = TEXT_PAGE;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const pages = [];
    let y = M, dirty = false;
    const fresh = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#111'; ctx.textBaseline = 'alphabetic'; y = M; dirty = false; };
    const flush = async () => { pages.push(await canvasToBlob(canvas, 'image/png')); fresh(); };
    const font = (r, size, mono) => `${r.i ? 'italic ' : ''}${r.b ? '700 ' : ''}${size}px ${mono ? MONO : SANS}`;
    fresh();

    for (const b of blocks) {
      if (b.type === 'gap') { y += b.h; continue; }
      if (b.type === 'hr') {
        if (y + 30 > H - M) await flush();
        ctx.fillStyle = '#ccc'; ctx.fillRect(M, y + 10, W - 2 * M, 2); ctx.fillStyle = '#111'; y += 30; dirty = true; continue;
      }
      if (b.type === 'img') {
        const [iw, ih] = dims(b.img);
        const maxW = W - 2 * M, maxH = H - 2 * M;
        const s = Math.min(1, maxW / iw, maxH / ih);
        const w = iw * s, h = ih * s;
        if (y + h > H - M && dirty) await flush();
        ctx.drawImage(b.img, M + (maxW - w) / 2, y, w, h);
        y += h + 14; dirty = true; continue;
      }
      // paragraph
      const size = b.size || 23, lh = Math.round(size * (b.pre ? 1.32 : 1.42));
      const x0 = M + (b.indent || 0), maxW = W - M - x0;
      y += b.before || 0;
      // tokenize runs into words keeping whitespace
      const lines = [[]];
      let lw = 0;
      for (const r of b.runs) {
        ctx.font = font(r, size, b.mono);
        const parts = r.t === '\n' ? ['\n'] : r.t.split(/(\s+)/);
        for (let part of parts) {
          if (!part) continue;
          if (part === '\n') { lines.push([]); lw = 0; continue; }
          let w = ctx.measureText(part).width;
          if (lw + w > maxW && /\S/.test(part) && lines[lines.length - 1].length) { lines.push([]); lw = 0; }
          if (!lines[lines.length - 1].length && !/\S/.test(part) && !b.pre) continue;
          while (w > maxW) { // hard-break very long words
            let n = part.length;
            while (n > 1 && ctx.measureText(part.slice(0, n)).width > maxW - lw) n--;
            lines[lines.length - 1].push({ t: part.slice(0, n), r, w: ctx.measureText(part.slice(0, n)).width });
            lines.push([]); lw = 0;
            part = part.slice(n); w = ctx.measureText(part).width;
          }
          lines[lines.length - 1].push({ t: part, r, w });
          lw += w;
        }
      }
      for (let li = 0; li < lines.length; li++) {
        if (y + lh > H - M) await flush();
        let x = x0;
        if (li === 0 && b.prefix) { ctx.font = font({}, size, b.mono); ctx.fillText(b.prefix, x0 - ctx.measureText(b.prefix).width - 12, y + size); }
        for (const tok of lines[li]) { ctx.font = font(tok.r, size, b.mono); ctx.fillText(tok.t, x, y + size); x += tok.w; }
        y += lh; dirty = true;
      }
      if (b.rule) { ctx.fillStyle = '#e3e3e3'; ctx.fillRect(x0, y + 1, maxW, 1); ctx.fillStyle = '#111'; }
      y += b.after || 0;
    }
    if (dirty || !pages.length) await flush();
    return pages;
  }

  // ---------- thumbnails ----------
  const thumbs = new Map(); // key -> url
  const thumbJobs = new Map(); // key -> promise
  const queue = [];
  let running = 0;
  const thumbKey = (p) => `${p.src}:${p.index}`;

  function requestThumb(p) {
    const key = thumbKey(p);
    if (thumbs.has(key) || thumbJobs.has(key)) return thumbJobs.get(key);
    const job = new Promise((res) => queue.push({ p, key, res }));
    thumbJobs.set(key, job);
    pump();
    return job;
  }
  function pump() {
    while (running < 3 && queue.length) {
      const { p, key, res } = queue.shift();
      running++;
      makeThumb(p).then((url) => { thumbs.set(key, url); }).catch((e) => { console.warn(e); thumbs.set(key, ''); })
        .finally(() => { running--; thumbJobs.delete(key); res(); updateThumbs(key); pump(); });
    }
  }
  async function makeThumb(p) {
    const s = state.sources.get(p.src);
    const canvas = document.createElement('canvas');
    if (s.kind === 'pdf') {
      const page = await s.pdfjs.getPage(p.index + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(3, THUMB_W / vp1.width) });
      canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      page.cleanup();
    } else {
      const img = await decodeImage(s.blob);
      const [w, h] = dims(img);
      s.w = w; s.h = h;
      const sc = Math.min(1, THUMB_W / w);
      canvas.width = Math.max(1, Math.round(w * sc)); canvas.height = Math.max(1, Math.round(h * sc));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      release(img);
    }
    return URL.createObjectURL(await canvasToBlob(canvas, 'image/jpeg', 0.82));
  }

  // Thumbnails of edited pages: base thumbnail + annotations, cached per (immutable) annotations object.
  const annotThumbs = new WeakMap();
  const annotJobs = new WeakSet();
  async function compositeThumb(p) {
    const annots = p.annots;
    if (annotJobs.has(annots)) return;
    annotJobs.add(annots);
    try {
      const c = document.createElement('canvas');
      let base = null;
      if (p.kind === 'blank') { c.width = 400; c.height = 566; } else {
        base = new Image(); base.src = thumbs.get(thumbKey(p)); await base.decode();
        c.width = base.naturalWidth; c.height = base.naturalHeight;
      }
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      if (base) ctx.drawImage(base, 0, 0);
      PDFEditor.drawOnBase(ctx, c.width, c.height, annots);
      annotThumbs.set(annots, URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.85)));
    } catch (e) { console.warn(e); annotThumbs.set(annots, thumbs.get(thumbKey(p)) || ''); }
    for (const q of state.pages) if (q.annots === annots) { const el = cards.get(q.id); if (el) paintThumb(el, q); }
  }

  // Full-resolution render of a page's content in its base orientation (used by the editor).
  async function baseCanvas(p, maxSide = 2000) {
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    if (p.kind === 'blank') {
      c.width = 1000; c.height = 1414;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      return c;
    }
    const s = state.sources.get(p.src);
    if (s.kind === 'pdf') {
      const page = await s.pdfjs.getPage(p.index + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, maxSide / Math.max(vp1.width, vp1.height)) });
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      return c;
    }
    const img = await decodeImage(s.blob);
    const [w, h] = dims(img);
    const k = Math.min(1, maxSide / Math.max(w, h));
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    release(img);
    return c;
  }

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const p = state.pages.find((x) => x.id === e.target.dataset.id);
      if (p) requestThumb(p);
    }
  }, { rootMargin: '600px' });

  function updateThumbs(key) {
    for (const p of state.pages) if (p.kind !== 'blank' && thumbKey(p) === key) { const el = cards.get(p.id); if (el) paintThumb(el, p); }
  }

  // ---------- rendering ----------
  const cards = new Map(); // page id -> element
  const addTile = document.createElement('button');
  addTile.className = 'add-tile';
  addTile.innerHTML = '<svg><use href="#i-plus"/></svg><span>Add more</span>';
  addTile.addEventListener('click', () => fileInput.click());

  function makeCard(p) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = p.id;
    el.innerHTML = `<span class="stripe"></span>
      <input type="checkbox" class="sel" aria-label="Select page">
      <div class="thumb"></div>
      <span class="num"></span>
      <div class="meta"><span class="name"></span><span class="edited" title="Has edits" hidden>✎</span><span class="rot"></span></div>
      <div class="actions">
        <button data-act="rotl" title="Rotate left"><svg><use href="#i-rot-l"/></svg></button>
        <button data-act="rotr" title="Rotate right"><svg><use href="#i-rot-r"/></svg></button>
        <button data-act="edit" title="Edit — add text, drawings, signature"><svg><use href="#i-edit"/></svg></button>
        <button data-act="view" title="Preview"><svg><use href="#i-eye"/></svg></button>
        <button data-act="dup" title="Duplicate"><svg><use href="#i-copy"/></svg></button>
        <button data-act="del" class="del" title="Delete"><svg><use href="#i-trash"/></svg></button>
      </div>`;
    el._key = null;
    return el;
  }

  function paintThumb(el, p) {
    const box = el.querySelector('.thumb');
    const edited = p.annots && p.annots.items.length;
    if (edited && annotThumbs.has(p.annots)) {
      const url = annotThumbs.get(p.annots);
      if (el._key !== url) { box.innerHTML = `<img alt="" src="${url}">`; el._key = url; }
    } else if (edited && (p.kind === 'blank' || thumbs.get(thumbKey(p)))) {
      compositeThumb(p);
      if (el._key !== 'loading') { box.innerHTML = '<div class="spinner"></div>'; el._key = 'loading'; }
    } else if (p.kind === 'blank') {
      if (el._key !== 'blank') { box.innerHTML = '<div class="blank">Blank</div>'; el._key = 'blank'; }
    } else {
      const key = thumbKey(p);
      const url = thumbs.get(key);
      if (url === undefined) {
        if (el._key !== 'loading') { box.innerHTML = '<div class="spinner"></div>'; el._key = 'loading'; io.observe(el); }
      } else if (el._key !== key) {
        box.innerHTML = url ? `<img alt="" src="${url}">` : '<div class="blank">No preview</div>';
        el._key = key;
      }
    }
    const inner = box.firstElementChild;
    if (inner) {
      inner.style.transform = p.rot ? `rotate(${p.rot}deg)` : '';
      const side = p.rot % 180 !== 0;
      inner.style.maxWidth = side ? '133.33%' : '';
      inner.style.maxHeight = side ? '75%' : '';
    }
  }

  function render() {
    const has = state.pages.length > 0;
    dropzone.hidden = has;
    toolbar.hidden = !has;
    $('hint').hidden = !has;
    grid.hidden = !has;

    const live = new Set();
    state.pages.forEach((p, i) => {
      live.add(p.id);
      let el = cards.get(p.id);
      if (!el) { el = makeCard(p); cards.set(p.id, el); }
      const s = state.sources.get(p.src);
      el.querySelector('.stripe').style.background = s ? s.color : 'var(--border)';
      el.querySelector('.num').textContent = i + 1;
      const nm = el.querySelector('.name');
      nm.textContent = p.kind === 'blank' ? 'Blank page' : p.name;
      nm.title = nm.textContent;
      el.querySelector('.rot').textContent = p.rot ? `${p.rot}°` : '';
      el.querySelector('.edited').hidden = !(p.annots && p.annots.items.length);
      const sel = state.selected.has(p.id);
      el.querySelector('.sel').checked = sel;
      if (sel !== el.classList.contains('selected')) Sortable.utils[sel ? 'select' : 'deselect'](el);
      paintThumb(el, p);
      if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
    });
    for (const [id, el] of cards) if (!live.has(id)) { if (el.classList.contains('selected')) Sortable.utils.deselect(el); io.unobserve(el); el.remove(); cards.delete(id); }
    if (has) grid.appendChild(addTile); else addTile.remove();
    updateChrome();
  }

  function updateChrome() {
    const n = state.pages.length, k = state.selected.size;
    $('countLabel').textContent = `${n} page${n === 1 ? '' : 's'}`;
    $('chkAll').checked = n > 0 && k === n;
    $('chkAll').indeterminate = k > 0 && k < n;
    $('selActions').hidden = k === 0;
    $('selCount').textContent = `${k} selected`;
    grid.classList.toggle('selecting', k > 0);
    $('btnUndo').disabled = !state.history.length;
    $('btnRedo').disabled = !state.future.length;
    $('btnCreate').disabled = n === 0 || state.busy;
    $('createLabel').textContent = n ? `Create PDF · ${n} page${n === 1 ? '' : 's'}` : 'Create PDF';
    $('btnCreateSel').hidden = !(k > 0 && k < n) || state.busy;
    $('btnCreateSel').textContent = `Create from ${k} selected page${k === 1 ? '' : 's'} only`;
  }

  // ---------- page operations ----------
  const byId = (id) => state.pages.find((p) => p.id === id);
  function rotate(ids, delta) {
    if (!ids.length) return;
    commit();
    for (const id of ids) { const p = byId(id); if (p) p.rot = norm(p.rot + delta); }
    render();
  }
  function remove(ids) {
    if (!ids.length) return;
    commit();
    const set = new Set(ids);
    state.pages = state.pages.filter((p) => !set.has(p.id));
    ids.forEach((id) => state.selected.delete(id));
    render();
    toast(`Deleted ${ids.length} page${ids.length > 1 ? 's' : ''} · Ctrl+Z to undo`, '', 2200);
  }
  function duplicate(ids) {
    if (!ids.length) return;
    commit();
    const set = new Set(ids);
    const out = [];
    for (const p of state.pages) { out.push(p); if (set.has(p.id)) out.push({ ...p, id: nid('p') }); }
    state.pages = out;
    render();
  }
  function moveSelected(toStart) {
    const sel = state.pages.filter((p) => state.selected.has(p.id));
    if (!sel.length) return;
    commit();
    const rest = state.pages.filter((p) => !state.selected.has(p.id));
    state.pages = toStart ? [...sel, ...rest] : [...rest, ...sel];
    render();
  }
  function insertBlank() {
    commit();
    const p = { id: nid('p'), kind: 'blank', src: null, index: 0, rot: 0, name: 'Blank page' };
    const sel = state.pages.filter((x) => state.selected.has(x.id));
    const after = sel.length ? state.pages.indexOf(sel[sel.length - 1]) + 1 : state.pages.length;
    state.pages.splice(after, 0, p);
    render();
  }
  function sortPages(mode) {
    if (state.pages.length < 2) return;
    commit();
    const src = (p) => state.sources.get(p.src);
    if (mode === 'reverse') state.pages.reverse();
    else if (mode === 'name-asc' || mode === 'name-desc') {
      const dir = mode === 'name-asc' ? 1 : -1;
      state.pages.sort((a, b) => dir * natural.compare(src(a)?.name || '~', src(b)?.name || '~') || (src(a)?.order ?? 1e9) - (src(b)?.order ?? 1e9) || a.index - b.index);
    } else if (mode === 'added') {
      state.pages.sort((a, b) => (src(a)?.order ?? 1e9) - (src(b)?.order ?? 1e9) || a.index - b.index);
    } else if (mode === 'interleave') {
      const groups = new Map();
      for (const p of state.pages) { const k = src(p) ? `${src(p).name}#${src(p).color}` : 'blank'; (groups.get(k) || groups.set(k, []).get(k)).push(p); }
      const lists = [...groups.values()], out = [];
      for (let i = 0; out.length < state.pages.length; i++) for (const l of lists) if (l[i]) out.push(l[i]);
      state.pages = out;
    }
    render();
  }
  function setSelection(ids) {
    state.selected = new Set(ids);
    render();
  }

  // ---------- Sortable (drag & drop reorder) ----------
  let lastSnapshot = null;
  new Sortable(grid, {
    animation: 160,
    draggable: '.card',
    filter: '.actions, .sel',
    preventOnFilter: false,
    multiDrag: true,
    selectedClass: 'selected',
    // no multiDragKey: a plain click toggles selection, Shift+click selects a range
    avoidImplicitDeselect: true,
    delay: 180,
    delayOnTouchOnly: true,
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    scroll: true,
    bubbleScroll: true,
    onStart() { lastSnapshot = snapshot(); },
    onSelect: syncSelectionFromDom,
    onDeselect: syncSelectionFromDom,
    onEnd() {
      const order = [...grid.querySelectorAll('.card')].map((el) => el.dataset.id);
      const map = new Map(state.pages.map((p) => [p.id, p]));
      const next = order.map((id) => map.get(id)).filter(Boolean);
      if (next.some((p, i) => p !== state.pages[i])) {
        state.history.push(lastSnapshot); state.future = [];
        state.pages = next;
      }
      syncSelectionFromDom();
      render();
    },
  });
  function syncSelectionFromDom() {
    state.selected = new Set([...grid.querySelectorAll('.card.selected')].map((el) => el.dataset.id));
    for (const el of cards.values()) el.querySelector('.sel').checked = el.classList.contains('selected');
    updateChrome();
  }

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.classList.contains('sel')) {
      if (e.target.checked) state.selected.add(id); else state.selected.delete(id);
      render();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'rotl') rotate([id], -90);
    else if (act === 'rotr') rotate([id], 90);
    else if (act === 'dup') duplicate([id]);
    else if (act === 'del') remove([id]);
    else if (act === 'view') openPreview(id);
    else if (act === 'edit') PDFEditor.open(id);
  });
  grid.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card && !e.target.closest('.actions, .sel')) openPreview(card.dataset.id);
  });
  $('workspace').addEventListener('click', (e) => {
    if (e.target === grid || e.target === $('workspace')) setSelection([]);
  });

  // ---------- preview modal ----------
  let previewId = null, previewUrl = null, previewToken = 0;
  async function openPreview(id) {
    previewId = id;
    $('modal').hidden = false;
    await paintPreview();
  }
  function closePreview() {
    $('modal').hidden = true;
    previewId = null;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  }
  async function paintPreview() {
    const p = byId(previewId);
    if (!p) return closePreview();
    const i = state.pages.indexOf(p);
    $('modalTitle').textContent = `${i + 1} / ${state.pages.length} — ${p.kind === 'blank' ? 'Blank page' : p.name}`;
    $('mPrev').disabled = i === 0;
    $('mNext').disabled = i === state.pages.length - 1;
    const stage = $('modalStage');
    const token = ++previewToken;
    if (p.kind === 'blank') { stage.innerHTML = '<div class="blank"></div>'; return; }
    stage.innerHTML = '<div class="spinner"></div>';
    const s = state.sources.get(p.src);
    let url;
    if (s.kind === 'pdf') {
      const page = await s.pdfjs.getPage(p.index + 1);
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(4, 1800 / Math.max(vp1.width, vp1.height)) });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      url = URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.9));
    } else url = URL.createObjectURL(s.blob);
    if (token !== previewToken) { URL.revokeObjectURL(url); return; }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    const img = new Image();
    img.src = url;
    img.alt = p.name;
    try { await img.decode(); } catch { /* shown anyway */ }
    if (token !== previewToken) return;
    stage.innerHTML = '';
    stage.appendChild(img);
    fitPreview();
  }
  function fitPreview() {
    const p = byId(previewId), img = $('modalStage').querySelector('img');
    if (!p || !img) return;
    const box = $('modalStage').getBoundingClientRect();
    const side = p.rot % 180 !== 0;
    const nw = img.naturalWidth || 1, nh = img.naturalHeight || 1;
    const vw = side ? nh : nw, vh = side ? nw : nh;
    const s = Math.min(box.width / vw, box.height / vh);
    img.style.maxWidth = img.style.maxHeight = 'none';
    img.style.width = `${nw * s}px`;
    img.style.height = `${nh * s}px`;
    img.style.transform = `rotate(${p.rot}deg)`;
  }
  function stepPreview(d) {
    const i = state.pages.findIndex((p) => p.id === previewId) + d;
    if (i >= 0 && i < state.pages.length) { previewId = state.pages[i].id; paintPreview(); }
  }
  $('modal').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closePreview(); });
  $('mEdit').onclick = () => { const id = previewId; closePreview(); PDFEditor.open(id); };
  $('mPrev').onclick = () => stepPreview(-1);
  $('mNext').onclick = () => stepPreview(1);
  $('mRotL').onclick = () => { rotate([previewId], -90); fitPreview(); };
  $('mRotR').onclick = () => { rotate([previewId], 90); fitPreview(); };
  $('mDel').onclick = () => {
    const i = state.pages.findIndex((p) => p.id === previewId);
    remove([previewId]);
    const next = state.pages[Math.min(i, state.pages.length - 1)];
    if (next) { previewId = next.id; paintPreview(); } else closePreview();
  };
  window.addEventListener('resize', () => { if (previewId) fitPreview(); });

  // ---------- PDF generation ----------
  function targetSize(w, h) {
    const base = PAGE_SIZES[opts.size];
    let [pw, ph] = base;
    const landscape = opts.orient === 'landscape' || (opts.orient === 'auto' && w > h);
    if (landscape) [pw, ph] = [ph, pw];
    return [pw, ph];
  }

  // Place a w×h box in the page content area according to the fit mode.
  function place(w, h, pw, ph, margin, fit) {
    const bw = pw - 2 * margin, bh = ph - 2 * margin;
    if (fit === 'stretch' || fit === 'cover') return { x: margin, y: margin, width: bw, height: bh };
    const s = Math.min(bw / w, bh / h);
    return { x: margin + (bw - w * s) / 2, y: margin + (bh - h * s) / 2, width: w * s, height: h * s };
  }

  async function encodeImage(out, s, q, coverAspect) {
    // Returns an embedded PDFImage plus its pixel size.
    let bytes = null;
    const mime = s.mime || s.blob.type;
    const canRaw = !opts.gray && !coverAspect && (q.max === Infinity || opts.quality === 'high');
    if (canRaw && /jpe?g/.test(mime)) {
      bytes = new Uint8Array(await s.blob.arrayBuffer());
      if (jpegOrientation(bytes) === 1) {
        try {
          const img = await out.embedJpg(bytes);
          if (q.max === Infinity || Math.max(img.width, img.height) <= q.max) return img;
        } catch { /* re-encode below */ }
      }
    } else if (canRaw && /png/.test(mime) && (q.max === Infinity || s.textPage)) {
      try { return await out.embedPng(new Uint8Array(await s.blob.arrayBuffer())); } catch { /* re-encode below */ }
    }

    const img = await decodeImage(s.blob);
    let [w, h] = dims(img);
    let sx = 0, sy = 0, sw = w, sh = h;
    if (coverAspect) { // crop to the target box aspect
      if (w / h > coverAspect) { sw = h * coverAspect; sx = (w - sw) / 2; } else { sh = w / coverAspect; sy = (h - sh) / 2; }
    }
    const scale = Math.min(1, q.max / Math.max(sw, sh));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale)); c.height = Math.max(1, Math.round(sh * scale));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    release(img);
    if (opts.gray) {
      const d = ctx.getImageData(0, 0, c.width, c.height), a = d.data;
      for (let i = 0; i < a.length; i += 4) { const v = a[i] * 0.299 + a[i + 1] * 0.587 + a[i + 2] * 0.114; a[i] = a[i + 1] = a[i + 2] = v; }
      ctx.putImageData(d, 0, 0);
    }
    const lossless = s.textPage || (/png|gif|svg|bmp/.test(mime) && opts.quality === 'original');
    const blob = await canvasToBlob(c, lossless ? 'image/png' : 'image/jpeg', q.q);
    const buf = new Uint8Array(await blob.arrayBuffer());
    c.width = c.height = 0;
    return lossless ? out.embedPng(buf) : out.embedJpg(buf);
  }

  async function imageSize(s) {
    if (!s.w) { const img = await decodeImage(s.blob); [s.w, s.h] = dims(img); release(img); }
    return [s.w, s.h];
  }

  async function addImagePage(out, s, rot, q) {
    const [w, h] = await imageSize(s);
    const margin = s.textPage ? 0 : opts.margin;
    const fit = s.textPage ? 'contain' : opts.fit;
    let pw, ph;
    if (opts.size === 'auto') {
      const k = 842 / Math.max(w, h); // longest side ≈ A4 height
      pw = w * k + 2 * margin; ph = h * k + 2 * margin;
      if (s.textPage) [pw, ph] = PAGE_SIZES.a4;
    } else [pw, ph] = targetSize(w, h);
    const coverAspect = fit === 'cover' ? (pw - 2 * margin) / (ph - 2 * margin) : 0;
    const img = await encodeImage(out, s, q, coverAspect);
    const page = out.addPage([pw, ph]);
    const rect = place(w, h, pw, ph, margin, fit);
    page.drawImage(img, rect);
    if (rot) page.setRotation(PDFLib.degrees(rot));
    return { pg: page, rect };
  }

  async function rasterPdfPage(out, s, index, rot, q) {
    const page = await s.pdfjs.getPage(index + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: q.raster });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    const blob = await canvasToBlob(c, 'image/jpeg', Math.max(q.q, 0.85));
    c.width = c.height = 0;
    const fake = { blob, mime: 'image/jpeg', w: vp1.width, h: vp1.height };
    if (opts.resizePdf) return addImagePage(out, fake, rot, { ...q, max: Infinity });
    const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const pg = out.addPage([vp1.width, vp1.height]);
    pg.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    if (rot) pg.setRotation(PDFLib.degrees(rot));
    return { pg, rect: null };
  }

  async function buildPdf(pages, onProgress) {
    const { PDFDocument, degrees, StandardFonts, rgb } = await loadPdfLib();
    const out = await PDFDocument.create();
    const q = QUALITY[opts.quality];
    const total = pages.length;

    // Load each source PDF once; copy all its pages in one pass so shared fonts/resources aren't duplicated.
    const libDocs = new Map();
    const copied = new Map(); // page id -> copied PDFPage
    for (const p of pages) {
      if (p.kind !== 'pdf' || libDocs.has(p.src)) continue;
      const s = state.sources.get(p.src);
      let doc = null;
      try { doc = await PDFDocument.load(s.bytes, { updateMetadata: false }); } catch { doc = null; } // encrypted → rasterize
      libDocs.set(p.src, doc);
      if (doc && !opts.resizePdf) {
        const mine = pages.filter((x) => x.kind === 'pdf' && x.src === p.src);
        const copies = await out.copyPages(doc, mine.map((x) => x.index));
        mine.forEach((x, i) => copied.set(x.id, copies[i]));
      }
    }

    const placed = []; // per output page: { pg, rect } — rect is where the page content sits (null = full page)
    for (let i = 0; i < total; i++) {
      const p = pages[i];
      onProgress(i, total);
      if (p.kind === 'blank') {
        const prev = out.getPageCount() ? out.getPage(out.getPageCount() - 1) : null;
        const size = opts.size === 'auto' ? (prev ? [prev.getWidth(), prev.getHeight()] : PAGE_SIZES.a4) : targetSize(1, 1.414);
        const pg = out.addPage(size);
        if (p.rot) pg.setRotation(degrees(p.rot));
        placed.push({ pg, rect: null });
      } else if (p.kind === 'pdf') {
        const s = state.sources.get(p.src);
        const doc = libDocs.get(p.src);
        if (!doc) placed.push(await rasterPdfPage(out, s, p.index, p.rot, q));
        else if (!opts.resizePdf) {
          const pg = copied.get(p.id);
          out.addPage(pg);
          pg.setRotation(degrees(norm(pg.getRotation().angle + p.rot)));
          placed.push({ pg, rect: null });
        } else {
          const srcPage = doc.getPage(p.index);
          const base = srcPage.getRotation().angle;
          const emb = await out.embedPage(srcPage);
          const turned = base % 180 !== 0;
          const [vw, vh] = turned ? [emb.height, emb.width] : [emb.width, emb.height];
          let [pw, ph] = opts.size === 'auto' ? [vw + 2 * opts.margin, vh + 2 * opts.margin] : targetSize(vw, vh);
          // Lay out in the displayed orientation, then rotate the canvas back to the content's native orientation.
          if (turned) [pw, ph] = [ph, pw];
          const box = place(emb.width, emb.height, pw, ph, opts.margin, 'contain');
          const pg = out.addPage([pw, ph]);
          pg.drawPage(emb, box);
          pg.setRotation(degrees(norm(base + p.rot)));
          placed.push({ pg, rect: box });
        }
      } else {
        placed.push(await addImagePage(out, state.sources.get(p.src), p.rot, q));
      }
      if (i % 4 === 3) await tick();
    }

    // edits made in the page editor (text, shapes, drawings, images, signatures)
    for (let i = 0; i < total; i++) {
      const p = pages[i], { pg, rect } = placed[i];
      if (!p.annots || !p.annots.items.length) continue;
      onProgress(i, total, `Applying edits to page ${i + 1}…`);
      await PDFEditor.drawPdf(out, pg, rect, norm(pg.getRotation().angle - p.rot), p.annots);
    }

    // overlays: page numbers + watermark
    const all = out.getPages();
    const wm = sanitize(opts.watermark.trim());
    if (opts.numbers !== 'none' || wm) {
      const font = await out.embedFont(StandardFonts.Helvetica);
      const bold = wm ? await out.embedFont(StandardFonts.HelveticaBold) : null;
      all.forEach((pg, i) => {
        const r = norm(pg.getRotation().angle);
        const box = pg.getCropBox();
        const side = r % 180 !== 0;
        const VW = side ? box.height : box.width, VH = side ? box.width : box.height;
        const map = (vx, vy) => {
          if (r === 90) return [box.x + box.width - vy, box.y + vx];
          if (r === 180) return [box.x + box.width - vx, box.y + box.height - vy];
          if (r === 270) return [box.x + vy, box.y + box.height - vx];
          return [box.x + vx, box.y + vy];
        };
        if (wm) {
          const diag = Math.hypot(VW, VH);
          const size = Math.min(140, (diag * 0.62) / bold.widthOfTextAtSize(wm, 1));
          const tw = bold.widthOfTextAtSize(wm, size), th = size * 0.7;
          const a = (Math.atan2(VH, VW) * 180) / Math.PI;
          const rad = (a * Math.PI) / 180;
          const vx = VW / 2 - (tw / 2) * Math.cos(rad) + (th / 2) * Math.sin(rad);
          const vy = VH / 2 - (tw / 2) * Math.sin(rad) - (th / 2) * Math.cos(rad);
          const [x, y] = map(vx, vy);
          pg.drawText(wm, { x, y, size, font: bold, color: rgb(0.55, 0.55, 0.6), opacity: 0.22, rotate: degrees(r + a) });
        }
        if (opts.numbers !== 'none') {
          const text = opts.numbers.endsWith('-of') ? `Page ${i + 1} of ${all.length}` : String(i + 1);
          const size = Math.max(8, Math.min(12, Math.min(VW, VH) / 50));
          const tw = font.widthOfTextAtSize(text, size);
          const pad = Math.max(18, Math.min(VW, VH) * 0.035);
          const vx = opts.numbers.startsWith('br') ? VW - pad - tw : (VW - tw) / 2;
          const [x, y] = map(vx, pad * 0.8);
          const [bx, by] = map(vx - 4, pad * 0.8 - 4);
          pg.drawRectangle({ x: bx, y: by, width: tw + 8, height: size + 6, color: rgb(1, 1, 1), opacity: 0.75, rotate: degrees(r) });
          pg.drawText(text, { x, y, size, font, color: rgb(0.2, 0.2, 0.25), rotate: degrees(r) });
        }
      });
    }

    out.setTitle(opts.title.trim() || opts.name.trim() || 'Combined document');
    if (opts.author.trim()) out.setAuthor(opts.author.trim());
    out.setCreator('PDF Studio');
    out.setProducer('PDF Studio (pdf-lib)');
    out.setCreationDate(new Date());
    out.setModificationDate(new Date());
    onProgress(total, total, 'Saving…');
    await tick();
    return out.save({ useObjectStreams: true });
  }
  // Standard PDF fonts only cover Latin-1; drop anything else.
  const sanitize = (t) => t.replace(/[^\x20-\x7e\xa0-\xff]/g, '');

  async function create(onlySelected) {
    if (state.busy) return;
    const pages = onlySelected ? state.pages.filter((p) => state.selected.has(p.id)) : state.pages.slice();
    if (!pages.length) return;
    state.busy = true;
    updateChrome();
    $('result').hidden = true;
    $('progress').hidden = false;
    const t0 = performance.now();
    try {
      const bytes = await buildPdf(pages, (i, n, label) => {
        $('progressBar').style.width = `${Math.round((i / n) * 100)}%`;
        $('progressText').textContent = label || `Building page ${Math.min(i + 1, n)} of ${n}…`;
      });
      const name = `${(opts.name.trim() || 'combined').replace(/[\\/:*?"<>|]+/g, '-').replace(/\.pdf$/i, '')}.pdf`;
      if (state.result) URL.revokeObjectURL(state.result.url);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      state.result = { blob, name, url: URL.createObjectURL(blob) };
      download();
      $('resultName').textContent = name;
      $('resultMeta').textContent = ` · ${pages.length} page${pages.length > 1 ? 's' : ''} · ${fmtBytes(blob.size)} · ${((performance.now() - t0) / 1000).toFixed(1)}s`;
      $('result').hidden = false;
      toast('PDF ready — download started', 'ok');
    } catch (err) {
      console.error(err);
      toast(`Failed to create PDF: ${err.message || err}`, 'err', 6000);
    } finally {
      state.busy = false;
      $('progress').hidden = true;
      updateChrome();
    }
  }
  function download() {
    if (!state.result) return;
    const a = document.createElement('a');
    a.href = state.result.url;
    a.download = state.result.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ---------- wiring ----------
  const pick = (input) => { input.value = ''; input.click(); };
  $('btnAdd').onclick = () => pick(fileInput);
  $('dzAdd').onclick = (e) => { e.stopPropagation(); pick(fileInput); };
  dropzone.onclick = () => pick(fileInput);
  $('btnAddFolder').onclick = () => pick(folderInput);
  $('btnCamera').onclick = () => pick(cameraInput);
  $('dzCamera').onclick = (e) => { e.stopPropagation(); pick(cameraInput); };
  for (const input of [fileInput, folderInput, cameraInput]) input.addEventListener('change', () => addFiles(input.files));
  $('btnBlank').onclick = insertBlank;
  $('btnUndo').onclick = undo;
  $('btnRedo').onclick = redo;
  $('btnClear').onclick = () => { if (state.pages.length) { commit(); state.pages = []; state.selected.clear(); render(); toast('Cleared · Ctrl+Z to undo', '', 2200); } };
  $('chkAll').onchange = (e) => setSelection(e.target.checked ? state.pages.map((p) => p.id) : []);
  const selIds = () => state.pages.filter((p) => state.selected.has(p.id)).map((p) => p.id);
  $('selRotL').onclick = () => rotate(selIds(), -90);
  $('selRotR').onclick = () => rotate(selIds(), 90);
  $('selDup').onclick = () => duplicate(selIds());
  $('selDel').onclick = () => remove(selIds());
  $('selFirst').onclick = () => moveSelected(true);
  $('selLast').onclick = () => moveSelected(false);
  $('btnCreate').onclick = () => create(false);
  $('btnCreateSel').onclick = () => create(true);
  $('btnDownloadAgain').onclick = download;
  $('btnOpenResult').onclick = () => state.result && window.open(state.result.url, '_blank');
  $('zoom').oninput = (e) => { document.documentElement.style.setProperty('--thumb', `${e.target.value}px`); store.set('pdfstudio.zoom', e.target.value); };
  const z = store.get('pdfstudio.zoom');
  if (z) { $('zoom').value = z; document.documentElement.style.setProperty('--thumb', `${z}px`); }

  $('btnSort').onclick = (e) => { e.stopPropagation(); $('sortMenu').hidden = !$('sortMenu').hidden; };
  $('sortMenu').onclick = (e) => { const b = e.target.closest('[data-sort]'); if (b) { sortPages(b.dataset.sort); $('sortMenu').hidden = true; } };
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) $('sortMenu').hidden = true; });

  $('btnSettings').onclick = () => panel.classList.add('open');
  $('btnPanelClose').onclick = () => panel.classList.remove('open');
  panel.querySelector('.panel-foot').addEventListener('click', (e) => {
    if (!panel.classList.contains('open') && matchMedia('(max-width: 900px)').matches && !e.target.closest('button')) panel.classList.add('open');
  });

  // theme
  const applyTheme = (t) => {
    if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    $('btnTheme').innerHTML = `<svg><use href="#${dark ? 'i-sun' : 'i-moon'}"/></svg>`;
  };
  applyTheme(store.get('pdfstudio.theme'));
  $('btnTheme').onclick = () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const t = dark ? 'light' : 'dark';
    store.set('pdfstudio.theme', t); applyTheme(t);
  };

  // drag files from desktop
  let dragDepth = 0;
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0; $('dropOverlay').hidden = true;
    addFiles(await filesFromDrop(e.dataTransfer));
  });
  // Expand dropped folders.
  async function filesFromDrop(dt) {
    const entries = [...dt.items || []].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length || !entries.some((en) => en.isDirectory)) return [...dt.files];
    const out = [];
    const walk = async (entry, path) => {
      if (entry.isFile) {
        const f = await new Promise((res, rej) => entry.file(res, rej));
        Object.defineProperty(f, 'webkitRelativePath', { value: path + f.name });
        out.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const child of batch) await walk(child, `${path}${entry.name}/`);
        } while (batch.length);
      }
    };
    for (const en of entries) await walk(en, '');
    return out;
  }

  // paste screenshots / files
  document.addEventListener('paste', (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files.map((f, i) => (f.name && f.name !== 'image.png') ? f : new File([f], `Pasted ${new Date().toLocaleTimeString().replace(/:/g, '.')}${i ? `-${i}` : ''}.${(f.type.split('/')[1] || 'png')}`, { type: f.type })));
    }
  });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (PDFEditor.isOpen()) return;
    const typing = e.target.closest && e.target.closest('input[type=text], textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    if (!$('modal').hidden) {
      if (e.key === 'Escape') closePreview();
      else if (e.key === 'ArrowLeft') stepPreview(-1);
      else if (e.key === 'ArrowRight') stepPreview(1);
      else if (e.key === 'r') $('mRotR').click();
      else if (e.key === 'R') $('mRotL').click();
      else if (e.key === 'Delete') $('mDel').click();
      return;
    }
    if (typing) return;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (mod && k === 'y') { e.preventDefault(); redo(); }
    else if (mod && k === 'a' && state.pages.length) { e.preventDefault(); setSelection(state.pages.map((p) => p.id)); }
    else if (mod && k === 's') { e.preventDefault(); create(false); }
    else if (mod && k === 'o') { e.preventDefault(); pick(fileInput); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected.size) { e.preventDefault(); remove(selIds()); }
    else if (e.key === 'Escape') { setSelection([]); panel.classList.remove('open'); }
    else if (k === 'r' && state.selected.size && !mod) rotate(selIds(), e.shiftKey ? -90 : 90);
  });

  window.addEventListener('beforeunload', (e) => { if (state.pages.length && !state.result) { e.preventDefault(); e.returnValue = ''; } });

  PDFEditor.init({
    page: byId, pages: () => state.pages, commit, render, toast, decodeImage, canvasToBlob, baseCanvas,
  });
  initSettings();
  render();
  // Warm up the PDF engine while the user picks files.
  (window.requestIdleCallback || setTimeout)(() => loadPdfLib().catch(() => {}));

  window.__pdfStudio = { state, addFiles, create, buildPdf, opts }; // handy for debugging / tests
})();
