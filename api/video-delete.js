// POST /api/video-delete  — STAFF only (admin/assistant).
// Deletes the recording from Bunny (freeing storage) AND removes its DB rows, tenant-scoped.
// A Bunny hiccup must not block DB removal — Bunny delete is best-effort (200 or 404 = success).
const { SITE_CLIENT_ID, setCors, json, bunnyEnv, parseBody, requireRole } = require('../lib/bunny.js');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { libraryId, apiKey, supabaseUrl, serviceKey } = bunnyEnv();
  if (!supabaseUrl || !serviceKey) return json(res, 500, { error: 'Server misconfigured' });

  // Recordings management is ADMIN-ONLY (the Recordings pane moved to the admin-only section).
  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Not allowed' }); }

  const body = parseBody(req);
  const videoId = String(body.video_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(videoId)) return json(res, 400, { error: 'Bad video_id' });

  const svc = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };

  // Look up the private ref (service role, tenant-scoped).
  let ref = '';
  try {
    const q = await fetch(supabaseUrl + '/rest/v1/recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(videoId) + '&select=url', { headers: svc });
    const rows = q.ok ? await q.json() : [];
    ref = (rows[0] && rows[0].url) || '';
  } catch (_) {}

  // One uploaded file can serve several schools (one metadata row each, same ref).
  // Only delete the file from storage when THIS is the last row using it.
  let refCount = 1;
  if (ref) {
    try {
      const q = await fetch(supabaseUrl + '/rest/v1/recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&url=eq.' + encodeURIComponent(ref) + '&select=video_id', { headers: svc });
      const rows = q.ok ? await q.json() : [];
      refCount = rows.length || 1;
    } catch (_) {}
  }

  // If it's a hosted recording and this is the LAST reference, delete the file (best-effort).
  let bunnyDeleted = false;
  if (ref.startsWith('bunny:') && refCount <= 1 && libraryId && apiKey) {
    const guid = ref.slice(6);
    try {
      const r = await fetch('https://video.bunnycdn.com/library/' + libraryId + '/videos/' + guid, { method: 'DELETE', headers: { AccessKey: apiKey, accept: 'application/json' } });
      bunnyDeleted = (r.status === 200 || r.status === 404);
    } catch (_) {}
  }

  // Delete DB rows, tenant-scoped (best-effort each; order: dependents first).
  const del = async (path) => { try { await fetch(supabaseUrl + '/rest/v1/' + path, { method: 'DELETE', headers: svc }); } catch (_) {} };
  await del('recording_requests?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(videoId));
  await del('recording_views?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(videoId));
  await del('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&video_id=eq.' + encodeURIComponent(videoId));
  await del('videos?client_id=eq.' + SITE_CLIENT_ID + '&id=eq.' + encodeURIComponent(videoId));

  return json(res, 200, { ok: true, bunnyDeleted });
};
