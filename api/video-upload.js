// POST /api/video-upload  — ADMIN only (the Recordings pane is admin-only). The upload broker.
// Creates a video object in the Bunny library and returns the minimum for the browser to upload
// DIRECTLY to Bunny via TUS. Video bytes never pass through this function. NEVER returns the API key.
const { setCors, json, sha256hex, bunnyEnv, parseBody, requireRole } = require('../lib/bunny.js');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { libraryId, apiKey } = bunnyEnv();
  if (!libraryId || !apiKey) return json(res, 500, { error: 'BUNNY_LIBRARY_ID / BUNNY_API_KEY not configured' });

  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Not allowed' }); }

  const body = parseBody(req);
  const title = String(body.title || 'Lesson').slice(0, 200);

  // 1) Create the Bunny video → get its GUID.
  let guid = '';
  try {
    const r = await fetch('https://video.bunnycdn.com/library/' + libraryId + '/videos', {
      method: 'POST',
      headers: { AccessKey: apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ title }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('[video-upload] bunny create', r.status, t.slice(0, 200)); return json(res, 502, { error: 'Could not create the video on Bunny.' }); }
    const j = await r.json();
    guid = j && j.guid;
  } catch (e) { console.error('[video-upload]', e && e.message); return json(res, 502, { error: 'Bunny unreachable — try again.' }); }
  if (!guid) return json(res, 502, { error: 'Bunny returned no video id.' });

  // 2) TUS credentials: signature = sha256(libraryId + apiKey + expire + guid); 24h to finish uploading.
  const expire = Math.floor(Date.now() / 1000) + 86400;
  const signature = sha256hex(String(libraryId) + apiKey + expire + guid);

  return json(res, 200, {
    guid,
    libraryId: String(libraryId),
    tusEndpoint: 'https://video.bunnycdn.com/tusupload',
    signature,
    expire,
    ref: 'bunny:' + guid, // stored PRIVATELY in recording_urls on success — never in the shared videos table
  });
};
