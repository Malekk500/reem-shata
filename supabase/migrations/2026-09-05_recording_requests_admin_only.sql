-- Recording requests: approve/decline is the admin's decision (tenant 'shata' only).
-- rr_upd is shared by every tenant in this project, so the extra condition is scoped to
-- shata — other tenants keep their current staff-wide behaviour untouched.
drop policy if exists rr_upd on public.recording_requests;
create policy rr_upd on public.recording_requests
  for update to authenticated
  using (
    client_id = my_client_id() and is_my_staff()
    and (client_id <> 'shata' or exists (
      select 1 from public.profiles pr
      where pr.user_id = auth.uid() and pr.client_id = public.recording_requests.client_id
        and pr.role in ('admin','superadmin','super_admin')))
  )
  with check (
    client_id = my_client_id() and is_my_staff()
    and (client_id <> 'shata' or exists (
      select 1 from public.profiles pr
      where pr.user_id = auth.uid() and pr.client_id = public.recording_requests.client_id
        and pr.role in ('admin','superadmin','super_admin')))
  );
