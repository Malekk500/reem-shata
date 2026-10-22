// Privileged admin operations for Mrs Reem's portal (service_role; server only).
// Every request must include the caller's Supabase JWT (Authorization: Bearer <token>).
// We verify the JWT, look up the caller's role in public.users, then gate per-action.
//   staff  = role in ('assist','admin')   -> create/delete students
//   owner  = role 'admin'                  -> assistants, passwords, danger zone
// Env vars required: SUPABASE_URL, SUPABASE_SERVICE_ROLE.
// Multi-tenant shared project: every profile row is stamped with SITE_CLIENT_ID
// and every lookup is scoped to it so this site can only touch its own tenant.
const { createClient } = require('@supabase/supabase-js');

const SITE_CLIENT_ID = 'shata';

// Production origin(s) come from Netlify env (set SITE_URL=https://<your>.netlify.app,
// and optional EXTRA_ORIGINS=comma,separated). Custom domain + localhost stay allowed.
const ALLOWED_ORIGINS = new Set([
  'https://reemshata.com',
  'https://www.reemshata.com',
  'http://localhost:999',
  'http://localhost:8888',
  'http://localhost:8124', // local preview server
  'http://127.0.0.1:999',
  'null',
]);
for (const o of [process.env.SITE_URL, ...String(process.env.EXTRA_ORIGINS || '').split(',')]) {
  const v = (o || '').trim().replace(/\/+$/, '');
  if (v) ALLOWED_ORIGINS.add(v);
}
const EMAIL_DOMAIN = '@reemshata.app';
let _reqOrigin = '';
function corsHeaders() {
  const allow = ALLOWED_ORIGINS.has(_reqOrigin) ? _reqOrigin : 'https://reemshata.com';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin', 'Content-Type': 'application/json',
  };
}
function bad(status, msg) { return { statusCode: status, headers: corsHeaders(), body: JSON.stringify({ error: msg }) }; }
function ok(payload) { return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(payload || { ok: true }) }; }

exports.handler = async function (event) {
  _reqOrigin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return bad(405, 'POST only');

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE;
  if (!SUPABASE_URL || !SERVICE_KEY) return bad(500, 'Server misconfigured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE');

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!token) return bad(401, 'Missing Authorization Bearer token');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

  let caller;
  try {
    const { data, error } = await admin.auth.getUser(token);
    if (error || !data?.user) return bad(401, 'Invalid or expired session token');
    caller = data.user;
  } catch (e) { return bad(401, 'Could not verify session: ' + (e.message || e)); }

  let callerRole;
  try {
    const { data: profile, error } = await admin.from('profiles').select('role, client_id')
      .eq('user_id', caller.id).maybeSingle();
    if (error){ console.error('[admin-ops] caller profile load:', error.message); return bad(500, 'Could not verify your account. Please try again.'); }
    if (!profile || profile.client_id !== SITE_CLIENT_ID) return bad(403, "This account isn't for this site.");
    callerRole = profile.role;
  } catch (e) { return bad(500, 'Profile lookup failed: ' + (e.message || e)); }

  const isStaff = (callerRole === 'assist' || callerRole === 'admin');
  const isOwner = (callerRole === 'admin');
  if (!isStaff) return bad(403, 'Staff role required');

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (_) { return bad(400, 'Bad JSON body'); }
  const { action, target_user_id, new_password } = body;
  if (!action) return bad(400, 'Missing action');

  const OWNER_ONLY = new Set(['create_assistant', 'delete_assistant', 'set_password', 'set_username', 'delete_all_students', 'sign_out_user', 'sign_out_all', 'rename_school', 'edit_homework', 'reopen_homework', 'reopen_homework_details']);
  if (OWNER_ONLY.has(action) && !isOwner) return bad(403, 'Owner (Mrs Reem) role required for this action');

  try {
    if (action === 'reopen_homework' || action === 'reopen_homework_details') {
      try {
        const { reopenHomework } = require('./homework-reopen.js');
        return ok(await reopenHomework(admin, caller.id, callerRole, body));
      } catch (e) {
        console.error('[admin-ops] reopen_homework:', e.message);
        return bad(e.status || 500, e.status ? e.message : 'Could not reopen this homework. Refresh History before trying again.');
      }
    }
    if (action === 'edit_homework') {
      try {
        const { editHomework } = require('./homework-edit.js');
        return ok(await editHomework(admin, caller.id, callerRole, body));
      } catch (e) {
        console.error('[admin-ops] edit_homework:', e.message);
        return bad(e.status || 500, e.status ? e.message : 'Could not save the homework changes. Please try again.');
      }
    }
    if (action === 'finalize_homework') {
      try {
        const { finalizeHomework } = require('./homework-finalize.js');
        return ok(await finalizeHomework(admin, caller.id, callerRole, body));
      } catch (e) {
        console.error('[admin-ops] finalize_homework:', e.message);
        return bad(e.status || 500, e.status ? e.message : 'Could not finish finalizing. Your saved results and any remaining uploads are safe. Try again.');
      }
    }
    // ---- update_hw_result (staff) — correct a finalized homework status. RLS has no staff
    // UPDATE policy on homework_results (client updates silently touch 0 rows), so the fix
    // runs here with the service role. The 48h edit window is enforced server-side too.
    // ---- rename_school (owner) — a school's NAME is the key that half a dozen tables join
    // on, so renaming it has to rewrite every one of them or its students and its content are
    // orphaned. homework_results has no staff UPDATE policy (see update_hw_result above), so
    // the whole move runs here with the service role instead of half of it in the browser.
    if (action === 'rename_school') {
      const oldName = String(body.old_name || '').replace(/\s+/g, ' ').trim();
      const newName = String(body.new_name || '').replace(/\s+/g, ' ').trim();
      if (!oldName || !newName) return bad(400, 'old_name and new_name are required');
      if (newName.length > 120) return bad(400, 'That name is too long');
      if (oldName === newName) return ok({ ok: true, moved: 0 });
      const TARGETS = [
        ['profiles', 'school'], ['homework', 'school'], ['homework_results', 'school'],
        ['videos', 'track'], ['announcements', 'track'], ['materials', 'track'], ['exams', 'track'],
      ];
      // Refuse to merge into a name that already has records. Two schools folded together
      // would collide on the homework_results unique key, and there is no way back.
      for (const [table, col] of TARGETS) {
        const { count, error } = await admin.from(table).select(col, { count: 'exact', head: true })
          .eq('client_id', SITE_CLIENT_ID).eq(col, newName);
        if (error) { console.error('[admin-ops] rename_school precheck ' + table + ':', error.message);
          return bad(500, 'Could not check the new name. Nothing was changed.'); }
        if (count) return bad(409, '"' + newName + '" already has records of its own. Renaming onto it would merge two schools, so pick a different name.');
      }
      let moved = 0;
      for (const [table, col] of TARGETS) {
        const patch = {}; patch[col] = newName;
        const { data, error } = await admin.from(table).update(patch)
          .eq('client_id', SITE_CLIENT_ID).eq(col, oldName).select(col);
        if (error) { console.error('[admin-ops] rename_school ' + table + ':', error.message);
          return bad(500, 'The rename stopped at ' + table + '. Run it again — it only moves whatever is still on the old name.'); }
        moved += (data || []).length;
      }
      return ok({ ok: true, moved });
    }

    if (action === 'update_hw_result') {
      const { hw_user_id, homework_title, school, level, due, status, reason } = body;
      if (!hw_user_id || !homework_title || !school || !level) return bad(400, 'Missing fields');
      if (!['submitted', 'incomplete', 'missing', 'excused'].includes(status)) return bad(400, 'Bad status');
      const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      // The reason only belongs to an excused result; any other status clears it.
      let q = admin.from('homework_results').update({ status, reason: status === 'excused' ? (typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null) : null })
        .eq('client_id', SITE_CLIENT_ID).eq('user_id', hw_user_id)
        .eq('homework_title', homework_title).eq('school', school).eq('level', level)
        .gte('finalized_at', cutoff);
      q = due ? q.eq('due', due) : q.is('due', null);
      const { data, error } = await q.select('id');
      if (error) { console.error('[admin-ops] update_hw_result:', error.message); return bad(500, 'Could not update the result.'); }
      if (!data || !data.length) return bad(409, 'This homework is older than 48 hours — it can no longer be edited.');
      return ok({ ok: true, updated: data.length });
    }
    // ---- set_username (owner only) — rename a login. The sign-in email IS the username
    // (username@reemshata.app), so the auth user and the profile row are updated together.
    if (action === 'set_username') {
      const { new_username } = body;
      if (!target_user_id || !new_username) return bad(400, 'Missing user or username');
      const uname = String(new_username).trim().toLowerCase();
      if (!/^[a-z0-9]+$/.test(uname)) return bad(400, 'Username must be lowercase letters and digits only (no spaces or symbols).');
      if (uname.length < 3) return bad(400, 'Username must be at least 3 characters');
      const newEmail = uname + EMAIL_DOMAIN;
      const { data: taken } = await admin.from('profiles').select('user_id')
        .eq('client_id', SITE_CLIENT_ID).eq('username', uname).maybeSingle();
      if (taken && taken.user_id !== target_user_id) return bad(409, 'That username is already taken.');
      const { error: authErr } = await admin.auth.admin.updateUserById(target_user_id, { email: newEmail, email_confirm: true });
      if (authErr) {
        const m = (authErr.message || '').toLowerCase();
        if (m.includes('already') || m.includes('registered')) return bad(409, 'That username is already taken.');
        console.error('[admin-ops] set_username auth:', authErr.message);
        return bad(500, 'Could not change the username. Please try again.');
      }
      const { error: pErr } = await admin.from('profiles').update({ username: uname, email: newEmail })
        .eq('client_id', SITE_CLIENT_ID).eq('user_id', target_user_id);
      if (pErr) { console.error('[admin-ops] set_username profile:', pErr.message); return bad(500, 'Login renamed but the profile did not save. Please try again.'); }
      return ok({ ok: true, username: uname });
    }
    // ---- create_student (staff or owner) ----
    if (action === 'create_student') {
      const { name, username, password, school, level, phone, parent } = body;
      if (!name || !username || !password) return bad(400, 'Missing name / username / password');
      if (password.length < 6) return bad(400, 'Password must be at least 6 chars');
      if (!/^[a-z0-9]+$/.test(username)) return bad(400, 'Username must be lowercase letters/digits only');
      const email = username + EMAIL_DOMAIN;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (createErr) {
        const m = (createErr.message || '').toLowerCase();
        if (m.includes('already')) return bad(409, 'That username is already taken.');
        { console.error('[admin-ops] create user failed:', createErr.message); return bad(500, 'Could not create the account. Please try again.'); }
      }
      const newUid = created?.user?.id;
      if (!newUid) return bad(500, 'Auth user created but no ID returned');
      const { error: insErr } = await admin.from('profiles').insert({
        user_id: newUid, client_id: SITE_CLIENT_ID, username, role: 'student',
        full_name: name, email,
        school: school || null, level: level || null, phone: phone || null,
        parent_phone: parent || null,   // profiles.parent_phone column now exists
      });
      if (insErr) { try { await admin.auth.admin.deleteUser(newUid); } catch (_) {} console.error('[admin-ops] profile insert failed:', insErr.message); return bad(500, 'Could not save the account profile. Please try again.'); }
      // Save the password for admin-only reveal later (Student Profiles). Best-effort.
      try { await admin.from('student_secrets').upsert({ client_id: SITE_CLIENT_ID, user_id: newUid, password, updated_at: new Date().toISOString() }, { onConflict: 'client_id,user_id' }); } catch (_) {}
      return ok({ ok: true, id: newUid, username });
    }

    // ---- delete_student (staff or owner) ----
    if (action === 'delete_student') {
      const uid = target_user_id;
      if (!uid) return bad(400, 'Missing target_user_id');
      // FAIL CLOSED: the auth.users table is shared across tenants, so only delete when the
      // profile exists, belongs to THIS tenant, and is actually a student.
      const { data: target } = await admin.from('profiles').select('role, client_id').eq('user_id', uid).maybeSingle();
      if (!target || target.client_id !== SITE_CLIENT_ID) return bad(403, 'That account is not on this site.');
      if (target.role !== 'student') return bad(403, 'That account is not a student.');
      try { await admin.auth.admin.deleteUser(uid); } catch (e) { await admin.from('profiles').delete().eq('user_id', uid).eq('client_id', SITE_CLIENT_ID); }
      return ok({ ok: true });
    }

    // ---- create_assistant (owner only) ----
    if (action === 'create_assistant') {
      const { name, username, password } = body;
      if (!name || !username || !password) return bad(400, 'Missing name / username / password');
      if (password.length < 8) return bad(400, 'Password must be at least 8 chars');
      if (!/^[a-z0-9]+$/.test(username)) return bad(400, 'Username must be lowercase letters/digits only');
      const email = username + EMAIL_DOMAIN;
      const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (createErr) {
        const m = (createErr.message || '').toLowerCase();
        if (m.includes('already')) return bad(409, 'That username is already taken.');
        { console.error('[admin-ops] create user failed:', createErr.message); return bad(500, 'Could not create the account. Please try again.'); }
      }
      const newUid = created?.user?.id;
      if (!newUid) return bad(500, 'Auth user created but no ID returned');
      const { error: insErr } = await admin.from('profiles').insert({
        user_id: newUid, client_id: SITE_CLIENT_ID, username, role: 'assist', full_name: name, email
      });
      if (insErr) { try { await admin.auth.admin.deleteUser(newUid); } catch (_) {} console.error('[admin-ops] profile insert failed:', insErr.message); return bad(500, 'Could not save the account profile. Please try again.'); }
      return ok({ ok: true, id: newUid, username });
    }

    // ---- delete_assistant (owner only) ----
    if (action === 'delete_assistant') {
      const uid = target_user_id;
      if (!uid) return bad(400, 'Missing target_user_id');
      if (uid === caller.id) return bad(400, 'You cannot delete your own account.');
      // FAIL CLOSED (shared auth.users): only delete an assistant that exists on THIS tenant.
      const { data: target } = await admin.from('profiles').select('role, client_id').eq('user_id', uid).maybeSingle();
      if (!target || target.client_id !== SITE_CLIENT_ID) return bad(403, 'That account is not on this site.');
      if (target.role === 'admin') return bad(403, 'Cannot delete an owner account here.');
      if (target.role !== 'assist') return bad(403, 'That account is not an assistant.');
      try { await admin.auth.admin.deleteUser(uid); } catch (e) { await admin.from('profiles').delete().eq('user_id', uid).eq('client_id', SITE_CLIENT_ID); }
      return ok({ ok: true });
    }

    // ---- set_password (owner only; cannot target self via this path) ----
    if (action === 'set_password') {
      if (!target_user_id) return bad(400, 'Missing target_user_id');
      if (!new_password || new_password.length < 6) return bad(400, 'Password must be at least 6 chars');
      if (target_user_id === caller.id) return bad(400, 'Use the Supabase dashboard to change your own password.');
      // Tenant guard: only touch accounts on this site.
      const { data: tgt } = await admin.from('profiles').select('client_id').eq('user_id', target_user_id).maybeSingle();
      if (!tgt || tgt.client_id !== SITE_CLIENT_ID) return bad(403, 'That account is not on this site.');
      const { error } = await admin.auth.admin.updateUserById(target_user_id, { password: new_password });
      if (error){ console.error('[admin-ops] password update:', error.message); return bad(500, 'Could not update the password. Please try again.'); }
      // Keep the admin-only saved copy in sync (Student Profiles reveal). Best-effort.
      try { await admin.from('student_secrets').upsert({ client_id: SITE_CLIENT_ID, user_id: target_user_id, password: new_password, updated_at: new Date().toISOString() }, { onConflict: 'client_id,user_id' }); } catch (_) {}
      try { await admin.auth.admin.signOut(target_user_id); } catch (_) {}
      return ok();
    }

    // ---- sign_out_user (owner only) ----
    if (action === 'sign_out_user') {
      if (!target_user_id) return bad(400, 'Missing target_user_id');
      const { data: tgt } = await admin.from('profiles').select('client_id').eq('user_id', target_user_id).maybeSingle();
      if (!tgt || tgt.client_id !== SITE_CLIENT_ID) return bad(403, 'That account is not on this site.');
      // Remote sign-out: drop their device_sessions rows (heartbeat then bounces the
      // client) and revoke the Supabase auth session.
      try { await admin.from('device_sessions').delete().eq('client_id', SITE_CLIENT_ID).eq('user_id', target_user_id); } catch (_) {}
      try { await admin.auth.admin.signOut(target_user_id); } catch (e) {}
      return ok();
    }

    // ---- sign_out_all (owner only) ----
    if (action === 'sign_out_all') {
      try {
        const { data: users } = await admin.from('profiles').select('user_id')
          .eq('client_id', SITE_CLIENT_ID).neq('user_id', caller.id);
        // Wipe this tenant's device_sessions in one shot, then revoke auth sessions.
        try { await admin.from('device_sessions').delete().eq('client_id', SITE_CLIENT_ID).neq('user_id', caller.id); } catch (_) {}
        if (users?.length) for (const u of users) { try { await admin.auth.admin.signOut(u.user_id); } catch (_) {} }
      } catch (e) { return bad(500, 'Sign-out sweep failed: ' + (e.message || e)); }
      return ok();
    }

    // ---- delete_all_students (owner only) ----
    if (action === 'delete_all_students') {
      const { data: students, error: listErr } = await admin.from('profiles').select('user_id')
        .eq('client_id', SITE_CLIENT_ID).eq('role', 'student');
      if (listErr){ console.error('[admin-ops] list students:', listErr.message); return bad(500, 'Could not list students. Please try again.'); }
      let deleted = 0;
      for (const s of (students || [])) { try { await admin.auth.admin.deleteUser(s.user_id); deleted++; } catch (_) {} }
      return ok({ ok: true, count: deleted });
    }

    // ---- ai_usage_stats (staff or owner): read-only AI-helper analytics for the dashboard.
    // No model names, no per-student limits — just capacity used vs the site-wide daily cap,
    // plus who uses the helper most. Aggregated IN SQL (shata_ai_usage_stats) so numbers stay
    // exact at any volume — a JS aggregation here silently truncated at PostgREST's page cap. ----
    if (action === 'ai_usage_stats') {
      const { data, error } = await admin.rpc('shata_ai_usage_stats');
      if (error) { console.error('[admin-ops] ai_usage_stats:', error.message); return bad(500, 'Could not load AI usage.'); }
      const stats = data || {};
      // Site-wide daily capacity (all students combined). Resets automatically at midnight UTC
      // because "today" is just a date filter. Keep in sync with AI_SITE_DAILY_LIMIT in ai.js.
      const cap = parseInt(process.env.AI_SITE_DAILY_LIMIT || '3000', 10);
      return ok({ ok: true, totals: stats.totals || { today: 0, week: 0, month: 0 },
        topUsers: stats.topUsers || [], activeStudents: stats.activeStudents || 0,
        cap, generated_at: new Date().toISOString() });
    }

    return bad(400, 'Unknown action: ' + action);
  } catch (e) {
    return bad(500, 'Operation failed: ' + (e.message || e));
  }
};
