-- Definitions only: applying this migration does not alter attendance records.
-- Retain the existing tenant/staff policies. Add admin-only DELETE for Shata;
-- assistants can still insert and update, and other tenants are unchanged.
create policy shata_attendance_admin_delete
on public.attendance as restrictive
for delete to authenticated
using (client_id <> 'shata' or coalesce(public.my_role() = 'admin', false));

-- One atomic user-confirmed operation, run under the caller's existing RLS.
create or replace function public.shata_delete_attendance_register(
  p_date date,
  p_lesson text,
  p_expected_ids uuid[]
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_expected uuid[];
  v_deleted uuid[];
  v_username text;
  v_count integer;
begin
  if auth.uid() is null
     or public.my_client_id() is distinct from 'shata'
     or public.my_role() is distinct from 'admin' then
    raise exception using errcode = '42501',
      message = 'Only an admin can delete attendance.';
  end if;

  if p_date is null or p_lesson is null
     or p_expected_ids is null
     or cardinality(p_expected_ids) not between 1 and 10000
     or array_ndims(p_expected_ids) <> 1 then
    raise exception using errcode = '22023',
      message = 'Refresh History and select a complete attendance register.';
  end if;

  select array_agg(distinct id order by id) into v_expected
  from unnest(p_expected_ids) as expected(id)
  where id is not null;

  if cardinality(v_expected) is distinct from cardinality(p_expected_ids) then
    raise exception using errcode = '22023',
      message = 'The confirmed register contains invalid or duplicate records. Refresh History.';
  end if;

  -- Compare the actual full register, not an API-limited client result.
  -- Raising below rolls this entire operation back if membership changed.
  with removed as (
    delete from public.attendance
    where client_id = 'shata'
      and date = p_date
      and split_part(coalesce(note, ''), E'\n[excused] ', 1) = p_lesson
    returning id
  )
  select coalesce(array_agg(id order by id), '{}'::uuid[])
  into v_deleted from removed;

  if v_deleted is distinct from v_expected then
    raise exception using errcode = '40001',
      message = 'This register changed. Nothing was deleted. Refresh History and review it again.';
  end if;

  v_count := cardinality(v_deleted);
  select username into v_username from public.profiles
  where user_id = auth.uid() and client_id = 'shata';

  -- Audit and deletion commit together; no attendance backups are created.
  insert into public.activity_log (client_id, user_id, action, detail)
  values ('shata', auth.uid(), 'Deleted an attendance register',
    jsonb_build_object(
      'username', v_username,
      'role', 'admin',
      'target', coalesce(nullif(p_lesson, ''), 'Lesson') || ' — ' ||
        p_date::text || ' (' || v_count::text || ' record(s))',
      'date', p_date,
      'lesson', p_lesson,
      'deleted_count', v_count
    ));

  return v_count;
end;
$function$;

revoke all on function public.shata_delete_attendance_register(date, text, uuid[]) from public, anon;
grant execute on function public.shata_delete_attendance_register(date, text, uuid[]) to authenticated;
