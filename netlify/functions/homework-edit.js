// Called by admin-ops after verifying the caller's JWT and tenant.
const CLIENT = 'shata';
const FIELDS = ['title', 'description', 'school', 'level', 'due', 'due_at'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(message, status = 409) {
  const error = new Error(message); error.status = status; throw error;
}

exports.editHomework = async function (admin, callerId, callerRole, body) {
  if (callerRole !== 'admin') fail('Only an admin can edit assigned homework.', 403);
  if (typeof body.homework_id !== 'string' || !UUID.test(body.homework_id)) fail('Invalid homework.', 400);
  const patch = body.changes, expected = body.expected;
  if (!patch || !expected || FIELDS.some(k => !Object.prototype.hasOwnProperty.call(expected, k))) {
    fail('Open the assignment again before saving.', 400);
  }
  for (const [key, max] of [['title', 300], ['description', 20000], ['school', 120], ['level', 120]]) {
    if (typeof patch[key] !== 'string' || patch[key].length > max || (key !== 'description' && !patch[key].trim())) {
      fail('Enter a valid homework name, instructions, school and track.', 400);
    }
  }
  const due = typeof patch.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(patch.due) ? new Date(patch.due + 'T00:00:00Z') : null;
  if (!due || !Number.isFinite(due.getTime()) || due.toISOString().slice(0, 10) !== patch.due) fail('Choose a valid deadline date.', 400);
  if (patch.due_at !== null && (typeof patch.due_at !== 'string' || !Number.isFinite(Date.parse(patch.due_at)))) {
    fail('Choose a valid deadline time.', 400);
  }
  const { data: hw, error: loadError } = await admin.from('homework').select('*')
    .eq('client_id', CLIENT).eq('id', body.homework_id).maybeSingle();
  if (loadError) throw loadError;
  if (!hw) fail('This homework is no longer assigned. Refresh the list.');
  if (FIELDS.some(k => (hw[k] ?? null) !== expected[k])) fail('This homework changed while you were editing. Reopen it to load the latest details.');

  // Validate a changed audience against the same registry used by the portal.
  // A legacy audience may be kept even if it is no longer in the registry.
  if (patch.school !== hw.school || patch.level !== hw.level) {
    const { data: setting, error } = await admin.from('settings').select('value')
      .eq('client_id', CLIENT).eq('key', 'schools').maybeSingle();
    if (error) throw error;
    const value = setting && setting.value;
    let schools = Array.isArray(value) ? value : value && Array.isArray(value.list) ? value.list : [];
    if (!schools.length) schools = [
      'Alexandria Language School', 'Quds International School', 'Saint Fatima Language School',
      'Private Group 1', 'Private Group 2', 'Online Group'
    ].map(name => ({ name, tracks: name === 'Online Group' ? ['IGCSE EXTENDED'] : ['IGCSE CORE', 'IGCSE EXTENDED'] }));
    const school = schools.find(s => s && s.name === patch.school);
    const tracks = school && Array.isArray(school.tracks) ? school.tracks.filter(t => ['IGCSE CORE', 'IGCSE EXTENDED'].includes(t)) : [];
    if (!school || !(tracks.length ? tracks : ['IGCSE CORE', 'IGCSE EXTENDED']).includes(patch.level)) {
      fail('Choose a school and track from Schools & Tracks.', 400);
    }
  }

  // A partially finalized assignment must finish under its original identity.
  let resultQuery = admin.from('homework_results').select('id').eq('client_id', CLIENT)
    .eq('homework_title', hw.title).eq('school', hw.school).eq('level', hw.level)
    .gte('finalized_at', hw.created_at).limit(1);
  resultQuery = hw.due ? resultQuery.eq('due', hw.due) : resultQuery.is('due', null);
  const { data: results, error: resultError } = await resultQuery;
  if (resultError) throw resultError;
  if (results && results.length) fail('Finalization has already started for this homework. Finish it from Homework Review before editing anything else.');

  // One update on the existing ID preserves uploads, review rows and file paths.
  const changes = Object.fromEntries(FIELDS.map(k => [k, patch[k]]));
  let update = admin.from('homework').update(changes).eq('client_id', CLIENT).eq('id', hw.id);
  for (const key of FIELDS) update = expected[key] === null ? update.is(key, null) : update.eq(key, expected[key]);
  const { data: saved, error: saveError } = await update.select('*').maybeSingle();
  if (saveError) throw saveError;
  if (!saved) fail('This homework changed or was finalized while you were editing. Refresh the list before trying again.');
  try {
    await admin.from('activity_log').insert({ client_id: CLIENT, user_id: callerId,
      action: 'Edited assigned homework', detail: { role: 'admin', target: saved.title,
        homework_id: hw.id, before: Object.fromEntries(FIELDS.map(k => [k, hw[k] ?? null])), after: changes } });
  } catch (_) { /* An audit outage must not report an already committed edit as failed. */ }
  return { ok: true, homework: saved };
};
