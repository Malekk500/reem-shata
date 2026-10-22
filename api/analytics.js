// POST /api/analytics  — ADMIN only (Eng Reem's own dashboard at /malek).
//
// Every figure on that page is computed HERE, with the service role, and handed back as
// finished JSON. Two reasons it lives on the server rather than in the browser:
//   1. Access. The page holds no report of its own — an anonymous visitor who opens /malek,
//      or pokes at it in devtools, gets a login box and nothing else, because the numbers
//      only exist after this endpoint has checked the caller is an admin of this tenant.
//   2. Accuracy. The service role sees every row, so nothing is quietly trimmed by a policy.
//
//   { month: 'YYYY-MM' | 'all' } -> { range, accounts, active, byDay, busiest, platforms,
//                                     homework, upload, attendance, marks, recordings,
//                                     staff, ai, signIns, errors }
const { SITE_CLIENT_ID, setCors, json, bunnyEnv, parseBody, requireRole } = require('../lib/bunny.js');
const { homeworkAssignments, attendanceRegisters } = require('../lib/analytics-counts.js');

// Bunny counts watch time itself, for the whole life of every video. That is a real measured
// number rather than a guess, and it exists for recordings uploaded long before this site
// started measuring anything — so it is the source for hosted recordings. Anything not on
// Bunny (a Drive file, a plain link) falls back to the site's own tracking.
async function bunnyWatch(libraryId, apiKey) {
  const by = {};
  if (!libraryId || !apiKey) return { by, ok: false };
  try {
    for (let page = 1; page <= 10; page++) {
      const r = await fetch('https://video.bunnycdn.com/library/' + libraryId + '/videos?page=' + page + '&itemsPerPage=100&orderBy=date',
        { headers: { AccessKey: apiKey, accept: 'application/json' } });
      if (!r.ok) return { by, ok: false };
      const j = await r.json().catch(() => ({}));
      const items = (j && j.items) || [];
      for (const it of items) {
        by[String(it.guid)] = { seconds: Number(it.totalWatchTime) || 0, views: Number(it.views) || 0, length: Number(it.length) || 0 };
      }
      if (items.length < 100) break;
    }
    return { by, ok: true };
  } catch (_) { return { by, ok: false }; }
}

module.exports = async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });

  const { libraryId, apiKey, supabaseUrl, serviceKey } = bunnyEnv();
  if (!supabaseUrl || !serviceKey) return json(res, 500, { error: 'Server misconfigured' });

  try { await requireRole(req, ['admin']); }
  catch (e) { return json(res, e.status || 403, { error: e.error || 'Not allowed' }); }

  const body = parseBody(req);
  const month = String(body.month || 'all').trim();
  const allTime = (month === 'all');
  let from = null, to = null, label = 'All time';
  if (!allTime) {
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) return json(res, 400, { error: 'Bad month' });
    const y = Number(m[1]), mo = Number(m[2]);
    if (mo < 1 || mo > 12) return json(res, 400, { error: 'Bad month' });
    from = new Date(Date.UTC(y, mo - 1, 1));
    to = new Date(Date.UTC(y, mo, 1));
    label = from.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  const svc = { apikey: serviceKey, Authorization: 'Bearer ' + serviceKey };
  const failed = [];

  // Every row, paging past PostgREST's 1000-row cap. `tsCol` narrows to the chosen month;
  // on "All time" nothing is narrowed at all.
  async function pageAll(table, cols, tsCol, extra = '', failureKey = table) {
    const out = [];
    const range = (!allTime && tsCol)
      ? '&' + tsCol + '=gte.' + from.toISOString() + '&' + tsCol + '=lt.' + to.toISOString()
      : '';
    for (let page = 0; page < 60; page++) {
      const url = supabaseUrl + '/rest/v1/' + table + '?client_id=eq.' + SITE_CLIENT_ID +
        '&select=' + encodeURIComponent(cols) + range + extra + '&limit=1000&offset=' + (page * 1000);
      let r;
      try { r = await fetch(url, { headers: svc }); } catch (_) { failed.push(failureKey); return out; }
      if (!r.ok) { failed.push(failureKey); return out; }
      const rows = await r.json().catch(() => null);
      if (!Array.isArray(rows)) { failed.push(failureKey); return out; }
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
    // A safety limit must surface as incomplete, never as a successful lower total.
    failed.push(failureKey);
    return out;
  }

  const [profs, logs, subs, hws, allResults, att, marks, vids, recordingRequests, sessions, ai, metrics, teachingEvents] = await Promise.all([
    pageAll('profiles', 'user_id,role,created_at'),
    pageAll('activity_log', 'user_id,action,detail,created_at', 'created_at'),
    pageAll('homework_submissions', 'homework_id,user_id,photos,created_at', 'created_at'),
    pageAll('homework', 'id,title,school,level,created_at,due', null, '&order=id.asc'),
    // Keep all history for assignment identity/creation-month accounting. Student
    // result metrics below still use the selected finalization month.
    pageAll('homework_results', 'id,user_id,status,homework_title,school,level,due,finalized_at', null, '&order=id.asc'),
    // Attendance is reported by the LESSON's date, not by when the sheet happened to be
    // saved: a register filled in later still belongs to the day it was taken.
    pageAll('attendance', 'id,user_id,date,status,note', 'date', '&order=id.asc'),
    pageAll('marks', 'user_id,exam,score,total,created_at', 'created_at'),
    pageAll('videos', 'id,title,kind,track,level,created_at'),
    pageAll('recording_requests', 'user_id,video_id,status,decided_at', 'decided_at'),
    pageAll('device_sessions', 'user_id,user_agent,last_seen'),
    pageAll('ai_usage', 'user_id,created_at', 'created_at'),
    pageAll('site_metrics', 'kind,name,ms,role,meta,created_at', 'created_at'),
    // Unfiltered by save time: backdated registers and homework finalized in a
    // later month still need their original class and assignment creation date.
    pageAll('activity_log', 'id,action,detail,created_at', null,
      '&action=' + encodeURIComponent('in.("Assigned homework","Finalized homework","Saved attendance")') + '&order=created_at.asc,id.asc',
      'teaching_history'),
  ]);
  const results = allTime ? allResults : allResults.filter(r => inRange(r.finalized_at));
  // The private ref is what ties a recording's per-school rows together.
  const refs = await pageAll('recording_urls', 'video_id,url');
  const bunny = await bunnyWatch(libraryId, apiKey);

  const dayKey = (iso) => String(iso || '').slice(0, 10);
  const roleOf = {}; profs.forEach(p => { roleOf[p.user_id] = p.role; });
  const students = profs.filter(p => p.role === 'student').length;
  const staffN = profs.filter(p => p.role === 'admin' || p.role === 'assist').length;
  const accounts = profs.length;
  const share = (n) => accounts ? Math.round(100 * n / accounts) : 0;

  // ---- who is actually using it. Sign-in events are recorded for everyone, students included.
  const signIns = logs.filter(r => r.action === 'Signed in');
  const byDay = {};
  signIns.forEach(r => { (byDay[dayKey(r.created_at)] = byDay[dayKey(r.created_at)] || new Set()).add(r.user_id); });
  const byDayCount = {}; Object.keys(byDay).forEach(k => { byDayCount[k] = byDay[k].size; });

  // "Last 7 days" always means the last 7 days from now — never the first week of whichever
  // month is on screen, which is what a month-scoped figure would quietly give you.
  const weekAgo = Date.now() - 7 * 86400000;
  const last7 = new Set(signIns.filter(r => new Date(r.created_at).getTime() > weekAgo).map(r => r.user_id)).size;
  const activeRange = new Set(signIns.map(r => r.user_id)).size;
  const peak = Object.entries(byDayCount).sort((a, b) => b[1] - a[1])[0];
  const busiest = peak ? { day: peak[0], n: peak[1] } : null;

  // ---- what people open the site on (the device label kept for the 2-device rule).
  const platBy = {};
  sessions.forEach(s => {
    const lab = String(s.user_agent || '');
    const os = / on (.+)$/.exec(lab);
    const name = os ? os[1].trim() : (lab || 'Unknown');
    (platBy[name] = platBy[name] || new Set()).add(s.user_id);
  });
  const platforms = Object.entries(platBy)
    .map(([name, set]) => ({ name, users: set.size, pct: share(set.size) }))
    .sort((a, b) => b.users - a.users);

  // ---- how long the site takes to accept an upload, and how much it carried. These upload
  // events are the ONE permanent record of what students sent: one row per upload, with the
  // number of files, whether or not the homework has since been finalized.
  const upl = metrics.filter(m => m.kind === 'perf' && m.name === 'homework_submit' && m.ms >= 0);
  const ms = upl.map(m => m.ms).sort((a, b) => a - b);
  const pick = (q) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] : null;
  const upload = {
    count: ms.length,
    avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
    medMs: pick(0.5), p95Ms: pick(0.95),
    fastestMs: ms.length ? ms[0] : null,
    slowestMs: ms.length ? ms[ms.length - 1] : null,
    files: upl.reduce((a, m) => a + ((m.meta && m.meta.files) || 0), 0),
    mb: upl.reduce((a, m) => a + ((m.meta && m.meta.bytes) || 0), 0) / 1048576,
  };

  // ---- homework. Submissions are THROWN AWAY once a homework is finalized: the photos are
  // deleted and the row goes with the homework. So `homework_submissions` only ever holds what
  // is awaiting review right now — never the month's total. The month's hand-ins are the
  // finalized results marked Complete or Incomplete plus whatever is still open, and the
  // month's photos are the files carried by the upload events above.
  const assignmentCounts = homeworkAssignments(hws, allResults, teachingEvents, month);
  const homeworkAvailable = !failed.includes('homework') && !failed.includes('homework_results');
  const homeworkDatesAvailable = !failed.includes('teaching_history');
  const tally = { submitted: 0, incomplete: 0, missing: 0, excused: 0 };
  results.forEach(r => { if (tally[r.status] != null) tally[r.status]++; });
  const handedIn = results.filter(r => r.status === 'submitted' || r.status === 'incomplete');
  // Excused homework sits outside the rate entirely, exactly as it does for the student.
  const counted = tally.submitted + tally.incomplete + tally.missing;
  const homework = {
    set: homeworkAvailable && (allTime || homeworkDatesAvailable) ? assignmentCounts.set : null,
    activeAssignments: homeworkAvailable ? assignmentCounts.active : null,
    historicalAssignments: homeworkAvailable ? assignmentCounts.historical : null,
    undatedAssignments: assignmentCounts.undated,
    submissions: handedIn.length + subs.length,
    awaitingReview: subs.length,
    photos: upload.files,
    studentsSubmitted: new Set(handedIn.map(r => r.user_id).concat(subs.map(s => s.user_id))).size,
    finalized: results.length,
    complete: tally.submitted, incomplete: tally.incomplete,
    missing: tally.missing, excused: tally.excused,
    completionRate: counted ? Math.round(100 * (tally.submitted + tally.incomplete) / counted) : null,
  };

  // ---- attendance. Class/day identity comes from the original save, not current
  // profiles (students move class) or title alone (groups share lesson names).
  const registerCounts = attendanceRegisters(att, teachingEvents);
  const aT = {}; att.forEach(a => { aT[a.status] = (aT[a.status] || 0) + 1; });
  const attCounted = att.length - (aT.excused || 0);
  const attendance = {
    registers: !failed.includes('attendance') && !failed.includes('teaching_history') ? registerCounts.registers : null,
    unattributedSheets: registerCounts.unattributed,
    records: failed.includes('attendance') ? null : att.length,
    present: aT.present || 0, late: aT.late || 0, absent: aT.absent || 0, excused: aT.excused || 0,
    ratePct: attCounted ? Math.round(100 * ((aT.present || 0) + (aT.late || 0)) / attCounted) : null,
  };

  // ---- marks
  const marksOut = {
    records: marks.length,
    exams: new Set(marks.map(m => m.exam)).size,
    students: new Set(marks.map(m => m.user_id)).size,
    avgPct: marks.length
      ? Math.round(marks.reduce((a, m) => a + (m.total ? 100 * Number(m.score) / Number(m.total) : 0), 0) / marks.length)
      : null,
  };

  // ---- recordings. ONE uploaded lesson serves several schools, and each school gets its
  // own metadata row — so counting rows would report the same lesson three times over, in the
  // list, in the totals, and in the Espresso count. Everything below groups by the underlying
  // file first, and only then counts.
  const vidById = {}; vids.forEach(v => { vidById[v.id] = v; });
  const refOf = {}; refs.forEach(r => { refOf[r.video_id] = r.url; });
  // Rows with no ref of their own can only stand alone; key them by their own id.
  const groupKey = (id) => refOf[id] || ('id:' + id);
  const groups = {};
  vids.forEach(v => {
    const k = groupKey(v.id);
    const g = groups[k] || (groups[k] = { key: k, ref: refOf[v.id] || '', ids: [], title: v.title, espresso: false, schools: [] });
    g.ids.push(v.id);
    if (String(v.kind || '') === 'espresso') g.espresso = true;
    if (v.track && g.schools.indexOf(v.track) < 0) g.schools.push(v.track);
    if (!g.title) g.title = v.title;
  });
  // Count approved requests, not playback opens. The request table holds the latest
  // decision per student/video; this is not a historical count of every re-approval.
  // A monthly report uses the decision date, not the original request date. Approved
  // rows remain counted after their 72-hour playback access expires.
  const approvedRequests = recordingRequests.filter(r => r.status === 'approved' && r.decided_at);
  const approvalsAvailable = !failed.includes('recording_requests');
  approvedRequests.forEach(r => {
    const k = groupKey(r.video_id);
    if (!groups[k]) groups[k] = { key: k, ref: refOf[r.video_id] || '', ids: [r.video_id], title: 'Recording (deleted)', espresso: false, schools: [] };
    else if (groups[k].ids.indexOf(r.video_id) < 0) groups[k].ids.push(r.video_id);
  });

  const approvedBy = {};
  approvedRequests.forEach(r => { const k = groupKey(r.video_id); approvedBy[k] = (approvedBy[k] || 0) + 1; });
  // The site's own watch tracking, for recordings Bunny does not host.
  const ownMs = {};
  metrics.filter(m => m.kind === 'watch' && m.ms > 0).forEach(m => {
    const k = groupKey(m.name);
    ownMs[k] = (ownMs[k] || 0) + m.ms;
  });

  let msFull = 0, msEsp = 0;
  const perVideo = Object.values(groups).map(g => {
    const guid = g.ref.startsWith('bunny:') ? g.ref.slice(6) : '';
    const b = guid ? bunny.by[guid] : null;
    // Bunny's figure covers the recording's whole life; the site's own covers this period.
    const seconds = b ? b.seconds : ((ownMs[g.key] || 0) / 1000);
    if (g.espresso) msEsp += seconds * 1000; else msFull += seconds * 1000;
    return {
      title: g.title || 'Recording',
      espresso: g.espresso,
      schools: g.schools.length,
      approved: approvalsAvailable ? (approvedBy[g.key] || 0) : null,
      minutes: Math.round(seconds / 60),
    };
  }).sort((a, b) => ((b.approved || 0) - (a.approved || 0)) || (b.minutes - a.minutes));

  const recordings = {
    available: Object.values(groups).filter(g => g.ids.some(id => vidById[id])).length,
    espressoAvailable: Object.values(groups).filter(g => g.espresso && g.ids.some(id => vidById[id])).length,
    approved: approvalsAvailable ? approvedRequests.length : null,
    minutes: Math.round((msFull + msEsp) / 60000),
    minutesFull: Math.round(msFull / 60000),
    minutesEspresso: Math.round(msEsp / 60000),
    watchSource: bunny.ok ? 'library' : 'site',
    lifetimeWatch: bunny.ok,
    top: perVideo.slice(0, 8),
  };

  // ---- staff changes (everything in the log that isn't a sign-in)
  const acts = logs.filter(r => r.action !== 'Signed in');
  const actBy = {};
  acts.forEach(r => { const u = (r.detail && r.detail.username) || 'system'; actBy[u] = (actBy[u] || 0) + 1; });

  return json(res, 200, {
    range: { month: allTime ? 'all' : month, label, allTime,
             from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    accounts: { total: accounts, students, staff: staffN },
    active: { last7, last7Pct: share(last7), range: activeRange, rangePct: share(activeRange) },
    byDay: byDayCount,
    busiest,
    platforms,
    homework,
    upload,
    attendance,
    marks: marksOut,
    recordings,
    staff: { total: acts.length, top: Object.entries(actBy).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([username, n]) => ({ username, n })) },
    ai: { questions: ai.length },
    signIns: signIns.length,
    errors: [...new Set(failed)],
    generatedAt: new Date().toISOString(),
  });

  function inRange(iso) {
    const t = new Date(iso).getTime();
    return t >= from.getTime() && t < to.getTime();
  }
};
