// Only admin-ops calls this, after verifying JWT, tenant, and admin role.
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
exports.reopenHomework = async function (admin, actor, role, body) {
  if (role !== 'admin') fail('Only an admin can reopen homework.', 403);
  const source = body.source;
  if (!source || ['title', 'school', 'level'].some(k => typeof source[k] !== 'string' || !source[k].trim() || source[k].length > 300)
      || (source.due !== null && (typeof source.due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source.due)))
      || typeof source.newest !== 'string' || !Number.isFinite(Date.parse(source.newest))) fail('Refresh History and select a finalized homework.');
  let query = admin.from('homework_results').select('id,finalized_at').eq('client_id', 'shata')
    .eq('homework_title', source.title).eq('school', source.school).eq('level', source.level)
    .order('finalized_at', { ascending: false }).limit(1);
  query = source.due ? query.eq('due', source.due) : query.is('due', null);
  const { data: history, error: historyError } = await query;
  if (historyError) throw historyError;
  if (!history || !history.length || Date.parse(history[0].finalized_at) !== Date.parse(source.newest)) {
    fail('This homework history changed. Refresh History and select it again.', 409);
  }
  if (body.action === 'reopen_homework_details') {
    // New finalizations preserve instructions in the existing audit record. Older
    // records may contain only the name/class/date, so never invent instructions.
    const { data, error } = await admin.from('activity_log').select('detail')
      .eq('client_id', 'shata').contains('detail', { homework: {
        title: source.title, school: source.school, level: source.level, due: source.due
      } }).order('created_at', { ascending: false }).limit(1);
    if (error) throw error;
    const snapshot = data && data[0] && data[0].detail && data[0].detail.homework;
    return { ok: true, description: snapshot && typeof snapshot.description === 'string' ? snapshot.description : '',
      instructions_available: !!(snapshot && typeof snapshot.description === 'string') };
  }
  const due = body.due, instant = typeof body.due_at === 'string' ? new Date(body.due_at) : null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)
      || !instant || !Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) fail('Choose a future deadline.');
  if (typeof body.description !== 'string' || body.description.length > 20000) fail('Instructions must be 20,000 characters or fewer.');
  const { data, error } = await admin.rpc('shata_reopen_homework', {
    p_title: source.title, p_school: source.school, p_level: source.level, p_old_due: source.due,
    p_expected_newest: source.newest, p_due: due, p_due_at: instant.toISOString(),
    p_description: body.description.trim(), p_actor: actor,
  });
  if (error) {
    if (error.code === 'P0001') fail(error.message, 409);
    throw error;
  }
  return data;
};
