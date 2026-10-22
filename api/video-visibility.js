// POST /api/video-visibility  — STAFF only (admin/assistant).
// One uploaded video can serve many schools: each school gets its own `videos` metadata row,
// all pointing at the SAME private ref in recording_urls. This endpoint lets the admin see
// and change that school list without re-uploading.
//
//   { video_id }              -> { title, level, kind, ref_kind, schools: [{ school, video_id }] }
//   { video_id, set: [...] }  -> adds/removes school rows so the list matches `set`, then
//                                returns the updated mapping. Removing a school deletes its
//                                metadata row (+ its requests/views/url row) but NEVER the
//                                underlying video file — Delete does that (when last ref goes).
const { SITE_CLIENT_ID, setCors, json, bunnyEnv, parseBody, requireRole } = require('../lib/bunny.js');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { supabaseUrl, serviceKey } = bunnyEnv();
  if (!supabaseUrl || !serviceKey) return json(res, 500, { error: 'Server misconfigured' });

  // Recordings management is ADMIN-ONLY (the Recordings pane moved to the admin-only
  // section) — assistants must not be able to change any school's recording visibility.
  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Not allowed' }); }

  const body = parseBody(req);
  const videoId = String(body.video_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(videoId)) return json(res, 400, { error: 'Bad video_id' });
  const set = Array.isArray(body.set) ? body.set.map(String) : null;

  const svc = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const svcJson = Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, svc);
  const get = async (path) => { const r = await fetch(supabaseUrl + '/rest/v1/' + path, { headers: svc }); return r.ok ? r.json() : []; };

  // The anchor row + its private ref.
  const anchor = (await get('videos?client_id=eq.' + SITE_CLIENT_ID + '&id=eq.' + encodeURIComponent(videoId) + '&select=id,title,track,level,kind,created_at'))[0];
  if (!anchor) return json(res, 404, { error: 'Recording not found' });
  const ref = ((await get('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(videoId) + '&select=url'))[0] || {}).url || '';
  if (!ref) return json(res, 404, { error: 'Recording source not found' });

  // Every sibling row sharing the same ref + level + kind (one row per school). A null kind
  // must match ONLY null — otherwise a same-ref espresso row would merge into this editor.
  const kindFilter = anchor.kind ? '&kind=eq.' + encodeURIComponent(anchor.kind) : '&kind=is.null';
  const loadSiblings = async () => {
    const urlRows = await get('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&url=eq.' + encodeURIComponent(ref) + '&select=video_id');
    const ids = urlRows.map(r => r.video_id);
    if (!ids.length) return [];
    const vids = await get('videos?client_id=eq.' + SITE_CLIENT_ID + '&id=in.(' + ids.map(encodeURIComponent).join(',') + ')' +
      '&level=eq.' + encodeURIComponent(anchor.level) + kindFilter + '&select=id,track');
    return vids.map(v => ({ school: v.track, video_id: v.id }));
  };

  let schools = await loadSiblings();

  if (set) {
    if (!set.length) return json(res, 400, { error: 'Keep at least one school — use Delete to remove the recording.' });
    const have = new Set(schools.map(s => s.school));
    // Add missing schools: clone the anchor's metadata + ref.
    for (const school of set) {
      if (have.has(school)) continue;
      const ins = await fetch(supabaseUrl + '/rest/v1/videos', {
        method: 'POST', headers: svcJson,
        // Same date as the original upload: to the student it is the same lesson, and to the
        // admin's list it is the same card.
        body: JSON.stringify({ client_id: SITE_CLIENT_ID, title: anchor.title, url: '', track: school, level: anchor.level, kind: anchor.kind || null, created_at: anchor.created_at || undefined }),
      });
      const row = ins.ok ? (await ins.json())[0] : null;
      if (row && row.id) {
        // The ref row must land too — otherwise roll the metadata row back, or it becomes an
        // invisible orphan (loadSiblings starts from recording_urls, so it would never show).
        let linked = false;
        try {
          const lr = await fetch(supabaseUrl + '/rest/v1/recording_urls', {
            method: 'POST', headers: svcJson,
            body: JSON.stringify({ client_id: SITE_CLIENT_ID, video_id: row.id, url: ref }),
          });
          linked = lr.ok;
        } catch (_) {}
        if (!linked) {
          try { await fetch(supabaseUrl + '/rest/v1/videos?client_id=eq.' + SITE_CLIENT_ID + '&id=eq.' + encodeURIComponent(row.id), { method: 'DELETE', headers: svc }); } catch (_) {}
        }
      }
    }
    // Remove unticked schools (their metadata rows only — the video file stays).
    const del = async (path) => { try { await fetch(supabaseUrl + '/rest/v1/' + path, { method: 'DELETE', headers: svc }); } catch (_) {} };
    for (const s of schools) {
      if (set.includes(s.school)) continue;
      await del('recording_requests?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(s.video_id));
      await del('recording_views?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(s.video_id));
      await del('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(s.video_id));
      await del('videos?client_id=eq.' + SITE_CLIENT_ID + '&id=eq.' + encodeURIComponent(s.video_id));
    }
    schools = await loadSiblings();
  }

  const refKind = ref.startsWith('bunny:') ? 'stream' : (ref.startsWith('drive:') || /drive\.google/.test(ref) ? 'drive' : 'link');
  return json(res, 200, { title: anchor.title, level: anchor.level, kind: anchor.kind || 'full', ref_kind: refKind, schools });
};
