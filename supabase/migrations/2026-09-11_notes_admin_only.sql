-- Notes are admin-only.
--
-- Everyone in the tenant keeps READING notes (students, assistants, admin) — nothing here
-- touches SELECT. What changes is who may add, change or remove them: the admin only.
--
-- These are RESTRICTIVE policies. They are ANDed with the existing staff-wide ones on
-- `materials` and on the `materials` bucket, and each predicate is true for everything that is
-- not a note — so other material kinds, other buckets and other folders behave exactly as
-- before. Only a write to kind = 'notes' (or to the <client>/notes/… folder) by a non-admin is
-- refused. Reversal is simply dropping the five policies.

-- ---- the rows students see
create policy materials_notes_admin_ins on public.materials
  as restrictive for insert
  with check (kind is distinct from 'notes' or public.my_role() = 'admin');

create policy materials_notes_admin_upd on public.materials
  as restrictive for update
  using (kind is distinct from 'notes' or public.my_role() = 'admin');

create policy materials_notes_admin_del on public.materials
  as restrictive for delete
  using (kind is distinct from 'notes' or public.my_role() = 'admin');

-- ---- the page images behind them: bucket `materials`, folder <client_id>/notes/<id>/…
create policy mat_obj_notes_admin_ins on storage.objects
  as restrictive for insert to authenticated
  with check (
    bucket_id <> 'materials'
    or (storage.foldername(name))[2] is distinct from 'notes'
    or public.my_role() = 'admin'
  );

create policy mat_obj_notes_admin_del on storage.objects
  as restrictive for delete to authenticated
  using (
    bucket_id <> 'materials'
    or (storage.foldername(name))[2] is distinct from 'notes'
    or public.my_role() = 'admin'
  );
