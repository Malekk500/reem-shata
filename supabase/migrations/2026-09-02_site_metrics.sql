-- ============================================================================
--  site_metrics — the ONLY thing missing before the dashboard can honestly
--  report watch-time, page speed and error rate.
--
--  SAFETY: purely additive. Creates ONE new table. It does not alter, move or
--  read any existing table, and touches no student record. Dropping it later
--  would simply return those three panels to "not tracked".
-- ============================================================================

create table if not exists public.site_metrics (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null references public.clients(client_id),
  kind       text not null check (kind in ('perf','watch','error')),
  name       text,                 -- 'homework_load' | 'submit' | video id | route
  ms         integer,              -- how long it took / how long it played
  role       text,                 -- 'student' | 'assist' | 'admin'
  meta       jsonb,                -- e.g. { files: 3, bytes: 1840221 }
  created_at timestamptz not null default now()
);

-- one index per way the dashboard reads it
create index if not exists site_metrics_lookup
  on public.site_metrics (client_id, kind, created_at desc);

alter table public.site_metrics enable row level security;

-- Anyone signed in may record their OWN measurements for their own tenant.
-- (Same helper functions the existing device_sessions policies already use.)
drop policy if exists sm_ins on public.site_metrics;
create policy sm_ins on public.site_metrics
  for insert to authenticated
  with check (client_id = my_client_id());

-- Only the teacher/assistants can read them back.
drop policy if exists sm_sel on public.site_metrics;
create policy sm_sel on public.site_metrics
  for select to authenticated
  using (client_id = my_client_id() and is_my_staff());

-- Housekeeping: these rows are disposable. Keeping ~90 days is plenty for
-- monthly reporting. Run occasionally (or wire to pg_cron later):
--   delete from public.site_metrics where created_at < now() - interval '90 days';
