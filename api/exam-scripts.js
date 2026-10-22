// Private returned exam scripts. No score writes; files belong to an existing mark ID.
// The bucket has NO client RLS grants. Every read/upload/delete is authorized here.
const { createClient } = require('@supabase/supabase-js');
const { randomUUID } = require('crypto');
const { setCors, json, parseBody } = require('../lib/bunny');

const CLIENT = 'shata';
const BUCKET = 'shata-exam-scripts';
const ONLINE = 'Online Group';
const MAX_SIZE = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif' };
function fail(status, message) { throw { status, message }; }
async function rows(query) {
  const out = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query().range(offset, offset + 499);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < 500) return out;
  }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return json(res, 503, { error: 'Exam-script storage is not configured yet.' });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (!token) fail(401, 'Please sign in again.');
    const auth = await db.auth.getUser(token);
    if (auth.error || !auth.data.user) fail(401, 'Please sign in again.');
    const uid = auth.data.user.id;
    const callerResult = await db.from('profiles').select('role')
      .eq('client_id', CLIENT).eq('user_id', uid).maybeSingle();
    if (callerResult.error) throw callerResult.error;
    const caller = callerResult.data;
    if (!caller || !['admin', 'assist', 'student'].includes(caller.role)) fail(403, 'This account cannot access exam scripts.');
    const staff = ['admin', 'assist'].includes(caller.role);
    let allowedSchools = null;
    if (caller.role === 'assist') {
      const result = await db.from('settings').select('value').eq('client_id', CLIENT).eq('key', 'assist_schools').maybeSingle();
      if (result.error) throw result.error; // Fail closed on a failed permissions lookup.
      const scope = result.data && result.data.value && result.data.value[uid];
      if (Array.isArray(scope) && scope.length) allowedSchools = scope;
      else if (scope != null && !Array.isArray(scope)) fail(403, 'Your school permissions need to be checked by an admin.');
    }
    const allowed = school => !allowedSchools || allowedSchools.includes(school);
    const body = parseBody(req);
    if (body.action === 'roster') {
      if (!staff || !allowed(ONLINE)) fail(403, 'You do not have access to Online Group.');
      if (typeof body.level !== 'string' || !body.level || body.level.length > 100) fail(400, 'Choose a track first.');
      const students = await rows(() => db.from('profiles').select('user_id,full_name,username')
        .eq('client_id', CLIENT).eq('role', 'student').eq('school', ONLINE).eq('level', body.level).order('user_id'));
      const marks = [];
      for (let i = 0; i < students.length; i += 100) {
        const ids = students.slice(i, i + 100).map(s => s.user_id);
        marks.push(...await rows(() => db.from('marks').select('id,user_id,exam,score,total,created_at')
          .eq('client_id', CLIENT).in('user_id', ids).order('id')));
      }
      return json(res, 200, { students, marks });
    }
    if (!['list', 'open', 'prepare', 'remove'].includes(body.action)) fail(400, 'Unknown exam-script action.');
    if (!UUID.test(String(body.mark_id || ''))) fail(400, 'Choose a saved exam mark first.');
    const markResult = await db.from('marks').select('id,user_id,exam')
      .eq('client_id', CLIENT).eq('id', body.mark_id).maybeSingle();
    if (markResult.error) throw markResult.error;
    const mark = markResult.data;
    if (!mark || (!staff && mark.user_id !== uid)) fail(404, 'This exam mark is not available to your account.');
    const targetResult = await db.from('profiles').select('school,role,full_name')
      .eq('client_id', CLIENT).eq('user_id', mark.user_id).maybeSingle();
    if (targetResult.error) throw targetResult.error;
    const target = targetResult.data;
    if (!target || target.role !== 'student' || (staff && !allowed(target.school))) fail(403, 'You do not have access to this student.');
    const canUpload = staff && target.school === ONLINE;
    const folder = `${CLIENT}/${mark.user_id}/${mark.id}`;
    const storage = db.storage.from(BUCKET);
    if (body.action === 'list') {
      const files = [];
      for (let offset = 0; ; offset += 100) {
        const result = await storage.list(folder, { limit: 100, offset, sortBy: { column: 'name', order: 'asc' } });
        if (result.error) throw result.error;
        for (const f of result.data || []) {
          if (f.id && /^[0-9a-f-]{36}--/.test(f.name)) files.push({ key: f.name,
            name: f.name.slice(38), size: Number(f.metadata && f.metadata.size) || 0, created_at: f.created_at });
        }
        if (!result.data || result.data.length < 100) break;
      }
      files.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.key.localeCompare(b.key));
      return json(res, 200, { files, can_upload: canUpload, exam: mark.exam, student: target.full_name });
    }
    if (body.action === 'prepare') {
      if (!canUpload) fail(403, 'Only authorized staff can upload exam scripts for Online Group.');
      const name = typeof body.name === 'string' ? body.name : '';
      const ext = name.split('.').pop().toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(TYPES, ext) || (body.type && body.type !== TYPES[ext])) fail(400, 'Choose a PDF or a JPG, PNG, WebP, GIF, HEIC or HEIF picture.');
      if (!Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_SIZE) fail(400, 'Each file must be non-empty and no larger than 25 MB.');
      const stem = name.slice(0, -(ext.length + 1)).normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100) || 'exam-script';
      const path = `${folder}/${randomUUID()}--${stem}.${ext}`;
      const result = await storage.createSignedUploadUrl(path, { upsert: false });
      if (result.error) throw result.error;
      return json(res, 200, { path, signed_url: result.data.signedUrl, content_type: TYPES[ext] });
    }
    // Never accept a caller-supplied folder or allow traversal/cross-student paths.
    const file = typeof body.file === 'string' ? body.file : '';
    if (!/^[0-9a-f-]{36}--[a-zA-Z0-9_-]+\.(pdf|jpg|jpeg|png|webp|gif|heic|heif)$/.test(file)) fail(400, 'Choose a valid script file.');
    const path = `${folder}/${file}`;
    if (body.action === 'open') {
      const result = await storage.createSignedUrl(path, 600);
      if (result.error) throw result.error;
      return json(res, 200, { url: result.data.signedUrl });
    }
    if (!canUpload) fail(403, 'Only authorized staff can remove Online Group exam scripts.');
    const result = await storage.remove([path]);
    if (result.error) throw result.error;
    return json(res, 200, { ok: true });
  } catch (error) {
    // Never return credentials, upload tokens or internal database error details.
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 499 ? error.status : 503;
    return json(res, status, { error: status === 503
      ? 'Exam scripts could not be loaded or saved. Please try again; if this continues, contact the admin.'
      : error.message });
  }
};
