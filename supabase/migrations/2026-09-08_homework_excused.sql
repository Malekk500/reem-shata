-- Homework: a fourth outcome, "Excused" (+ an optional reason).
-- Purely additive: two nullable columns, and one CHECK widened to accept a new value.
-- No existing row is read, rewritten or reinterpreted; every current status keeps its meaning.
-- NOTE: homework-excused lives in homework_results / homework_reviews. It is NOT attendance,
-- so it never appears in the Excused (attendance) panel.

alter table public.homework_results add column if not exists reason text;
alter table public.homework_reviews add column if not exists reason text;

alter table public.homework_reviews drop constraint if exists homework_reviews_status_check;
alter table public.homework_reviews add constraint homework_reviews_status_check
  check (status = any (array['submitted','incomplete','missing','excused']));
