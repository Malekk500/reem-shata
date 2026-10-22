// Count retained teaching records, not student rows or today's class membership.
// Legacy homework history has no assignment ID/creation date; its database identity
// is title + school + level + due. Do not count a partial finalization twice.
const hwKey = h => JSON.stringify([h.title || '', h.school || '', h.level || '', h.due || null]);
const targetOf = h => `${h.title} (${h.school} · ${h.level})`;

function homeworkAssignments(active, results, events, month) {
  const assignments = new Map();
  for (const r of results) {
    const h = { title: r.homework_title, school: r.school, level: r.level, due: r.due };
    const key = hwKey(h);
    if (!assignments.has(key)) assignments.set(key, { ...h, finalized_at: r.finalized_at });
    else if (r.finalized_at < assignments.get(key).finalized_at) assignments.get(key).finalized_at = r.finalized_at;
  }
  for (const h of active) assignments.set(hwKey(h), { ...h, active: true });

  const structured = new Map(), legacy = new Map(), targetKeys = new Map();
  for (const [key, h] of assignments) {
    const target = targetOf(h);
    if (!targetKeys.has(target)) targetKeys.set(target, new Set());
    targetKeys.get(target).add(key);
  }
  for (const e of events) {
    const d = e.detail || {}, h = d.homework;
    if (h && h.created_at && h.title && h.school && h.level) {
      const key = hwKey(h);
      if (!structured.has(key)) structured.set(key, new Set());
      structured.get(key).add(h.created_at);
    } else if (e.action === 'Assigned homework' && d.target && e.created_at) {
      if (!legacy.has(d.target)) legacy.set(d.target, new Set());
      legacy.get(d.target).add(e.created_at);
    }
  }
  let count = 0, undated = 0;
  for (const [key, h] of assignments) {
    let created = h.created_at;
    if (!created && structured.get(key)?.size === 1) created = [...structured.get(key)][0];
    // Never guess between reused titles/due dates or repeated assignment events.
    const target = targetOf(h), dates = legacy.get(target);
    if (!created && targetKeys.get(target).size === 1 && dates?.size === 1) {
      const candidate = [...dates][0];
      if (!h.finalized_at || Date.parse(candidate) <= Date.parse(h.finalized_at)) created = candidate;
    }
    if (!created || !Number.isFinite(Date.parse(created))) undated++;
    else if (new Date(created).toISOString().slice(0, 7) === month) count++;
  }
  return {
    // Unknown creation dates must not silently become a lower monthly total.
    set: month === 'all' ? assignments.size : (undated ? null : count),
    undated,
    active: [...assignments.values()].filter(h => h.active).length,
    historical: [...assignments.values()].filter(h => !h.active).length,
  };
}

function attendanceRegisters(rows, events) {
  const sheets = new Map(), covered = new Set(), registers = new Set();
  const sheetKey = (date, lesson) => JSON.stringify([date, lesson]);
  for (const r of rows) {
    const key = sheetKey(r.date, String(r.note || '').split('\n')[0]);
    if (!sheets.has(key)) sheets.set(key, new Set());
    sheets.get(key).add(r.user_id);
  }
  for (const e of events) {
    if (e.action !== 'Saved attendance') continue;
    const d = e.detail || {};
    let reg = d.attendance_register;
    if (!reg) {
      const m = /^(.*) \((.*) · (.*)\) on (\d{4}-\d{2}-\d{2})$/.exec(String(d.target || ''));
      if (!m) continue;
      reg = { lesson: m[1], school: m[2], level: m[3], date: m[4] };
    }
    if (!reg.school || !reg.level || !reg.date) continue;
    const key = sheetKey(reg.date, reg.lesson || ''), students = sheets.get(key);
    // Exclude obsolete/test/deleted sheets with no remaining attendance rows.
    if (!students) continue;
    if (Array.isArray(reg.user_ids) && !reg.user_ids.some(id => students.has(id))) continue;
    covered.add(key);
    // One register per class/day: the database permits one mark per student/day.
    // Re-saving or renaming a lesson is not another register. Guest students and
    // later class moves never create additional registers.
    registers.add(JSON.stringify([reg.date, reg.school, reg.level]));
  }
  const unattributed = [...sheets.keys()].filter(key => !covered.has(key)).length;
  return { registers: unattributed ? null : registers.size, unattributed };
}

module.exports = { homeworkAssignments, attendanceRegisters };
