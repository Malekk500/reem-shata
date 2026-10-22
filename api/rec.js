// Recording gate — hides the Google Drive link from the page and enforces access server-side.
// The page only ever sees /api/rec?s=<signed token> on our own domain; the Drive URL is
// looked up server-side per request. The access check (shata_recording_access RPC) returns
// only true/false — no code path ever returns the raw URL to an authenticated caller.
//
// Two modes (REC_MODE env):
//   direct (DEFAULT) — after the access check, return the Drive stream URL so the browser plays
//     it NATIVELY, straight from Google. ZERO video bytes flow through Vercel (free at any scale)
//     and it plays reliably on every device. The URL is only handed out through this
//     access-checked call, so a declined student never gets it; a determined student who opens
//     DevTools can read it (the accepted "extra step" trade-off — access control still holds).
//   proxy — mint an opaque play pass and pipe the bytes through this function on GET. Hides the
//     URL even from the Network tab, but ALL video traffic counts against Vercel data transfer
//     (~100GB/mo on Hobby ≈ a few hundred views of a 130MB lesson). Flip on with REC_MODE=proxy.
//
// Vercel-native (NOT the Netlify-adapter pattern): proxy mode requires piping the response,
// which the buffered Netlify handler shape can't do.
//
// Flow:
//   POST /api/rec  {video_id}  + Authorization: Bearer <supabase JWT>
//     -> access checked fully server-side: staff always; student needs school+level match,
//        espresso is open, and EVERY full recording needs an approved request decided
//        within the last 72 hours (then it expires and must be re-requested).
//     -> Drive recording: returns { src: "/api/rec?s=<token>" } — a 3-hour HMAC play pass
//        carrying only the video UUID. Non-Drive recording (e.g. YouTube): returns the URL
//        as-is (those platforms are public embeds anyway).
//   GET  /api/rec?s=<token>
//     -> verify signature + expiry -> look up the Drive URL server-side (service role)
//     -> redirect (default) or pipe (proxy mode), forwarding Range so seeking works.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE (required); REC_SIGNING_SECRET (optional — falls
// back to the service-role key as HMAC secret material; a dedicated secret is cleaner and
// keeps play tokens alive across service-key rotations); REC_MODE (optional, see above).
const crypto = require('crypto');
const { Readable } = require('stream');

const SITE_CLIENT_ID = 'shata';
const TOKEN_TTL_MS = 3 * 60 * 60 * 1000; // 3-hour play window per click (covers any lesson;
                                         // a leaked link dies quickly, and every new click mints fresh)

function hmacSecret() { return process.env.REC_SIGNING_SECRET || process.env.SUPABASE_SERVICE_ROLE || ''; }
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', hmacSecret()).update(body).digest('base64url');
  return body + '.' + mac;
}
function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const want = crypto.createHmac('sha256', hmacSecret()).update(parts[0]).digest('base64url');
  const a = Buffer.from(parts[1]), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p; try { p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch (_) { return null; }
  if (!p || !p.v || !p.exp || Date.now() > p.exp) return null;
  return p;
}
// Accept a full Drive link, a bare "drive:<id>" ref, or an id=... query form.
function driveFileId(raw) {
  const s = String(raw || '').trim();
  if (s.startsWith('drive:')) return s.slice(6);
  let m = s.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{20,})/); if (m) return m[1];
  m = s.match(/[?&]id=([a-zA-Z0-9_-]{20,})/); if (m) return m[1];
  return null;
}

// Server-side URL lookup (service role; tenant-scoped) with a small per-instance cache —
// Fluid Compute reuses instances and one viewing session fires many requests.
const _urlCache = new Map(); // video_id -> { url, at }
const URL_CACHE_MS = 5 * 60 * 1000;
async function lookupUrl(videoId) {
  const hit = _urlCache.get(videoId);
  if (hit && Date.now() - hit.at < URL_CACHE_MS) return hit.url;
  try {
    const q = await fetch(process.env.SUPABASE_URL + '/rest/v1/recording_urls?client_id=eq.' + SITE_CLIENT_ID +
      '&video_id=eq.' + encodeURIComponent(videoId) + '&select=url', {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE },
    });
    const rows = q.ok ? await q.json() : [];
    const url = (rows && rows[0] && rows[0].url) || '';
    if (url) _urlCache.set(videoId, { url, at: Date.now() });
    return url;
  } catch (_) { return ''; }
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE;
  if (!SUPABASE_URL || !SERVICE_KEY) return json(res, 500, { error: 'Server misconfigured' });

  // ---------- POST: authorize + mint a play token ----------
  if (req.method === 'POST') {
    const auth = String(req.headers.authorization || '');
    const jwt = auth.replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json(res, 401, { error: 'Sign in required' });
    let body = {};
    try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); } catch (_) {}
    const videoId = String(body.video_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(videoId)) return json(res, 400, { error: 'Bad video_id' });

    // ---- ACCESS POLICY (enforced fully server-side) ----
    // staff (admin/assist)        -> always allowed
    // student                     -> the video must belong to their school + level, AND:
    //   espresso                  -> open (no request needed)
    //   full recording            -> needs an APPROVED request decided within the last 72h;
    //                                after that it expires and the student must re-request.
    const ACCESS_WINDOW_MS = 72 * 60 * 60 * 1000;
    const svc = { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY };
    let userId = '';
    try {
      const u = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + jwt } });
      if (!u.ok) return json(res, 401, { error: 'Invalid session' });
      userId = ((await u.json()) || {}).id || '';
    } catch (_) { return json(res, 502, { error: 'Access check failed — try again' }); }
    if (!userId) return json(res, 401, { error: 'Invalid session' });

    let prof = null, video = null;
    try {
      const [pq, vq] = await Promise.all([
        fetch(SUPABASE_URL + '/rest/v1/profiles?user_id=eq.' + encodeURIComponent(userId) + '&select=role,client_id,school,level', { headers: svc }),
        fetch(SUPABASE_URL + '/rest/v1/videos?client_id=eq.' + SITE_CLIENT_ID + '&id=eq.' + encodeURIComponent(videoId) + '&select=track,level,kind', { headers: svc }),
      ]);
      prof = pq.ok ? (await pq.json())[0] : null;
      video = vq.ok ? (await vq.json())[0] : null;
    } catch (_) { return json(res, 502, { error: 'Access check failed — try again' }); }
    if (!prof || prof.client_id !== SITE_CLIENT_ID) return json(res, 403, { error: 'no_access' });
    if (!video) return json(res, 404, { error: 'Recording not found' });

    // Admin: always allowed. Assistant: allowed only within their assigned schools
    // (settings key 'assist_schools' = { uid: [schools] }; no entry = unrestricted).
    if (prof.role === 'assist') {
      try {
        const sq = await fetch(SUPABASE_URL + '/rest/v1/settings?client_id=eq.' + SITE_CLIENT_ID + '&key=eq.assist_schools&select=value', { headers: svc });
        const map = (sq.ok ? (await sq.json())[0] : null) || {};
        const mine = map.value && map.value[userId];
        if (Array.isArray(mine) && mine.length && !mine.includes(video.track)) return json(res, 403, { error: 'no_access' });
      } catch (_) {}
    }
    const isStaff = prof.role === 'admin' || prof.role === 'assist';
    if (!isStaff) {
      if (video.track !== prof.school || video.level !== prof.level) return json(res, 403, { error: 'no_access' });
      if (String(video.kind || '') !== 'espresso') {
        let rq = null;
        try {
          const q = await fetch(SUPABASE_URL + '/rest/v1/recording_requests?client_id=eq.' + SITE_CLIENT_ID +
            '&user_id=eq.' + encodeURIComponent(userId) + '&video_id=eq.' + encodeURIComponent(videoId) +
            '&select=status,decided_at', { headers: svc });
          rq = q.ok ? (await q.json())[0] : null;
        } catch (_) { return json(res, 502, { error: 'Access check failed — try again' }); }
        const fresh = rq && rq.status === 'approved' && rq.decided_at &&
          (Date.now() - new Date(rq.decided_at).getTime()) < ACCESS_WINDOW_MS;
        if (!fresh) return json(res, 403, { error: 'no_access' });
      }
    }

    const url = await lookupUrl(videoId);
    if (!url) return json(res, 404, { error: 'Recording not found' });
    // Bunny Stream recording: access was just verified above; sign a short-lived embed URL.
    // token = sha256(BUNNY_TOKEN_KEY + guid + expires). 6h window covers any lesson start-to-end;
    // a copied link dies with it. The Bunny keys never leave the server.
    if (url.startsWith('bunny:')) {
      const libId = process.env.BUNNY_LIBRARY_ID, tokenKey = process.env.BUNNY_TOKEN_KEY;
      if (!libId || !tokenKey) return json(res, 500, { error: 'Bunny not configured' });
      const guid = url.slice(6);
      const expires = Math.floor(Date.now() / 1000) + 6 * 3600;
      const token = crypto.createHash('sha256').update(tokenKey + guid + expires).digest('hex');
      const src = 'https://iframe.mediadelivery.net/embed/' + libId + '/' + guid +
        '?token=' + token + '&expires=' + expires + '&autoplay=true&preload=true';
      return json(res, 200, { src, kind: 'bunny' });
    }
    const mode = (process.env.REC_MODE || 'direct').toLowerCase();
    if (mode === 'proxy' && driveFileId(url)) {
      // FULL-HIDE mode: hand out an opaque play pass; GET pipes the bytes through us. Hides the
      // URL even from the Network tab, but every video byte counts against Vercel bandwidth.
      const token = sign({ v: videoId, exp: Date.now() + TOKEN_TTL_MS });
      return json(res, 200, { src: '/api/rec?s=' + token });
    }
    // DEFAULT (direct): access was just verified server-side; hand back the stream URL so the
    // browser plays it NATIVELY straight from Google — reliable on every device, zero Vercel
    // bandwidth. The URL is only obtainable through this access-checked call, so a declined
    // student never receives it (the access control — the part that matters — stays intact).
    return json(res, 200, { src: url });
  }

  // ---------- GET: validate token + serve the stream ----------
  if (req.method !== 'GET') return json(res, 405, { error: 'GET or POST only' });
  let token = (req.query && req.query.s) || '';
  if (Array.isArray(token)) token = token[0] || '';
  const p = verify(token);
  if (!p) return json(res, 403, { error: 'Expired or invalid play token — reopen the recording' });

  const driveUrl = await lookupUrl(p.v);
  const fileId = driveFileId(driveUrl);
  if (!fileId) return json(res, 404, { error: 'Recording not found' });

  // GET is only used in FULL-HIDE proxy mode (REC_MODE=proxy): fetch from Drive, forwarding
  // Range so seeking + iOS playback work, and pipe the bytes back. (A 302-redirect mode was
  // tried and dropped: a same-origin <video> src that redirects to a cross-origin file is
  // rejected by browsers' media loaders — especially Safari with byte-range requests.)
  const streamUrl = 'https://drive.usercontent.google.com/download?id=' + fileId + '&export=download&confirm=t';
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // viewer left — stop pulling from Drive immediately
  let upstream;
  try {
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    upstream = await fetch(streamUrl, { headers, redirect: 'follow', signal: abort.signal });
  } catch (_) { return json(res, 502, { error: 'Could not reach the video source' }); }

  const ctype = upstream.headers.get('content-type') || '';
  // An HTML body here means Drive refused (sharing changed / quota hit) — surface it cleanly.
  if (!upstream.ok || /text\/html/i.test(ctype)) {
    return json(res, 502, { error: 'The video source is temporarily unavailable. Please try again later.' });
  }

  res.statusCode = upstream.status; // 200 or 206 (partial content)
  res.setHeader('Content-Type', ctype || 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); // no hotlinking from other sites
  for (const h of ['content-length', 'content-range']) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  try {
    const body = Readable.fromWeb(upstream.body);
    // A dropped Drive connection must end THIS response, not crash the shared instance.
    body.on('error', () => { try { res.end(); } catch (_) {} });
    res.on('error', () => { try { body.destroy(); } catch (_) {} abort.abort(); });
    body.pipe(res);
  } catch (_) {
    try { res.end(); } catch (_) {}
  }
};

// Exposed for unit tests only.
module.exports._test = { sign, verify, driveFileId };
