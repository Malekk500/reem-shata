// Called only after admin-ops has verified the caller's JWT, tenant and staff role.
// Keep finalization on the server: a browser reload must not interrupt it between
// saving results and removing the active assignment. No schema/RLS changes needed.
const { createHash } = require('node:crypto');
const CLIENT = 'shata';
const STATUSES = new Set(['submitted', 'incomplete', 'missing', 'excused']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message, status = 409) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

async function allRows(query) {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query().range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 500) return rows;
  }
}

function resultId(homeworkId, userId) {
  // Stable IDs also protect retries of legacy assignments whose due date is NULL
  // (NULLs need not conflict under the database's existing composite unique key).
  const h = createHash('sha256').update(`${CLIENT}:${homeworkId}:${userId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

exports.finalizeHomework = async function (admin, callerId, callerRole, body) {
  const hwId = body.homework_id;
  if (typeof hwId !== 'string' || !UUID.test(hwId)) fail('Invalid homework.', 400);
  if (!Array.isArray(body.results) || !body.results.length || body.results.length > 5000) {
    fail('Review every student before finalizing.', 400);
  }
  const decisions = new Map();
  for (const r of body.results) {
    if (!r || typeof r.user_id !== 'string' || !UUID.test(r.user_id) ||
        !STATUSES.has(r.status) || decisions.has(r.user_id)) fail('Invalid or duplicate student result.', 400);
    decisions.set(r.user_id, {
      status: r.status,
      reason: r.status === 'excused' && typeof r.reason === 'string' ? r.reason.trim().slice(0, 300) || null : null,
    });
  }

  const { data: hw, error: loadError } = await admin.from('homework')
    .select('id,title,description,school,level,due,due_at,created_at').eq('client_id', CLIENT).eq('id', hwId).maybeSingle();
  if (loadError) throw loadError;
  const { data: reopenLink, error: reopenError } = await admin.from('shata_homework_reopen_links')
    .select('homework_id').eq('homework_id', hwId).maybeSingle();
  if (reopenError) throw reopenError;
  if (reopenLink) {
    const { data, error } = await admin.rpc('shata_finalize_reopened_homework', {
      p_hw_id: hwId, p_results: [...decisions].map(([user_id, decision]) => ({ user_id, ...decision })), p_actor: callerId,
    });
    if (error) { if (error.code === 'P0001') fail(error.message); throw error; }
    return data;
  }
  // Do not claim that a missing assignment was finalized: it may have been discarded.
  if (!hw) fail('This assignment is no longer active. Refresh Homework and check History.');

  if (callerRole !== 'admin') {
    const { data: setting, error } = await admin.from('settings').select('value')
      .eq('client_id', CLIENT).eq('key', 'assist_schools').maybeSingle();
    if (error) throw error;
    const schools = setting && setting.value && setting.value[callerId];
    if (Array.isArray(schools) && schools.length && !schools.includes(hw.school)) fail('You do not have access to this class.', 403);
  }

  const resultQuery = () => {
    let q = admin.from('homework_results').select('id,user_id,status,finalized_at')
      .eq('client_id', CLIENT).eq('homework_title', hw.title).eq('school', hw.school).eq('level', hw.level);
    q = hw.due ? q.eq('due', hw.due) : q.is('due', null);
    return q.order('user_id').order('id');
  };
  const rosterQuery = () => admin.from('profiles').select('user_id,full_name,username')
    .eq('client_id', CLIENT).eq('role', 'student').eq('school', hw.school).eq('level', hw.level).order('user_id');
  const submissionQuery = () => admin.from('homework_submissions').select('user_id')
    .eq('client_id', CLIENT).eq('homework_id', hwId).order('user_id');
  const [roster, submissions, existing] = await Promise.all([
    allRows(rosterQuery), allRows(submissionQuery), allRows(resultQuery),
  ]);
  const required = new Set([...roster, ...submissions].map(r => r.user_id));
  const saved = new Set(existing.filter(r => STATUSES.has(r.status) || r.status === 'cancelled').map(r => r.user_id));
  // Never treat a different, older assignment with a reused title/date as a retry.
  if (existing.some(r => r.finalized_at && hw.created_at && new Date(r.finalized_at) < new Date(hw.created_at))) {
    fail('An older homework has the same title, class and due date. Its results have been preserved; this assignment needs a unique title before finalizing.');
  }
  if (!required.size) fail('There are no students to finalize.');
  if ([...decisions.keys()].some(uid => !required.has(uid))) {
    fail('The class roster changed. Refresh the review before finalizing.');
  }
  if ([...required].some(uid => !decisions.has(uid) && !saved.has(uid))) {
    fail('Some students still need a result. Refresh the review and mark everyone before finalizing.');
  }

  const at = new Date().toISOString();
  const rows = [...required].filter(uid => !saved.has(uid)).map(uid => ({
    id: resultId(hwId, uid), client_id: CLIENT, user_id: uid,
    homework_title: hw.title, school: hw.school, level: hw.level, due: hw.due || null,
    ...decisions.get(uid), finalized_at: at,
  }));
  if (rows.length) {
    const { error } = await admin.from('homework_results').upsert(rows, {
      onConflict: 'client_id,user_id,homework_title,school,level,due', ignoreDuplicates: true,
    });
    // A concurrent finalizer may win the deterministic primary key. Verify below;
    // never overwrite any result or reset its original correction window.
    if (error && error.code !== '23505') throw error;
  }

  // Re-read EVERY result, not merely "at least one exists" as the old client did.
  const confirmed = await allRows(resultQuery);
  const confirmedIds = new Set(confirmed.filter(r => STATUSES.has(r.status) || r.status === 'cancelled').map(r => r.user_id));
  if ([...required].some(uid => !confirmedIds.has(uid))) {
    fail('Finalization is incomplete. Saved results and uploads are safe. Press Save & finalize again to finish.');
  }
  const [latestRoster, latestSubmissions] = await Promise.all([allRows(rosterQuery), allRows(submissionQuery)]);
  if ([...latestRoster, ...latestSubmissions].some(r => !confirmedIds.has(r.user_id))) {
    fail('The class or uploads changed during saving. Refresh the review and mark the remaining students.');
  }
  const { data: deleted, error: deleteError } = await admin.from('homework').delete()
    .eq('client_id', CLIENT).eq('id', hwId).select('id');
  if (deleteError) {
    console.error('[finalize-homework] delete:', deleteError.message);
    fail('Results are saved, but the assignment could not be closed. Press Save & finalize again to finish.', 503);
  }
  if (!deleted || deleted.length !== 1) {
    const { data: remaining, error } = await admin.from('homework').select('id')
      .eq('client_id', CLIENT).eq('id', hwId).maybeSingle();
    if (error || remaining) fail('The assignment is still active. Saved results are safe; try finalizing again.', 503);
    // Another request completed it after our result verification.
  }
  if (deleted && deleted.length === 1) {
    try {
      const names = new Map(roster.map(r => [r.user_id, r.full_name || r.username || 'Student']));
      const { error } = await admin.from('activity_log').insert({
        client_id: CLIENT, user_id: callerId, action: 'Finalized homework',
        detail: { role: callerRole, target: `${hw.title} (${hw.school} · ${hw.level})`,
          homework: { id: hw.id, title: hw.title, school: hw.school, level: hw.level,
            description: hw.description, due: hw.due, due_at: hw.due_at, created_at: hw.created_at },
          homework_id: hwId, summary: `${required.size} student result(s) saved; assignment closed`,
          items: confirmed.map(r => ({ n: names.get(r.user_id) || 'Student with an existing upload', s: r.status })) },
      });
      if (error) console.warn('[finalize-homework] audit:', error.message);
    } catch (e) { console.warn('[finalize-homework] audit:', e.message); }
  }
  return { ok: true, finalized: true, homework_id: hwId, count: required.size, recovered: existing.length > 0 };
};
