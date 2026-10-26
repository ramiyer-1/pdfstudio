/* PDF Studio — page editor: add text, shapes, freehand, highlights, whiteout, images and signatures.
   Annotations are stored per page and written into the final PDF as real vector content. */
(() => {
  'use strict';

  const FONT_CSS = {
    helv: 'Helvetica, Arial, "Liberation Sans", sans-serif',
    times: '"Times New Roman", Times, "Liberation Serif", serif',
    courier: '"Courier New", Courier, "Liberation Mono", monospace',
  };
  const PDF_FONT = { // [regular, bold, italic, boldItalic] standard font names
    helv: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
    times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
    courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique'],
  };
  const HL_COLOR = '#fde047';
  const STICKY = new Set(['pen', 'highlight', 'whiteout']); // tools that stay active after use
  const BOXED = new Set(['rect', 'ellipse', 'highlight', 'whiteout', 'image']);
  const EW = 1000; // editor frame width in virtual units

  const images = new Map(); // id -> { blob, url, img, w, h, mime }
  let imgSeq = 0;

  let api; // provided by app.js
  const $ = (id) => document.getElementById(id);
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const rad = (d) => (d * Math.PI) / 180;

  const ed = {
    open: false, pageId: null, rot: 0, h: 1414, items: [], sel: -1, tool: 'select',
    hist: [], fut: [], drag: null, editing: -1, scale: 1,
    props: { color: '#111827', sw: 4, size: 28, font: 'helv', bold: false, italic: false, fill: false, opacity: 1 },
  };

  // ---------- measuring ----------
  const mctx = document.createElement('canvas').getContext('2d');
  const cssFont = (it, size = it.size) => `${it.italic ? 'italic ' : ''}${it.bold ? '700 ' : ''}${size}px ${FONT_CSS[it.font] || FONT_CSS.helv}`;
  function textBox(it) {
    mctx.font = cssFont(it);
    const lines = it.text.split('\n');
    const w = Math.max(it.size * 0.5, ...lines.map((l) => mctx.measureText(l).width));
    return { x: it.x, y: it.y, w, h: lines.length * it.size * 1.2 };
  }
  function bbox(it) {
    if (it.type === 'text') return textBox(it);
    if (it.type === 'line' || it.type === 'arrow') {
      return { x: Math.min(it.x1, it.x2), y: Math.min(it.y1, it.y2), w: Math.abs(it.x2 - it.x1), h: Math.abs(it.y2 - it.y1) };
    }
    if (it.type === 'pen') {
      const xs = it.pts.map((p) => p[0]), ys = it.pts.map((p) => p[1]);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    return { x: it.x, y: it.y, w: it.w, h: it.h };
  }
  const normBox = (it) => {
    if (it.w < 0) { it.x += it.w; it.w = -it.w; }
    if (it.h < 0) { it.y += it.h; it.h = -it.h; }
  };
  function arrowHead(it) {
    const a = Math.atan2(it.y2 - it.y1, it.x2 - it.x1);
    const L = Math.max(it.sw * 3.5, 18);
    return {
      tip: [it.x2, it.y2],
      l: [it.x2 - L * Math.cos(a - 0.42), it.y2 - L * Math.sin(a - 0.42)],
      r: [it.x2 - L * Math.cos(a + 0.42), it.y2 - L * Math.sin(a + 0.42)],
      base: [it.x2 - L * 0.8 * Math.cos(a), it.y2 - L * 0.8 * Math.sin(a)],
    };
  }

  // ---------- SVG rendering ----------
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function itemSvg(it, i, parent) {
    const g = el('g', { 'data-i': i, opacity: it.type === 'whiteout' ? 1 : it.opacity }, parent);
    const hitStroke = { fill: 'none', stroke: 'transparent', 'stroke-width': Math.max(it.sw || 0, 18), 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'pointer-events': 'stroke' };
    switch (it.type) {
      case 'rect':
        el('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: it.fill ? it.color : 'none', stroke: it.color, 'stroke-width': it.sw, 'pointer-events': 'all' }, g);
        break;
      case 'ellipse':
        el('ellipse', { cx: it.x + it.w / 2, cy: it.y + it.h / 2, rx: Math.abs(it.w / 2), ry: Math.abs(it.h / 2), fill: it.fill ? it.color : 'none', stroke: it.color, 'stroke-width': it.sw, 'pointer-events': 'all' }, g);
        break;
      case 'highlight':
        el('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: it.color, style: 'mix-blend-mode:multiply' }, g);
        break;
      case 'whiteout':
        el('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: it.color || '#ffffff' }, g);
        break;
      case 'line': case 'arrow': {
        let [x2, y2] = [it.x2, it.y2];
        if (it.type === 'arrow') {
          const h = arrowHead(it);
          [x2, y2] = h.base;
          el('polygon', { points: [h.tip, h.l, h.r].map((p) => p.join(',')).join(' '), fill: it.color }, g);
        }
        el('line', { x1: it.x1, y1: it.y1, x2, y2, stroke: it.color, 'stroke-width': it.sw, 'stroke-linecap': 'round' }, g);
        el('line', { x1: it.x1, y1: it.y1, x2: it.x2, y2: it.y2, ...hitStroke }, g);
        break;
      }
      case 'pen': {
        const pts = it.pts.map((p) => p.join(',')).join(' ');
        el('polyline', { points: pts, fill: 'none', stroke: it.color, 'stroke-width': it.sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, g);
        el('polyline', { points: pts, ...hitStroke }, g);
        break;
      }
      case 'image': {
        const im = images.get(it.img);
        el('image', { href: im ? im.url : '', x: it.x, y: it.y, width: it.w, height: it.h, preserveAspectRatio: 'none' }, g);
        el('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: 'transparent' }, g);
        break;
      }
      case 'text': {
        if (i === ed.editing) break;
        const t = el('text', {
          'font-family': FONT_CSS[it.font], 'font-size': it.size, 'font-weight': it.bold ? 700 : 400,
          'font-style': it.italic ? 'italic' : 'normal', fill: it.color, 'xml:space': 'preserve',
        }, g);
        it.text.split('\n').forEach((line, k) => {
          const s = el('tspan', { x: it.x, y: it.y + it.size * 0.8 + k * it.size * 1.2 }, t);
          s.textContent = line || ' ';
        });
        const b = textBox(it);
        el('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'transparent' }, g);
        break;
      }
    }
    return g;
  }

  function renderSvg() {
    const svg = $('edSvg');
    svg.setAttribute('viewBox', `0 0 ${EW} ${ed.h}`);
    svg.textContent = '';
    ed.items.forEach((it, i) => itemSvg(it, i, svg));
    const it = ed.items[ed.sel];
    if (it && ed.editing !== ed.sel) {
      const k = 1 / ed.scale; // keep handles a constant on-screen size
      const sel = el('g', { class: 'ed-sel' }, svg);
      if (it.type === 'line' || it.type === 'arrow') {
        el('circle', { cx: it.x1, cy: it.y1, r: 7 * k, 'data-h': 'p1', class: 'ed-handle' }, sel);
        el('circle', { cx: it.x2, cy: it.y2, r: 7 * k, 'data-h': 'p2', class: 'ed-handle' }, sel);
      } else {
        const b = bbox(it), pad = 4 * k;
        el('rect', { x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, class: 'ed-box', 'stroke-width': 1.5 * k, 'stroke-dasharray': `${5 * k} ${4 * k}` }, sel);
        el('rect', { x: b.x + b.w + pad - 7 * k, y: b.y + b.h + pad - 7 * k, width: 14 * k, height: 14 * k, 'data-h': 'br', class: 'ed-handle' }, sel);
      }
    }
    $('edUndo').disabled = !ed.hist.length;
    $('edRedo').disabled = !ed.fut.length;
    $('edDel').disabled = ed.sel < 0;
  }

  // ---------- history ----------
  function pushHist() { ed.hist.push(JSON.stringify(ed.items)); if (ed.hist.length > 200) ed.hist.shift(); ed.fut = []; }
  function undo() { if (!ed.hist.length) return; commitText(); ed.fut.push(JSON.stringify(ed.items)); ed.items = JSON.parse(ed.hist.pop()); ed.sel = -1; renderSvg(); }
  function redo() { if (!ed.fut.length) return; commitText(); ed.hist.push(JSON.stringify(ed.items)); ed.items = JSON.parse(ed.fut.pop()); ed.sel = -1; renderSvg(); }

  // ---------- tools & properties ----------
  function setTool(t) {
    commitText();
    ed.tool = t;
    if (t !== 'select') ed.sel = -1;
    document.querySelectorAll('#edTools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
    $('edSvg').dataset.tool = t;
    renderSvg(); syncProps();
  }

  function syncProps() {
    const it = ed.items[ed.sel];
    const ctx = it ? it.type : ed.tool;
    const src = it || ed.props;
    const show = {
      color: ctx !== 'whiteout' && ctx !== 'image' && ctx !== 'select',
      width: ['pen', 'rect', 'ellipse', 'line', 'arrow'].includes(ctx),
      text: ctx === 'text',
      fill: ctx === 'rect' || ctx === 'ellipse',
      opacity: !['whiteout', 'select'].includes(ctx),
    };
    for (const k in show) document.querySelectorAll(`[data-prop-group="${k}"]`).forEach((n) => { n.hidden = !show[k]; });
    const color = it ? it.color : (ctx === 'highlight' ? HL_COLOR : ed.props.color);
    $('edColor').value = color || '#000000';
    document.querySelectorAll('#edSwatches button').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === (color || '').toLowerCase()));
    $('edWidth').value = src.sw ?? ed.props.sw;
    $('edWidthVal').textContent = $('edWidth').value;
    $('edFont').value = src.font || ed.props.font;
    $('edSize').value = Math.round(src.size || ed.props.size);
    $('edBold').classList.toggle('on', !!src.bold);
    $('edItalic').classList.toggle('on', !!src.italic);
    $('edFill').checked = !!src.fill;
    $('edOpacity').value = Math.round((src.opacity ?? 1) * 100);
    $('edHint').textContent = {
      select: 'Click an item to select it · drag to move · corner handle to resize · Del to delete',
      text: 'Click anywhere on the page to type · click existing text to edit it',
      pen: 'Draw freely with mouse, pen or finger',
      highlight: 'Drag over text to highlight it',
      rect: 'Drag to draw a rectangle', ellipse: 'Drag to draw an ellipse',
      line: 'Drag to draw a line', arrow: 'Drag to draw an arrow',
      whiteout: 'Drag to cover (erase) content with white — then add new text on top',
    }[ed.tool] || '';
  }

  // Apply a property change to the selected item (if any) and to the defaults for new items.
  function applyProp(key, value) {
    const it = ed.items[ed.sel];
    if (key !== 'color' || ed.tool !== 'highlight' || it) ed.props[key] = value;
    if (it && key in it || (it && key === 'fill' && (it.type === 'rect' || it.type === 'ellipse'))) {
      if (it.type === 'whiteout' && key === 'color') return;
      pushHist();
      it[key] = value;
      if (ed.editing === ed.sel) styleTextarea();
      renderSvg();
    }
    syncProps();
  }

  // ---------- pointer interaction ----------
  function toPt(e) {
    const r = $('edSvg').getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * EW, y: ((e.clientY - r.top) / r.height) * ed.h };
  }
  function newItem(type, pt) {
    const p = ed.props;
    const base = { type, color: type === 'highlight' ? HL_COLOR : type === 'whiteout' ? '#ffffff' : p.color, opacity: type === 'highlight' ? 0.45 : p.opacity };
    if (type === 'line' || type === 'arrow') return { ...base, x1: pt.x, y1: pt.y, x2: pt.x, y2: pt.y, sw: p.sw };
    if (type === 'pen') return { ...base, pts: [[pt.x, pt.y]], sw: p.sw };
    return { ...base, x: pt.x, y: pt.y, w: 0, h: 0, sw: p.sw, fill: p.fill };
  }

  function onDown(e) {
    if (e.button !== 0) return;
    const svg = $('edSvg');
    const pt = toPt(e);
    const gEl = e.target.closest && e.target.closest('[data-i]');
    const hit = gEl ? Number(gEl.dataset.i) : -1;
    if (ed.editing >= 0) {
      const wasEditing = ed.editing;
      commitText();
      if (ed.tool === 'text' && hit !== wasEditing) { e.preventDefault(); return; }
    }
    if (ed.tool === 'select') {
      const h = e.target.dataset && e.target.dataset.h;
      if (h && ed.sel >= 0) ed.drag = { mode: h, start: pt, orig: clone(ed.items[ed.sel]), box: bbox(ed.items[ed.sel]), snap: JSON.stringify(ed.items) };
      else if (hit >= 0) { ed.sel = hit; ed.drag = { mode: 'move', start: pt, orig: clone(ed.items[hit]), snap: JSON.stringify(ed.items) }; }
      else ed.sel = -1;
      renderSvg(); syncProps();
    } else if (ed.tool === 'text') {
      e.preventDefault();
      if (hit >= 0 && ed.items[hit].type === 'text') { ed.sel = hit; startEditText(hit); return; }
      pushHist();
      const p = ed.props;
      ed.items.push({ type: 'text', x: pt.x, y: pt.y - p.size * 0.6, text: '', size: p.size, font: p.font, bold: p.bold, italic: p.italic, color: p.color, opacity: p.opacity });
      ed.sel = ed.items.length - 1;
      startEditText(ed.sel, true);
      return;
    } else {
      pushHist();
      ed.items.push(newItem(ed.tool, pt));
      ed.sel = ed.items.length - 1;
      ed.drag = { mode: 'create', start: pt };
      renderSvg();
    }
    if (ed.drag) svg.setPointerCapture(e.pointerId);
  }

  function onMove(e) {
    const d = ed.drag;
    if (!d) return;
    const pt = toPt(e);
    const it = ed.items[ed.sel];
    if (!it) return;
    const dx = pt.x - d.start.x, dy = pt.y - d.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
    if (d.mode === 'create') {
      if (it.type === 'pen') {
        const last = it.pts[it.pts.length - 1];
        if (Math.hypot(pt.x - last[0], pt.y - last[1]) > 1.5) it.pts.push([+pt.x.toFixed(1), +pt.y.toFixed(1)]);
      } else if (it.type === 'line' || it.type === 'arrow') {
        let { x, y } = pt;
        if (e.shiftKey) { // snap to 45°
          const a = Math.round(Math.atan2(y - it.y1, x - it.x1) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(x - it.x1, y - it.y1);
          x = it.x1 + len * Math.cos(a); y = it.y1 + len * Math.sin(a);
        }
        it.x2 = x; it.y2 = y;
      } else {
        it.w = dx; it.h = dy;
        if (e.shiftKey) { const s = Math.max(Math.abs(dx), Math.abs(dy)); it.w = Math.sign(dx || 1) * s; it.h = Math.sign(dy || 1) * s; }
      }
    } else if (d.mode === 'move') {
      const o = d.orig;
      if ('x1' in o) { it.x1 = o.x1 + dx; it.y1 = o.y1 + dy; it.x2 = o.x2 + dx; it.y2 = o.y2 + dy; }
      else if (o.pts) it.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
      else { it.x = o.x + dx; it.y = o.y + dy; }
    } else if (d.mode === 'p1') { it.x1 = d.orig.x1 + dx; it.y1 = d.orig.y1 + dy; }
    else if (d.mode === 'p2') { it.x2 = d.orig.x2 + dx; it.y2 = d.orig.y2 + dy; }
    else if (d.mode === 'br') {
      const b = d.box, o = d.orig;
      const nw = Math.max(6, b.w + dx), nh = Math.max(6, b.h + dy);
      if (o.type === 'text') it.size = Math.max(6, o.size * (nh / b.h));
      else if (o.type === 'pen') {
        const sx = b.w ? nw / b.w : 1, sy = b.h ? nh / b.h : 1;
        it.pts = o.pts.map(([x, y]) => [b.x + (x - b.x) * sx, b.y + (y - b.y) * sy]);
      } else if (o.type === 'image' && !e.shiftKey) { const s = Math.max(nw / b.w, nh / b.h); it.w = b.w * s; it.h = b.h * s; }
      else { it.w = nw; it.h = nh; }
    }
    renderSvg();
  }

  function onUp() {
    const d = ed.drag;
    if (!d) return;
    ed.drag = null;
    const it = ed.items[ed.sel];
    if (d.mode === 'create' && it) {
      if (!d.moved) { // simple click → sensible default size
        if (it.type === 'pen') it.pts.push([it.pts[0][0] + 0.1, it.pts[0][1]]);
        else if (it.type === 'line' || it.type === 'arrow') { it.x2 = it.x1 + 160; }
        else if (it.type === 'highlight') { it.w = 220; it.h = 34; it.y -= 17; }
        else { it.w = 200; it.h = 120; it.x -= 100; it.y -= 60; }
      }
      if (BOXED.has(it.type)) normBox(it);
      if (!STICKY.has(ed.tool)) setTool('select');
    } else if (d.snap && d.moved) {
      ed.hist.push(d.snap); ed.fut = [];
      if (it && BOXED.has(it.type)) normBox(it);
    }
    renderSvg(); syncProps();
  }

  // ---------- inline text editing ----------
  function styleTextarea() {
    const it = ed.items[ed.editing];
    if (!it) return;
    const ta = $('edText'), s = ed.scale;
    Object.assign(ta.style, {
      left: `${it.x * s}px`, top: `${it.y * s}px`, fontSize: `${it.size * s}px`,
      fontFamily: FONT_CSS[it.font], fontWeight: it.bold ? 700 : 400, fontStyle: it.italic ? 'italic' : 'normal',
      color: it.color, opacity: it.opacity,
    });
    autosize();
  }
  function autosize() {
    const it = ed.items[ed.editing];
    if (!it) return;
    const ta = $('edText');
    const b = textBox({ ...it, text: ta.value || ' ' });
    ta.style.width = `${(b.w + it.size) * ed.scale}px`;
    ta.style.height = `${b.h * ed.scale + 4}px`;
  }
  function startEditText(i, fresh) {
    ed.editing = i;
    ed.textSnap = fresh ? null : JSON.stringify(ed.items);
    const ta = $('edText');
    ta.value = ed.items[i].text;
    ta.hidden = false;
    styleTextarea();
    renderSvg(); syncProps();
    const focus = () => { if (ed.editing === i && document.activeElement !== ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } };
    focus();
    setTimeout(focus, 0);
  }
  function commitText() {
    if (ed.editing < 0) return;
    const i = ed.editing, it = ed.items[i];
    const ta = $('edText');
    ed.editing = -1;
    ta.hidden = true;
    if (!it) return;
    const text = ta.value.replace(/\s+$/, '');
    if (!text.trim()) {
      ed.items.splice(i, 1);
      ed.sel = -1;
      if (!ed.textSnap && ed.hist.length) ed.hist.pop(); // empty new box → nothing happened
    } else {
      if (ed.textSnap && text !== it.text) { ed.hist.push(ed.textSnap); ed.fut = []; }
      it.text = text;
    }
    ed.textSnap = null;
    renderSvg(); syncProps();
  }

  // ---------- images & signature ----------
  async function addImageBlob(blob, widthUnits = 360) {
    let img = await api.decodeImage(blob);
    let [w, h] = [img.width || img.naturalWidth, img.height || img.naturalHeight];
    let out = blob, mime = blob.type;
    const max = 2000;
    if (!/^image\/(jpeg|png)$/.test(mime) || Math.max(w, h) > max) { // normalise to PNG/JPEG for the PDF
      const s = Math.min(1, max / Math.max(w, h));
      const c = document.createElement('canvas');
      c.width = Math.round(w * s); c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      mime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      out = await api.canvasToBlob(c, mime, 0.92);
      w = c.width; h = c.height;
    }
    if (img.close) img.close();
    const id = `img${++imgSeq}`;
    const el2 = new Image();
    el2.src = URL.createObjectURL(out);
    await el2.decode().catch(() => {});
    images.set(id, { blob: out, url: el2.src, img: el2, w, h, mime });
    const iw = Math.min(widthUnits, EW * 0.8), ih = iw * (h / w);
    pushHist();
    ed.items.push({ type: 'image', img: id, x: (EW - iw) / 2, y: (ed.h - ih) / 2, w: iw, h: ih, opacity: 1 });
    ed.sel = ed.items.length - 1;
    setTool('select');
  }

  const sign = { drawing: false, strokes: [], color: '#1e3a8a' };
  function openSign() {
    $('signModal').hidden = false;
    sign.strokes = [];
    paintSign();
  }
  function paintSign() {
    const c = $('signPad');
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, r.width, r.height);
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = sign.color;
    ctx.lineWidth = 2.6;
    for (const s of sign.strokes) {
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      ctx.stroke();
    }
  }
  async function useSignature() {
    if (!sign.strokes.length) { api.toast('Draw your signature first', 'err'); return; }
    const pts = sign.strokes.flat();
    const pad = 6, k = 3;
    const x0 = Math.min(...pts.map((p) => p[0])) - pad, y0 = Math.min(...pts.map((p) => p[1])) - pad;
    const x1 = Math.max(...pts.map((p) => p[0])) + pad, y1 = Math.max(...pts.map((p) => p[1])) + pad;
    const c = document.createElement('canvas');
    c.width = Math.ceil((x1 - x0) * k); c.height = Math.ceil((y1 - y0) * k);
    const ctx = c.getContext('2d');
    ctx.scale(k, k); ctx.translate(-x0, -y0);
    ctx.lineCap = ctx.lineJoin = 'round'; ctx.strokeStyle = sign.color; ctx.lineWidth = 2.6;
    for (const s of sign.strokes) {
      ctx.beginPath();
      s.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (s.length === 1) ctx.lineTo(s[0][0] + 0.1, s[0][1]);
      ctx.stroke();
    }
    $('signModal').hidden = true;
    await addImageBlob(await api.canvasToBlob(c, 'image/png'), 260);
  }

  // ---------- open / close ----------
  async function open(pageId) {
    const p = api.page(pageId);
    if (!p) return;
    commitText();
    ed.open = true; ed.pageId = pageId;
    const a = p.annots;
    ed.rot = a && a.items.length ? a.rot : p.rot;
    ed.items = a ? clone(a.items) : [];
    ed.hist = []; ed.fut = []; ed.sel = -1; ed.drag = null;
    $('editor').hidden = false;
    document.body.classList.add('no-scroll');
    const idx = api.pages().indexOf(p);
    $('edPage').textContent = `Page ${idx + 1} of ${api.pages().length}`;
    $('edPrev').disabled = idx === 0;
    $('edNext').disabled = idx === api.pages().length - 1;
    const bg = $('edBg');
    bg.width = 10; bg.height = 14;
    $('edLoading').hidden = false;
    setTool(ed.tool === 'select' || !ed.tool ? 'select' : ed.tool);
    try {
      const base = await api.baseCanvas(p, 2000);
      if (ed.pageId !== pageId) return;
      const side = ed.rot % 180 !== 0;
      bg.width = side ? base.height : base.width;
      bg.height = side ? base.width : base.height;
      const ctx = bg.getContext('2d');
      ctx.translate(bg.width / 2, bg.height / 2);
      ctx.rotate(rad(ed.rot));
      ctx.drawImage(base, -base.width / 2, -base.height / 2);
      ed.h = (EW * bg.height) / bg.width;
      if (a && a.items.length && Math.abs(a.h - ed.h) > 0.5) { // frame changed (e.g. different render) → rescale
        const sy = ed.h / a.h;
        ed.items.forEach((it) => scaleY(it, sy));
      }
    } catch (err) {
      console.error(err);
      api.toast('Could not render this page for editing', 'err');
    }
    $('edLoading').hidden = true;
    layout();
    renderSvg(); syncProps();
  }
  function scaleY(it, sy) {
    if ('y1' in it) { it.y1 *= sy; it.y2 *= sy; } else if (it.pts) it.pts = it.pts.map(([x, y]) => [x, y * sy]);
    else { it.y *= sy; if (it.h !== undefined) it.h *= sy; }
  }

  function layout() {
    if (!ed.open) return;
    const wrap = $('edWrap').getBoundingClientRect();
    const pad = 24;
    const s = Math.min((wrap.width - pad * 2) / EW, (wrap.height - pad * 2) / ed.h);
    ed.scale = Math.max(0.05, s);
    const stage = $('edStage');
    stage.style.width = `${EW * ed.scale}px`;
    stage.style.height = `${ed.h * ed.scale}px`;
    if (ed.editing >= 0) styleTextarea();
  }

  function save() {
    commitText();
    const p = api.page(ed.pageId);
    if (!p) return;
    const before = JSON.stringify(p.annots ? p.annots.items : []);
    const after = JSON.stringify(ed.items);
    if (before !== after) {
      api.commit();
      const q = api.page(ed.pageId);
      q.annots = ed.items.length ? { rot: ed.rot, w: EW, h: ed.h, items: clone(ed.items) } : null;
      api.render();
    }
  }
  function close(doSave) {
    if (doSave) save();
    else if (ed.hist.length && !confirm('Discard your changes to this page?')) return;
    commitText();
    ed.open = false; ed.pageId = null;
    $('editor').hidden = true;
    document.body.classList.remove('no-scroll');
  }
  function step(d) {
    save();
    const list = api.pages();
    const i = list.findIndex((p) => p.id === ed.pageId) + d;
    if (i >= 0 && i < list.length) open(list[i].id);
  }

  // ---------- drawing annotations: canvas (thumbnails, raster fallback) ----------
  function drawCanvas(ctx, items) {
    for (const it of items) {
      ctx.save();
      ctx.globalAlpha = it.type === 'whiteout' ? 1 : it.opacity ?? 1;
      ctx.strokeStyle = ctx.fillStyle = it.color || '#000';
      ctx.lineWidth = it.sw || 1;
      ctx.lineCap = ctx.lineJoin = 'round';
      switch (it.type) {
        case 'rect': if (it.fill) ctx.fillRect(it.x, it.y, it.w, it.h); ctx.strokeRect(it.x, it.y, it.w, it.h); break;
        case 'ellipse':
          ctx.beginPath(); ctx.ellipse(it.x + it.w / 2, it.y + it.h / 2, Math.abs(it.w / 2), Math.abs(it.h / 2), 0, 0, Math.PI * 2);
          if (it.fill) ctx.fill(); ctx.stroke(); break;
        case 'highlight': ctx.globalCompositeOperation = 'multiply'; ctx.fillRect(it.x, it.y, it.w, it.h); break;
        case 'whiteout': ctx.fillStyle = it.color || '#fff'; ctx.fillRect(it.x, it.y, it.w, it.h); break;
        case 'line': case 'arrow': {
          let [x2, y2] = [it.x2, it.y2];
          if (it.type === 'arrow') {
            const h = arrowHead(it);
            [x2, y2] = h.base;
            ctx.beginPath(); ctx.moveTo(...h.tip); ctx.lineTo(...h.l); ctx.lineTo(...h.r); ctx.closePath(); ctx.fill();
          }
          ctx.beginPath(); ctx.moveTo(it.x1, it.y1); ctx.lineTo(x2, y2); ctx.stroke(); break;
        }
        case 'pen':
          ctx.beginPath(); it.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); break;
        case 'image': { const im = images.get(it.img); if (im) ctx.drawImage(im.img, it.x, it.y, it.w, it.h); break; }
        case 'text':
          ctx.font = cssFont(it); ctx.textBaseline = 'alphabetic';
          it.text.split('\n').forEach((l, k) => ctx.fillText(l, it.x, it.y + it.size * 0.8 + k * it.size * 1.2));
          break;
      }
      ctx.restore();
    }
  }

  // Composite annotations onto a base-orientation thumbnail canvas.
  function drawOnBase(ctx, W, H, annots) {
    const side = annots.rot % 180 !== 0;
    const VW = side ? H : W, VH = side ? W : H;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.rotate(rad(-annots.rot));
    ctx.translate(-VW / 2, -VH / 2);
    ctx.scale(VW / annots.w, VH / annots.h);
    drawCanvas(ctx, annots.items);
    ctx.restore();
  }

  // ---------- drawing annotations into the PDF ----------
  const hex = (c, L) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(c || '') || ['', '000000'];
    const n = parseInt(m[1], 16);
    return L.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  /**
   * pg: PDFPage, contentRect: user-space rect the page content occupies (null = whole page),
   * native: page rotation that shows the content upright, annots: { rot, w, h, items }.
   */
  async function drawPdf(out, pg, contentRect, native, annots) {
    const L = window.PDFLib;
    const a = ((native + annots.rot) % 360 + 360) % 360;
    const box = pg.getCropBox();
    const side = a % 180 !== 0;
    const VW = side ? box.height : box.width, VH = side ? box.width : box.height;
    const toUser = (vx, vy) => {
      if (a === 90) return [box.x + box.width - vy, box.y + vx];
      if (a === 180) return [box.x + box.width - vx, box.y + box.height - vy];
      if (a === 270) return [box.x + vy, box.y + box.height - vx];
      return [box.x + vx, box.y + vy];
    };
    const toVis = (x, y) => {
      const ux = x - box.x, uy = y - box.y;
      if (a === 90) return [uy, box.width - ux];
      if (a === 180) return [box.width - ux, box.height - uy];
      if (a === 270) return [box.height - uy, ux];
      return [ux, uy];
    };
    let cr = { x: 0, y: 0, w: VW, h: VH };
    if (contentRect) {
      const c = [[contentRect.x, contentRect.y], [contentRect.x + contentRect.width, contentRect.y + contentRect.height]].map(([x, y]) => toVis(x, y));
      const xs = c.map((p) => p[0]), ys = c.map((p) => p[1]);
      cr = { x: Math.min(...xs), y: Math.min(...ys), w: Math.abs(xs[1] - xs[0]), h: Math.abs(ys[1] - ys[0]) };
    }
    const sx = cr.w / annots.w, sy = cr.h / annots.h, s = Math.sqrt(sx * sy);
    const P = (x, y) => toUser(cr.x + x * sx, cr.y + cr.h - y * sy); // editor (top-left origin) → PDF user space
    const rot = L.degrees(a);
    const pathOf = (pts, close) => pts.map(([x, y], i) => { const [ux, uy] = P(x, y); return `${i ? 'L' : 'M'}${ux.toFixed(2)},${(-uy).toFixed(2)}`; }).join(' ') + (close ? ' Z' : '');

    out.__fonts = out.__fonts || {};
    out.__imgs = out.__imgs || {};
    const font = async (name) => (out.__fonts[name] ||= await out.embedFont(name));
    const embedImg = async (id) => {
      if (!out.__imgs[id]) {
        const im = images.get(id);
        if (!im) return null;
        const bytes = new Uint8Array(await im.blob.arrayBuffer());
        out.__imgs[id] = im.mime === 'image/jpeg' ? await out.embedJpg(bytes) : await out.embedPng(bytes);
      }
      return out.__imgs[id];
    };
    const boxAt = (x, y, w, h) => { const [ux, uy] = P(x, y + h); return { x: ux, y: uy, width: w * sx, height: h * sy, rotate: rot }; };

    for (const it of annots.items) {
      const color = hex(it.color, L);
      const opacity = it.type === 'whiteout' ? 1 : it.opacity ?? 1;
      switch (it.type) {
        case 'rect':
          pg.drawRectangle({ ...boxAt(it.x, it.y, it.w, it.h), color: it.fill ? color : undefined, borderColor: color, borderWidth: it.sw * s, opacity, borderOpacity: opacity });
          break;
        case 'highlight':
          pg.drawRectangle({ ...boxAt(it.x, it.y, it.w, it.h), color, opacity, blendMode: L.BlendMode.Multiply });
          break;
        case 'whiteout':
          pg.drawRectangle({ ...boxAt(it.x, it.y, it.w, it.h), color: hex(it.color || '#ffffff', L), opacity: 1 });
          break;
        case 'ellipse': {
          const [cx, cy] = P(it.x + it.w / 2, it.y + it.h / 2);
          pg.drawEllipse({ x: cx, y: cy, xScale: Math.abs(it.w / 2) * sx, yScale: Math.abs(it.h / 2) * sy, rotate: rot, color: it.fill ? color : undefined, borderColor: color, borderWidth: it.sw * s, opacity, borderOpacity: opacity });
          break;
        }
        case 'line': case 'arrow': {
          let end = [it.x2, it.y2];
          if (it.type === 'arrow') {
            const h = arrowHead(it);
            end = h.base;
            pg.drawSvgPath(pathOf([h.tip, h.l, h.r], true), { x: 0, y: 0, color, opacity });
          }
          const [x1, y1] = P(it.x1, it.y1), [x2, y2] = P(...end);
          pg.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: it.sw * s, color, opacity, lineCap: L.LineCapStyle.Round });
          break;
        }
        case 'pen':
          if (it.pts.length) pg.drawSvgPath(pathOf(it.pts), { x: 0, y: 0, borderColor: color, borderWidth: it.sw * s, borderOpacity: opacity, borderLineCap: L.LineCapStyle.Round });
          break;
        case 'image': {
          const img = await embedImg(it.img);
          if (img) pg.drawImage(img, { ...boxAt(it.x, it.y, it.w, it.h), opacity });
          break;
        }
        case 'text': {
          const f = await font(PDF_FONT[it.font || 'helv'][(it.bold ? 1 : 0) + (it.italic ? 2 : 0)]);
          let encodable = true;
          try { f.encodeText(it.text.replace(/\n/g, '')); } catch { encodable = false; }
          if (encodable) {
            it.text.split('\n').forEach((line, k) => {
              if (!line) return;
              const [x, y] = P(it.x, it.y + it.size * 0.8 + k * it.size * 1.2);
              pg.drawText(line, { x, y, size: it.size * s, font: f, color, opacity, rotate: rot });
            });
          } else {
            // Characters outside the standard PDF fonts (e.g. Hindi, emoji): embed as a high-resolution image.
            const b = textBox(it);
            const k = Math.min(6, 4000 / Math.max(b.w, b.h));
            const c = document.createElement('canvas');
            c.width = Math.ceil(b.w * k) + 2; c.height = Math.ceil(b.h * k) + 2;
            const ctx = c.getContext('2d');
            ctx.scale(k, k); ctx.translate(-b.x, -b.y);
            drawCanvas(ctx, [{ ...it, opacity: 1 }]);
            const png = await out.embedPng(new Uint8Array(await (await api.canvasToBlob(c, 'image/png')).arrayBuffer()));
            pg.drawImage(png, { ...boxAt(b.x, b.y, b.w + 2 / k, b.h + 2 / k), opacity });
          }
          break;
        }
      }
    }
  }

  // ---------- wiring ----------
  function init(appApi) {
    api = appApi;
    const svg = $('edSvg');
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerup', onUp);
    svg.addEventListener('pointercancel', onUp);
    svg.addEventListener('dblclick', (e) => {
      const g = e.target.closest('[data-i]');
      if (g && ed.items[+g.dataset.i].type === 'text') startEditText(+g.dataset.i);
    });

    $('edTools').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tool]');
      if (!b) return;
      const t = b.dataset.tool;
      if (t === 'image') { $('edImageInput').value = ''; $('edImageInput').click(); return; }
      if (t === 'sign') { openSign(); return; }
      setTool(t);
    });
    $('edImageInput').addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try { await addImageBlob(f); } catch { api.toast('Could not read that image', 'err'); }
    });

    const ta = $('edText');
    ta.addEventListener('input', () => { const it = ed.items[ed.editing]; if (it) { it.text = ta.value; autosize(); } });
    ta.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== ta) commitText(); }, 0));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); e.stopPropagation(); commitText(); }
    });

    $('edSwatches').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) applyProp('color', b.dataset.c); });
    $('edColor').addEventListener('input', (e) => applyProp('color', e.target.value));
    $('edWidth').addEventListener('input', (e) => { $('edWidthVal').textContent = e.target.value; applyProp('sw', Number(e.target.value)); });
    $('edFont').addEventListener('change', (e) => applyProp('font', e.target.value));
    $('edSize').addEventListener('change', (e) => applyProp('size', Math.max(4, Math.min(400, Number(e.target.value) || 28))));
    $('edBold').addEventListener('click', () => applyProp('bold', !(ed.items[ed.sel] || ed.props).bold));
    $('edItalic').addEventListener('click', () => applyProp('italic', !(ed.items[ed.sel] || ed.props).italic));
    $('edFill').addEventListener('change', (e) => applyProp('fill', e.target.checked));
    $('edOpacity').addEventListener('input', (e) => applyProp('opacity', Number(e.target.value) / 100));
    for (const id of ['edBold', 'edItalic']) $(id).addEventListener('mousedown', (e) => e.preventDefault()); // keep text focus

    $('edUndo').onclick = undo;
    $('edRedo').onclick = redo;
    $('edDel').onclick = () => { if (ed.sel >= 0) { commitText(); pushHist(); ed.items.splice(ed.sel, 1); ed.sel = -1; renderSvg(); syncProps(); } };
    $('edDone').onclick = () => close(true);
    $('edCancel').onclick = () => close(false);
    $('edPrev').onclick = () => step(-1);
    $('edNext').onclick = () => step(1);
    window.addEventListener('resize', layout);

    // signature pad
    const pad = $('signPad');
    pad.addEventListener('pointerdown', (e) => {
      const r = pad.getBoundingClientRect();
      sign.drawing = true; pad.setPointerCapture(e.pointerId);
      sign.strokes.push([[e.clientX - r.left, e.clientY - r.top]]); paintSign();
    });
    pad.addEventListener('pointermove', (e) => {
      if (!sign.drawing) return;
      const r = pad.getBoundingClientRect();
      sign.strokes[sign.strokes.length - 1].push([e.clientX - r.left, e.clientY - r.top]); paintSign();
    });
    const end = () => { sign.drawing = false; };
    pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
    $('signClear').onclick = () => { sign.strokes = []; paintSign(); };
    $('signUse').onclick = useSignature;
    $('signCancel').onclick = () => { $('signModal').hidden = true; };
    $('signColors').addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      sign.color = b.dataset.c;
      document.querySelectorAll('#signColors button').forEach((x) => x.classList.toggle('on', x === b));
      paintSign();
    });

    document.addEventListener('keydown', (e) => {
      if (!ed.open || !$('signModal').hidden) return;
      if (e.target === ta) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && k === 'y') { e.preventDefault(); redo(); }
      else if (mod && k === 's') { e.preventDefault(); close(true); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && ed.sel >= 0 && !e.target.closest('input, select')) { e.preventDefault(); $('edDel').click(); }
      else if (e.key === 'Escape') { if (ed.sel >= 0) { ed.sel = -1; renderSvg(); syncProps(); } else if (ed.tool !== 'select') setTool('select'); else close(true); }
      else if (e.key.startsWith('Arrow') && ed.sel >= 0 && !e.target.closest('input, select')) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1, it = ed.items[ed.sel];
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        pushHist();
        if ('x1' in it) { it.x1 += dx; it.x2 += dx; it.y1 += dy; it.y2 += dy; } else if (it.pts) it.pts = it.pts.map(([x, y]) => [x + dx, y + dy]); else { it.x += dx; it.y += dy; }
        renderSvg();
      } else if (!mod && !e.target.closest('input, select')) {
        const t = { v: 'select', t: 'text', p: 'pen', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', w: 'whiteout' }[k];
        if (t) setTool(t);
      }
    }, true);
  }

  window.PDFEditor = { init, open, drawPdf, drawOnBase, isOpen: () => ed.open };
})();
