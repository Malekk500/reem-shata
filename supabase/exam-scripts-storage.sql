-- Private storage only; no existing marks, homework, profiles or policies are changed.
-- Access is mediated by api/exam-scripts.js with tenant, role, school and ownership checks.
-- Do not add authenticated/anon storage.objects grants for this bucket.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shata-exam-scripts', 'shata-exam-scripts', false, 26214400,
  array['application/pdf','image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif'])
on conflict (id) do nothing;
