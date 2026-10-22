// POST /api/video-rename  — ADMIN only (recordings management is admin-only).
// Renames a recording everywhere it is stored:
//   • every `videos` metadata row sharing the same underlying file (one row per school), and
//   • the video's title inside the Bunny library,
// so what the portal calls a recording and what the library calls it can never drift apart.
//
//   { video_id, title } -> { ok, title, rows, bunnyRenamed }
//
// Bunny is renamed FIRST and on purpose: nothing is written to the database until the library
// has accepted the new name, so a failed rename leaves BOTH sides on the old name rather than
// half-renamed. A recording that isn't hosted on Bunny (a Drive or plain link) simply skips
// that step.
const { SITE_CLIENT_ID, setCors, json, bunnyEnv, parseBody, requireRole } = require('../lib/bunny.js');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { libraryId, apiKey, supabaseUrl, serviceKey } = bunnyEnv();
  if (!supabaseUrl || !serviceKey) return json(res, 500, { error: 'Server misconfigured' });

  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Not allowed' }); }

  const body = parseBody(req);
  const videoId = String(body.video_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(videoId)) return json(res, 400, { error: 'Bad video_id' });
  const title = String(body.title || '').replace(/\s+/g, ' ').trim();
  if (!title) return json(res, 400, { error: 'A name is required' });
  if (title.length > 200) return json(res, 400, { error: 'That name is too long (200 characters max)' });

  const svc = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const svcJson = Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, svc);
  const get = async (path) => { const r = await fetch(supabaseUrl + '/rest/v1/' + path, { headers: svc }); return r.ok ? r.json() : []; };

  // The row that was clicked, and the private ref telling us where the file actually lives.
  const anchor = (await get('videos?client_id=eq.' + SITE_CLIENT_ID + '&id=eq.' + encodeURIComponent(videoId) + '&select=id,title,level,kind'))[0];
  if (!anchor) return json(res, 404, { error: 'Recording not found' });
  const ref = ((await get('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(videoId) + '&select=url'))[0] || {}).url || '';

  // Every row sharing that same file, level and kind — one per school. This is the exact
  // grouping the Schools editor shows, so a rename covers precisely the rows it lists. A null
  // kind must match ONLY null, or a same-ref espresso would be swept up with the full lesson.
  let ids = [videoId];
  if (ref) {
    const kindFilter = anchor.kind ? '&kind=eq.' + encodeURIComponent(anchor.kind) : '&kind=is.null';
    const urlRows = await get('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&url=eq.' + encodeURIComponent(ref) + '&select=video_id');
    const candidates = urlRows.map(r => r.video_id).filter(Boolean);
    if (candidates.length) {
      const vids = await get('videos?client_id=eq.' + SITE_CLIENT_ID + '&id=in.(' + candidates.map(encodeURIComponent).join(',') + ')' +
        '&level=eq.' + encodeURIComponent(anchor.level) + kindFilter + '&select=id');
      if (vids.length) ids = vids.map(v => v.id);
    }
  }

  // ---- Bunny first (hosted recordings only). Nothing is written below until this succeeds.
  let bunnyRenamed = false;
  if (ref.startsWith('bunny:')) {
    if (!libraryId || !apiKey) return json(res, 500, { error: 'The video library is not configured on the server, so nothing was renamed.' });
    const guid = ref.slice(6);
    try {
      const r = await fetch('https://video.bunnycdn.com/library/' + libraryId + '/videos/' + encodeURIComponent(guid), {
        method: 'POST',
        headers: { AccessKey: apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!r.ok) {
        const t = await r.text().catch(() => '');
        console.error('[video-rename] bunny update', r.status, t.slice(0, 200));
        return json(res, 502, { error: 'The video library refused the new name (HTTP ' + r.status + '). Nothing was changed — try again.' });
      }
      bunnyRenamed = true;
    } catch (e) {
      console.error('[video-rename] bunny unreachable', e && e.message);
      return json(res, 502, { error: 'Could not reach the video library, so nothing was renamed. Try again.' });
    }
  }

  // ---- then the portal's own rows, all of them in one write.
  const upd = await fetch(supabaseUrl + '/rest/v1/videos?client_id=eq.' + SITE_CLIENT_ID + '&id=in.(' + ids.map(encodeURIComponent).join(',') + ')', {
    method: 'PATCH', headers: svcJson, body: JSON.stringify({ title }),
  });
  if (!upd.ok) {
    const t = await upd.text().catch(() => '');
    console.error('[video-rename] db update', upd.status, t.slice(0, 200));
    return json(res, 500, {
      error: bunnyRenamed
        ? 'The video library was renamed but the portal was not — press Save name again to finish the job.'
        : 'Could not save the new name. Try again.',
    });
  }
  const rows = (await upd.json().catch(() => [])).length || ids.length;

  return json(res, 200, { ok: true, title, rows, bunnyRenamed });
};
