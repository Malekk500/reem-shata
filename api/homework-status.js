// Read-only: resolve a student's saved decisions for active/reopened assignments.
// Reopening links stay server-only, and every result query is restricted to the JWT owner.
const { createClient } = require('@supabase/supabase-js');
const { setCors, json } = require('../lib/bunny');
const CLIENT = 'shata';
const STATUSES = new Set(['submitted', 'incomplete', 'missing', 'excused']);
async function allRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query().range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 500) return rows;
  }
}
module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE) return json(res, 503, { error: 'Saved homework results are temporarily unavailable.' });
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE,
    { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json(res, 401, { error: 'Please sign in again.' });
    const auth = await db.auth.getUser(token);
    if (auth.error || !auth.data.user) return json(res, 401, { error: 'Please sign in again.' });
    const uid = auth.data.user.id;
    const { data: profile, error } = await db.from('profiles').select('role,school,level')
      .eq('client_id', CLIENT).eq('user_id', uid).maybeSingle();
    if (error) throw error;
    if (!profile || profile.role !== 'student') return json(res, 403, { error: 'Student account required.' });
    const homework = await allRows(() => db.from('homework').select('id,title,school,level,due,created_at')
      .eq('client_id', CLIENT).eq('school', profile.school).eq('level', profile.level).order('id'));
    if (!homework.length) return json(res, 200, { statuses: {} });
    const ids = homework.map(h => h.id);
    const results = await allRows(() => db.from('homework_results').select('id,homework_title,school,level,due,status,finalized_at')
      .eq('client_id', CLIENT).eq('user_id', uid).order('id'));
    const reviews = [], links = [];
    for (let i = 0; i < ids.length; i += 100) {
      const group = ids.slice(i, i + 100);
      const [r, l] = await Promise.all([
        allRows(() => db.from('homework_reviews').select('homework_id,status')
          .eq('client_id', CLIENT).eq('user_id', uid).in('homework_id', group).order('homework_id')),
        allRows(() => db.from('shata_homework_reopen_links').select('homework_id,source_ids')
          .in('homework_id', group).order('homework_id')),
      ]);
      reviews.push(...r); links.push(...l);
    }
    const reviewById = new Map(reviews.map(r => [r.homework_id, r.status]));
    const linksById = new Map(links.map(l => [l.homework_id, new Set(l.source_ids || [])]));
    const statuses = {};
    for (const h of homework) {
      const sourceIds = linksById.get(h.id);
      const saved = results.find(r => sourceIds ? sourceIds.has(r.id)
        : r.homework_title === h.title && r.school === h.school && r.level === h.level
          && (r.due || null) === (h.due || null) && r.finalized_at >= h.created_at);
      let status = reviewById.get(h.id) || (saved && saved.status);
      if (status === 'cancelled') status = 'missing';
      if (STATUSES.has(status)) statuses[h.id] = { status, result_id: saved ? saved.id : null };
    }
    return json(res, 200, { statuses });
  } catch (e) {
    console.error('[homework-status]', e.message || e);
    return json(res, 503, { error: 'Could not verify saved homework results. Please refresh before submitting again.' });
  }
};
