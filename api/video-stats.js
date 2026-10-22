// POST /api/video-stats  — ADMIN only (assistants are rejected server-side).
// Pages the Bunny library and returns usage totals + per-video breakdown. No key, no playable URL.
const { setCors, json, bunnyEnv, requireRole } = require('../lib/bunny.js');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { libraryId, apiKey } = bunnyEnv();
  if (!libraryId || !apiKey) return json(res, 500, { error: 'BUNNY_LIBRARY_ID / BUNNY_API_KEY not configured' });

  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Admin only' }); }

  let storageBytes = 0, totalViews = 0, totalWatchSeconds = 0, streamedBytes = 0, videoCount = 0;
  const videos = [];
  try {
    for (let page = 1; page <= 20; page++) {
      const r = await fetch('https://video.bunnycdn.com/library/' + libraryId + '/videos?page=' + page + '&itemsPerPage=100&orderBy=date',
        { headers: { AccessKey: apiKey, accept: 'application/json' } });
      if (!r.ok) break;
      const j = await r.json();
      const items = (j && j.items) || [];
      for (const it of items) {
        const size = Number(it.storageSize) || 0, views = Number(it.views) || 0, watch = Number(it.totalWatchTime) || 0, len = Number(it.length) || 0;
        // GB delivered (estimate): the fraction of the video that was watched × its file size.
        // Slightly high (storageSize covers all renditions) — the exact billed figure lives in Bunny billing.
        const streamed = len > 0 ? (watch / len) * size : 0;
        storageBytes += size; totalViews += views; totalWatchSeconds += watch; streamedBytes += streamed; videoCount++;
        videos.push({ title: it.title, guid: it.guid, sizeBytes: size, views, length: len, watchSeconds: watch, streamedBytes: streamed, status: String(it.status) });
      }
      if (items.length < 100) break; // last page
    }
  } catch (e) { console.error('[video-stats]', e && e.message); return json(res, 502, { error: 'Could not load Bunny stats.' }); }

  return json(res, 200, { storageBytes, totalViews, totalWatchSeconds, streamedBytes, videoCount, videos });
};
