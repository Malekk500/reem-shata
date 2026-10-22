-- ============================================================================
--  Homework: exact deadlines (date + time) enforced in the database, and
--  provisional review decisions ("Save") kept separately from final results.
--
--  SAFETY: purely additive.
--   • ONE nullable column on homework. Existing rows stay NULL = date-only, so
--     nothing changes for homework that already exists (no cut-off, no time).
--   • ONE trigger that only acts when due_at IS NOT NULL — i.e. only on
--     homework created after this, by the new form.
--   • ONE new table. No existing table, row, file or status is modified.
-- ============================================================================

-- 1) exact deadline for FUTURE homework
alter table public.homework add column if not exists due_at timestamptz;
comment on column public.homework.due_at is
  'Exact submission deadline (date + time). NULL = legacy date-only homework, never enforced.';

-- 2) server-side gate: a submission cannot be created or changed after the deadline.
--    Runs inside the database, so it holds even if the page is bypassed and the API is
--    called directly. Staff never write to homework_submissions, so only students hit it.
create or replace function public.hw_submission_deadline_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare d timestamptz;
begin
  select due_at into d from public.homework where id = new.homework_id;
  if d is not null and now() > d then
    raise exception 'DEADLINE_PASSED: submissions for this homework closed at %', d
      using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists hw_submission_deadline on public.homework_submissions;
create trigger hw_submission_deadline
  before insert or update on public.homework_submissions
  for each row execute function public.hw_submission_deadline_guard();

-- 3) "Save" — the assistant's decisions-in-progress. Separate from homework_results (the
--    permanent record written only by Finalize) and from homework_submissions (the
--    student's upload, never touched). Rows vanish with the homework when it is finalized.
create table if not exists public.homework_reviews (
  client_id   text not null references public.clients(client_id),
  homework_id uuid not null references public.homework(id) on delete cascade,
  user_id     uuid not null,
  status      text not null check (status in ('submitted','incomplete','missing')),
  reviewed_by uuid,
  updated_at  timestamptz not null default now(),
  primary key (client_id, homework_id, user_id)
);
alter table public.homework_reviews enable row level security;
drop policy if exists hwrev_staff on public.homework_reviews;
create policy hwrev_staff on public.homework_reviews
  for all to authenticated
  using (client_id = my_client_id() and is_my_staff())
  with check (client_id = my_client_id() and is_my_staff());
