// Notes: compress a PDF into page images (staff upload) and view them with a burned-in,
// per-student watermark (student side). No PDF ever reaches a student's device — only
// JPEG pages, drawn onto <canvas> with the watermark in the pixels, inside the site.
//
//  rasterizePdf(file, opts)   — staff: render every page with pdf.js → JPEG blob
//  mountNotes(host, opts)     — everyone: scrollable, zoomable, full-screen page viewer
//
// Honest limit: no website can stop a phone's screenshot or screen-recording. What this
// does is make every frame carry the student's own number and group, and never hand out
// a file, a save button, a right-click menu or a copyable page.

let libPromise = null;
function loadLib(){
  if (!libPromise){
    libPromise = import('./pdfjs/pdf.min.js').then(m => {
      m.GlobalWorkerOptions.workerSrc = new URL('./pdfjs/pdf.worker.min.js', import.meta.url).href;
      return m;
    });
  }
  return libPromise;
}

// ---------------------------------------------------------------- compression (staff)
// Each page becomes one JPEG about `maxWidth` px wide. Scanned notes shrink a lot; a text
// PDF becomes a little larger but loses its selectable/copyable text, which is the point.
export async function rasterizePdf(file, opts = {}){
  const maxWidth = opts.maxWidth || 1200, quality = opts.quality || 0.72;   // ≈200 KB per page of dense text as WebP
  const lib = await loadLib();
  if (opts.workerSrc) lib.GlobalWorkerOptions.workerSrc = opts.workerSrc;   // tests only
  const data = await file.arrayBuffer();
  const doc = await lib.getDocument(Object.assign({
    data, isEvalSupported: false,
    standardFontDataUrl: opts.standardFontDataUrl || new URL('./pdfjs/standard_fonts/', import.meta.url).href
  }, opts.canvasFactory ? { canvasFactory: opts.canvasFactory } : {})).promise;
  const n = doc.numPages;
  let totalBytes = 0;
  try {
    for (let i = 1; i <= n; i++){
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(maxWidth / base.width, 3) });
      const canvas = (opts.createCanvas || (() => document.createElement('canvas')))();
      canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render(Object.assign({ canvasContext: ctx, viewport: vp, useRequestAnimationFrame: false }, opts.canvasFactory ? { canvasFactory: opts.canvasFactory } : {})).promise;
      const blob = await encodePage(canvas, quality);   // WebP when the browser can, else JPEG
      totalBytes += blob.size;
      if (opts.onPage) await opts.onPage(blob, i, n, { width: canvas.width, height: canvas.height, ext: blob.type === 'image/webp' ? 'webp' : 'jpg' });
      canvas.width = 0; canvas.height = 0;
      try { page.cleanup(); } catch(_){}
    }
  } finally { try { await doc.destroy(); } catch(_){} }
  return { pages: n, bytes: totalBytes };
}
// WebP is roughly half the size of JPEG for pages of text and every modern phone decodes
// it (iOS 14+, all Android). A browser that cannot encode it hands back another type, in
// which case the page is stored as JPEG instead. The viewer accepts both.
async function encodePage(canvas, q){
  const viaToBlob = (type, qq) => new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('encode failed')), type, qq));
  if (canvas.toBlob){
    try { const w = await viaToBlob('image/webp', q); if (w && w.type === 'image/webp') return w; } catch(_){}
    return viaToBlob('image/jpeg', Math.min(q, 0.78));
  }
  if (canvas.encode){                                         // headless (tests)
    const wrap = (buf, type) => ({ size: buf.length, type, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
    try { return wrap(await canvas.encode('webp', Math.round(q * 100)), 'image/webp'); } catch(_){}
    return wrap(await canvas.encode('jpeg', Math.round(Math.min(q, 0.78) * 100)), 'image/jpeg');
  }
  throw new Error('no image encoder');
}

// ---------------------------------------------------------------- watermark
// The student's number and group, tiled diagonally across the page AND stamped in a
// corner, in the pixels themselves. A screenshot, a recording, a photo of the screen —
// all carry it. Exported so the same drawing can be verified outside a browser.
export function drawWatermark(ctx, w, h, lines){
  const main = String((lines && lines[0]) || '').trim(); if (!main) return;
  const sub  = String((lines && lines[1]) || '').trim();
  ctx.save();
  // Light and regular-weight: present on every page, but never in the way of reading it.
  ctx.globalAlpha = 0.10;
  ctx.fillStyle = '#13235c';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const size = Math.max(16, Math.round(w / 22));
  ctx.font = '400 ' + size + 'px Inter, Arial, sans-serif';
  // Tiles are spaced by the MEASURED width of the text, so a long line never runs into
  // its neighbour; rows are staggered so no two tiles ever sit on the same line.
  const tw = ctx.measureText(main).width;
  const stepX = tw + size * 4, stepY = size * 6.5;
  ctx.translate(w / 2, h / 2); ctx.rotate(-Math.PI / 6);
  const span = Math.hypot(w, h);
  let row = 0;
  for (let y = -span; y <= span; y += stepY, row++){
    const shift = (row % 2) ? stepX / 2 : 0;
    for (let x = -span; x <= span; x += stepX) ctx.fillText(main, x + shift, y);
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = 0.45; ctx.fillStyle = '#13235c';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  const small = Math.max(11, Math.round(w / 60));
  ctx.font = '500 ' + small + 'px Inter, Arial, sans-serif';
  ctx.fillText(main + (sub ? '  ·  ' + sub : ''), w - small, h - small * 0.8);
  ctx.restore();
}

// ---------------------------------------------------------------- viewer (everyone)
const ZOOMS = [0.6, 0.8, 1, 1.25, 1.5, 2, 3];
const STYLE_ID = 'nt-style';
function ensureStyle(){
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style'); s.id = STYLE_ID;
  s.textContent = `
.nt{position:absolute;inset:0;display:flex;flex-direction:column;background:#1b2440;color:#fff;font-family:inherit;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
.nt-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.08);flex:0 0 auto;font-size:12.5px}
.nt-bar button{font:inherit;font-weight:700;min-width:36px;height:34px;padding:0 10px;border-radius:9px;border:0;background:rgba(255,255,255,.14);color:#fff;cursor:pointer}
.nt-bar button:disabled{opacity:.4;cursor:default}
.nt-bar .nt-t{flex:1;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.nt-bar .nt-pg{font-weight:600;white-space:nowrap;opacity:.9}
.nt-scroll{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;overscroll-behavior:contain;padding:10px}
.nt-page{position:relative;margin:0 auto 10px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.35);overflow:hidden}
.nt-page canvas{display:block;width:100%;height:100%;pointer-events:none}
.nt-page .nt-n{position:absolute;left:6px;top:6px;font-size:11px;color:rgba(0,0,0,.35);background:rgba(255,255,255,.7);padding:1px 6px;border-radius:6px}
.nt-msg{padding:28px 16px;text-align:center;font-size:14px;line-height:1.6}
.nt:fullscreen{background:#0c1840}
@media (max-width:640px){.nt-scroll{padding:6px}.nt-page{margin-bottom:6px}.nt-bar{padding:6px 6px;gap:4px}.nt-bar button{min-width:32px;height:32px;padding:0 8px}}
`;
  document.head.appendChild(s);
}
async function fetchImage(url){
  const r = await fetch(url, { cache: 'no-store', credentials: 'omit' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const blob = await r.blob();
  if (window.createImageBitmap){ try { return await createImageBitmap(blob); } catch(_){} }
  return await new Promise((res, rej) => {
    const u = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); res(img); };
    img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode failed')); };
    img.src = u;
  });
}

// opts: { title, pages: [{ path }], watermark: [main, sub], getUrls(paths) → Promise<url[]>, onClose }
export async function mountNotes(host, opts){
  ensureStyle();
  const pages = (opts.pages || []).slice();
  const n = pages.length;
  const state = { destroyed: false, zoomIdx: 2, timer: 0, urls: [], slots: [], imgs: new Map(), busy: new Set(), pinch: null };
  host.innerHTML =
    '<div class="nt">' +
      '<div class="nt-bar">' +
        '<span class="nt-t"></span>' +
        '<span class="nt-pg"></span>' +
        '<button type="button" class="nt-out" title="Zoom out">−</button>' +
        '<button type="button" class="nt-fit" title="Fit width">Fit</button>' +
        '<button type="button" class="nt-in" title="Zoom in">+</button>' +
        '<button type="button" class="nt-fs" title="Full screen">⤢</button>' +
        '<button type="button" class="nt-x" title="Close">×</button>' +
      '</div>' +
      '<div class="nt-scroll"><div class="nt-msg">Loading…</div></div>' +
    '</div>';
  const root = host.querySelector('.nt'), scroll = root.querySelector('.nt-scroll'), pgEl = root.querySelector('.nt-pg');
  root.querySelector('.nt-t').textContent = opts.title || 'Notes';
  // No context menu, no drag-out, no long-press save sheet.
  root.addEventListener('contextmenu', e => e.preventDefault());
  root.addEventListener('dragstart', e => e.preventDefault());
  root.querySelector('.nt-x').addEventListener('click', () => { if (document.fullscreenElement) { try { document.exitFullscreen(); } catch(_){} } opts.onClose && opts.onClose(); });
  root.querySelector('.nt-fs').addEventListener('click', () => {
    if (document.fullscreenElement){ try { document.exitFullscreen(); } catch(_){} return; }
    if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else root.classList.toggle('nt-fake-fs');       // iPhone Safari: the host is already full-viewport
  });
  if (!n){ scroll.innerHTML = '<div class="nt-msg">These notes have no pages yet.</div>'; return controller(); }

  try { state.urls = await opts.getUrls(pages.map(p => p.path)); }
  catch (e){ scroll.innerHTML = '<div class="nt-msg">Could not open these notes right now. Please try again.</div>'; return controller(); }
  if (state.destroyed) return controller();

  scroll.innerHTML = '';
  for (let i = 0; i < n; i++){
    const slot = document.createElement('div');
    slot.className = 'nt-page'; slot.dataset.n = String(i + 1);
    slot.innerHTML = '<span class="nt-n">' + (i + 1) + '</span>';
    scroll.appendChild(slot);
    state.slots.push({ slot, ratio: pages[i].height && pages[i].width ? pages[i].height / pages[i].width : 1.4142, canvas: null, drawnW: 0 });
  }
  const cssWidth = () => Math.max(120, scroll.clientWidth - 2 * (window.innerWidth <= 640 ? 6 : 10)) * ZOOMS[state.zoomIdx];
  function layout(){ const w = cssWidth(); state.slots.forEach(s => { s.slot.style.width = w + 'px'; s.slot.style.height = (w * s.ratio) + 'px'; }); }
  function release(s){ if (s.canvas){ s.canvas.width = 0; s.canvas.height = 0; s.canvas.remove(); s.canvas = null; } s.drawnW = 0; }
  async function draw(i){
    const s = state.slots[i]; if (state.destroyed || !s) return;
    const w = cssWidth(); if (s.drawnW === w || state.busy.has(i)) return;
    state.busy.add(i);
    try {
      let img = state.imgs.get(i);
      if (!img){
        try { img = await fetchImage(state.urls[i]); }
        catch (e){
          // Signed link may have expired while the student read slowly — ask for a fresh one once.
          if (opts.getUrls){ try { const fresh = await opts.getUrls([pages[i].path]); state.urls[i] = fresh[0]; img = await fetchImage(fresh[0]); } catch(_){} }
        }
        if (!img) return;
        state.imgs.set(i, img);
        s.ratio = img.height / img.width; layout();
      }
      if (state.destroyed) return;
      release(s);
      const cssH = w * s.ratio;
      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      dpr = Math.min(dpr, Math.sqrt(16e6 / (w * cssH)), 4096 / Math.max(w, cssH));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      drawWatermark(ctx, canvas.width, canvas.height, opts.watermark || []);
      s.slot.insertBefore(canvas, s.slot.firstChild);
      s.canvas = canvas; s.drawnW = w;
    } finally { state.busy.delete(i); }
  }
  function updateVisible(){
    state.timer = 0; if (state.destroyed) return;
    const top = scroll.scrollTop, bottom = top + scroll.clientHeight, margin = scroll.clientHeight * 1.5;
    let cur = 1; const marker = top + scroll.clientHeight * 0.35;
    state.slots.forEach((s, i) => {
      const y = s.slot.offsetTop, h = s.slot.offsetHeight;
      const near = (y + h) >= (top - margin) && y <= (bottom + margin);
      if (near) draw(i); else release(s);
      if (y <= marker) cur = i + 1;
    });
    pgEl.textContent = 'Page ' + cur + ' of ' + n;
  }
  const schedule = () => { if (!state.timer) state.timer = setTimeout(updateVisible, 60); };
  scroll.addEventListener('scroll', schedule, { passive: true });
  layout(); updateVisible();
  // Warm the rest in the background so slow readers never wait, three at a time.
  (async () => {
    let next = 0;
    const worker = async () => { while (!state.destroyed && next < n){ const i = next++; if (!state.imgs.has(i)){ try { state.imgs.set(i, await fetchImage(state.urls[i])); } catch(_){} } } };
    await Promise.all([worker(), worker(), worker()]);
  })();

  function setZoom(i){
    i = Math.max(0, Math.min(ZOOMS.length - 1, i)); if (i === state.zoomIdx) return;
    const rel = scroll.scrollHeight ? scroll.scrollTop / scroll.scrollHeight : 0;
    state.zoomIdx = i; state.slots.forEach(release); layout();
    scroll.scrollTop = rel * scroll.scrollHeight;
    root.querySelector('.nt-out').disabled = i === 0; root.querySelector('.nt-in').disabled = i === ZOOMS.length - 1;
    updateVisible();
  }
  root.querySelector('.nt-out').addEventListener('click', () => setZoom(state.zoomIdx - 1));
  root.querySelector('.nt-in').addEventListener('click',  () => setZoom(state.zoomIdx + 1));
  root.querySelector('.nt-fit').addEventListener('click', () => setZoom(2));
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroll.addEventListener('touchstart', e => { if (e.touches.length === 2) state.pinch = dist(e.touches); }, { passive: true });
  scroll.addEventListener('touchmove',  e => { if (state.pinch && e.touches.length === 2){ const r = dist(e.touches) / state.pinch; if (r > 1.25){ state.pinch = dist(e.touches); setZoom(state.zoomIdx + 1); } else if (r < 0.8){ state.pinch = dist(e.touches); setZoom(state.zoomIdx - 1); } } }, { passive: true });
  scroll.addEventListener('touchend', () => { state.pinch = null; }, { passive: true });
  function onResize(){ if (state.destroyed) return; state.slots.forEach(release); layout(); updateVisible(); }
  window.addEventListener('resize', onResize);
  document.addEventListener('fullscreenchange', onResize);

  function controller(){
    return {
      destroy(){
        if (state.destroyed) return; state.destroyed = true;
        window.removeEventListener('resize', onResize); document.removeEventListener('fullscreenchange', onResize);
        if (state.timer){ clearTimeout(state.timer); state.timer = 0; }
        state.slots.forEach(release); state.imgs.forEach(img => { try { img.close && img.close(); } catch(_){} }); state.imgs.clear();
        host.innerHTML = '';
      },
      get pageCount(){ return n; }
    };
  }
  return controller();
}
