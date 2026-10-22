// POST /api/video-list  — ADMIN only.
// The admin's recordings list: ONE entry per uploaded file.
//
// A recording serves several schools through one metadata row each, all pointing at the same
// private ref in recording_urls. A school added later through the Schools editor gets a row
// with a LATER date than the original upload, so grouping by anything the browser can see
// (title, level, date) splits one recording into two cards. The ref is the truth about which
// rows are the same file, and only the server can read it.
//
//   {} -> { groups: [{ id, ids, title, level, kind, date, schools }] }   newest first
//   `id` is the anchor row every button on the card passes back (Rename, Schools, Delete all
//   already resolve their siblings server-side from it).
const { SITE_CLIENT_ID, setCors, json, bunnyEnv, requireRole } = require('../lib/bunny.js');

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { supabaseUrl, serviceKey } = bunnyEnv();
  if (!supabaseUrl || !serviceKey) return json(res, 500, { error: 'Server misconfigured' });

  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Not allowed' }); }

  const svc = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const get = async (path) => {
    const r = await fetch(supabaseUrl + '/rest/v1/' + path, { headers: svc });
    if (!r.ok) throw new Error('read failed: ' + path.split('?')[0]);
    return r.json();
  };

  let vids, refs;
  try {
    [vids, refs] = await Promise.all([
      get('videos?client_id=eq.' + SITE_CLIENT_ID + '&select=id,title,track,level,kind,created_at&order=created_at.asc&limit=2000'),
      get('recording_urls?client_id=eq.' + SITE_CLIENT_ID + '&select=video_id,url&limit=2000'),
    ]);
  } catch (e) { return json(res, 500, { error: 'Could not load recordings.' }); }

  const refOf = {}; refs.forEach(r => { refOf[r.video_id] = r.url; });
  // Same file + same level + same kind = one recording. (Kind matters: a full lesson and its
  // Espresso are separate uploads, but a null kind must match ONLY null.)
  const groups = {}, order = [];
  vids.forEach(v => {
    const ref = refOf[v.id] || ('id:' + v.id);       // a row with no ref can only stand alone
    const key = ref + '|' + (v.level || '') + '|' + (v.kind || '');
    let g = groups[key];
    if (!g) {
      // Rows arrive oldest first, so the anchor is the ORIGINAL upload and the date is its date.
      g = groups[key] = { id: v.id, ids: [], title: v.title, level: v.level, kind: v.kind || null,
                          date: String(v.created_at || '').slice(0, 10), schools: [] };
      order.push(key);
    }
    g.ids.push(v.id);
    if (v.track && g.schools.indexOf(v.track) < 0) g.schools.push(v.track);
  });

  const out = order.map(k => groups[k]).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return json(res, 200, { groups: out });
};
