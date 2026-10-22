// In-page PDF viewer for homework submissions.
//
// Why this exists: the lightbox used to drop the signed URL into an <iframe>. Desktop
// browsers have a built-in PDF plugin so that worked; Android Chrome has none (the frame
// just says the PDF can't be opened) and iOS Safari paints only the first page inside a
// fixed-height frame with no way to scroll. Drawing the pages ourselves with pdf.js onto
// <canvas> elements behaves the same everywhere.
//
// pdf.js is self-hosted under ./pdfjs/ because the site's CSP only allows scripts and
// workers from its own origin. Files are fetched straight from the signed Supabase URL —
// nothing is copied, re-uploaded or changed.
//
// Memory-safe by design: only pages near the viewport hold a canvas (a 30-page scan at
// phone resolution would otherwise exhaust iOS's canvas budget); the rest keep their
// height so scrolling stays smooth and the page counter stays right.

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

const STYLE_ID = 'pv-style';
function ensureStyle(){
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
.pv{position:absolute;inset:0;display:flex;flex-direction:column;background:#1b2440;color:#fff;font-family:inherit}
.pv-bar{display:flex;align-items:center;gap:6px;padding:8px 10px;background:rgba(255,255,255,.08);flex:0 0 auto;font-size:12.5px}
.pv-bar button{font:inherit;font-weight:700;min-width:36px;height:34px;padding:0 10px;border-radius:9px;border:0;background:rgba(255,255,255,.14);color:#fff;cursor:pointer}
.pv-bar button:disabled{opacity:.4;cursor:default}
.pv-bar .pv-pg{flex:1;text-align:center;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pv-bar a{color:#fff;opacity:.85;font-weight:600;text-decoration:underline;white-space:nowrap}
.pv-scroll{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x pan-y;overscroll-behavior:contain;padding:10px}
.pv-page{position:relative;margin:0 auto 10px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.35)}
.pv-page canvas{display:block;width:100%;height:100%}
.pv-page .pv-n{position:absolute;right:6px;bottom:6px;font-size:11px;color:rgba(0,0,0,.35);background:rgba(255,255,255,.7);padding:1px 6px;border-radius:6px}
.pv-msg{padding:28px 16px;text-align:center;font-size:14px;line-height:1.6}
.pv-msg a{color:#fff;font-weight:700}
@media (max-width:640px){.pv-scroll{padding:6px}.pv-page{margin-bottom:6px}}
`;
  document.head.appendChild(s);
}

const ZOOMS = [0.6, 0.8, 1, 1.25, 1.5, 2, 3];

export async function mountPdf(host, url, opts = {}){
  ensureStyle();
  const state = { destroyed: false, tasks: new Map(), pages: [], zoomIdx: 2, doc: null, timer: 0, pinch: null, n: 0 };
  host.innerHTML =
    '<div class="pv">' +
      '<div class="pv-bar">' +
        '<button type="button" class="pv-out" title="Zoom out">−</button>' +
        '<button type="button" class="pv-fit" title="Fit width">Fit</button>' +
        '<button type="button" class="pv-in" title="Zoom in">+</button>' +
        '<span class="pv-pg">Loading…</span>' +
        '<a class="pv-open" target="_blank" rel="noopener">Open</a>' +
      '</div>' +
      '<div class="pv-scroll"><div class="pv-msg">Loading PDF…</div></div>' +
    '</div>';
  const root   = host.querySelector('.pv');
  const scroll = root.querySelector('.pv-scroll');
  const pgEl   = root.querySelector('.pv-pg');
  root.querySelector('.pv-open').href = url;

  const fail = (msg) => {
    scroll.innerHTML = '<div class="pv-msg">' + msg + '<br><a href="' + url.replace(/"/g, '&quot;') +
      '" target="_blank" rel="noopener">Open the PDF in a new tab</a></div>';
    pgEl.textContent = 'PDF';
  };

  let lib;
  try { lib = await loadLib(); }
  catch (e){ fail('The PDF viewer could not load.'); return controller(); }
  if (state.destroyed) return controller();

  try {
    state.doc = await lib.getDocument({
      url, isEvalSupported: false,
      // Non-embedded base-14 fonts (Helvetica/Times/Courier in Word or Docs exports) come
      // from these self-hosted files; without them such text renders blank on some devices.
      standardFontDataUrl: new URL('./pdfjs/standard_fonts/', import.meta.url).href
    }).promise;
  } catch (e){
    fail('This PDF could not be displayed here.');
    return controller();
  }
  if (state.destroyed){ try { state.doc.destroy(); } catch(_){} return controller(); }

  const n = state.doc.numPages; state.n = n;
  // Page sizes: look up every page for normal documents; for very long ones assume the
  // first page's shape and correct each page when it is actually drawn.
  const first = await state.doc.getPage(1);
  const base1 = first.getViewport({ scale: 1 });
  const sizes = new Array(n).fill(null); sizes[0] = { w: base1.width, h: base1.height };
  if (n <= 80){
    for (let i = 2; i <= n; i++){
      if (state.destroyed) return controller();
      try { const p = await state.doc.getPage(i); const v = p.getViewport({ scale: 1 }); sizes[i - 1] = { w: v.width, h: v.height }; }
      catch(_){ sizes[i - 1] = sizes[0]; }
    }
  } else for (let i = 1; i < n; i++) sizes[i] = sizes[0];

  scroll.innerHTML = '';
  for (let i = 0; i < n; i++){
    const slot = document.createElement('div');
    slot.className = 'pv-page'; slot.dataset.n = String(i + 1);
    slot.innerHTML = '<span class="pv-n">' + (i + 1) + '</span>';
    scroll.appendChild(slot);
    state.pages.push({ slot, canvas: null, size: sizes[i] || sizes[0], rendered: 0 });
  }

  function cssWidth(){
    const avail = scroll.clientWidth - 2 * (window.innerWidth <= 640 ? 6 : 10);
    return Math.max(120, avail) * ZOOMS[state.zoomIdx];
  }
  function layout(){
    const w = cssWidth();
    state.pages.forEach(p => {
      const h = w * (p.size.h / p.size.w);
      p.slot.style.width = w + 'px'; p.slot.style.height = h + 'px';
    });
  }
  function release(p){
    const t = state.tasks.get(p); if (t){ try { t.cancel(); } catch(_){} state.tasks.delete(p); }
    if (p.canvas){ p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.rendered = 0;
  }
  async function draw(p, idx){
    if (state.destroyed) return;
    const w = cssWidth();
    if (p.rendered === w) return;         // already drawn at this size
    release(p);
    let page;
    try { page = await state.doc.getPage(idx + 1); } catch(_){ return; }
    if (state.destroyed) return;
    const base = page.getViewport({ scale: 1 });
    p.size = { w: base.width, h: base.height };
    const cssH = w * (base.height / base.width);
    p.slot.style.width = w + 'px'; p.slot.style.height = cssH + 'px';
    // Crisp on retina, but never past the canvas budget iOS enforces (~16M pixels).
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    dpr = Math.min(dpr, Math.sqrt(16e6 / (w * cssH)), 4096 / Math.max(w, cssH));
    const vp = page.getViewport({ scale: (w / base.width) * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    const task = page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp, useRequestAnimationFrame: false });
    state.tasks.set(p, task);
    try { await task.promise; } catch(_){ return; }      // cancelled — fine
    state.tasks.delete(p);
    if (state.destroyed || p.rendered === -1) return;
    p.slot.insertBefore(canvas, p.slot.firstChild);
    p.canvas = canvas; p.rendered = w;
  }
  layout();

  // Only pages near the viewport carry a canvas. Visibility is worked out by hand on
  // scroll, on a plain timer, instead of with the browser's observer / animation-frame
  // APIs: those pause in background tabs and hidden webviews, and a viewer that silently
  // draws nothing is the exact failure this replaces. A timer is dependable everywhere.
  function updateVisible(){
    state.timer = 0;
    if (state.destroyed) return;
    const top = scroll.scrollTop, bottom = top + scroll.clientHeight;
    const margin = scroll.clientHeight * 1.2;
    let cur = 1; const marker = top + scroll.clientHeight * 0.35;
    state.pages.forEach((p, idx) => {
      const y = p.slot.offsetTop, h = p.slot.offsetHeight;
      const near = (y + h) >= (top - margin) && y <= (bottom + margin);
      if (near) draw(p, idx); else release(p);
      if (y <= marker) cur = idx + 1;
    });
    pgEl.textContent = 'Page ' + cur + ' of ' + n;
  }
  function schedule(){ if (!state.timer) state.timer = setTimeout(updateVisible, 60); }
  scroll.addEventListener('scroll', schedule, { passive: true });
  updateVisible();

  // Zoom keeps the reader's place: same relative position after re-layout.
  function setZoom(i){
    i = Math.max(0, Math.min(ZOOMS.length - 1, i));
    if (i === state.zoomIdx) return;
    const rel = scroll.scrollHeight ? scroll.scrollTop / scroll.scrollHeight : 0;
    state.zoomIdx = i;
    state.pages.forEach(release);
    layout();
    scroll.scrollTop = rel * scroll.scrollHeight;
    root.querySelector('.pv-out').disabled = i === 0;
    root.querySelector('.pv-in').disabled  = i === ZOOMS.length - 1;
    updateVisible();                       // visible pages redraw at the new size
  }
  root.querySelector('.pv-out').addEventListener('click', () => setZoom(state.zoomIdx - 1));
  root.querySelector('.pv-in').addEventListener('click',  () => setZoom(state.zoomIdx + 1));
  root.querySelector('.pv-fit').addEventListener('click', () => setZoom(2));

  // Two-finger pinch → zoom step (the site's viewport disables native pinch-zoom).
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  scroll.addEventListener('touchstart', (e) => { if (e.touches.length === 2) state.pinch = dist(e.touches); }, { passive: true });
  scroll.addEventListener('touchmove',  (e) => {
    if (state.pinch && e.touches.length === 2){
      const r = dist(e.touches) / state.pinch;
      if (r > 1.25){ state.pinch = dist(e.touches); setZoom(state.zoomIdx + 1); }
      else if (r < 0.8){ state.pinch = dist(e.touches); setZoom(state.zoomIdx - 1); }
    }
  }, { passive: true });
  scroll.addEventListener('touchend', () => { state.pinch = null; }, { passive: true });

  // Re-fit when the phone rotates.
  window.addEventListener('resize', onResize);

  // Hoisted so destroy() is safe to call even if loading failed before layout existed.
  function onResize(){
    if (state.destroyed || !state.pages.length) return;
    state.pages.forEach(release); layout(); updateVisible();
  }
  function controller(){
    return {
      destroy(){
        if (state.destroyed) return;
        state.destroyed = true;
        window.removeEventListener('resize', onResize);
        if (state.timer){ clearTimeout(state.timer); state.timer = 0; }
        state.pages.forEach(p => { p.rendered = -1; release(p); });
        if (state.doc){ try { state.doc.destroy(); } catch(_){} }
        host.innerHTML = '';
      },
      get pageCount(){ return state.n; },
      zoom: setZoom
    };
  }
  return controller();
}
