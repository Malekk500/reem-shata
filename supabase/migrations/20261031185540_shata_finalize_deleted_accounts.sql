-- Definition only: does not execute finalization or change student records.
create or replace function public.shata_finalize_reopened_homework(
  p_hw_id uuid, p_results jsonb, p_actor uuid
) returns jsonb language plpgsql security invoker set search_path = ''
as $fn$
declare
  v_hw public.homework;
  v_link public.shata_homework_reopen_links;
  v_role text;
  v_scope jsonb;
  v_record public.homework_results;
  v_decision jsonb;
  v_item jsonb;
  v_required uuid[];
  v_original uuid[];
  v_count integer;
begin
  select role into v_role from public.profiles where client_id='shata' and user_id=p_actor;
  if v_role is null or v_role not in ('admin','assist') then raise exception 'Staff role required.'; end if;
  select * into v_link from public.shata_homework_reopen_links where homework_id=p_hw_id for update;
  if not found then raise exception 'This is not a reopened homework.'; end if;
  if v_link.completed_at is not null then
    return jsonb_build_object('ok',true,'finalized',true,'homework_id',p_hw_id,'recovered',true,'count',cardinality(v_link.source_ids));
  end if;
  select * into v_hw from public.homework where id=p_hw_id and client_id='shata' for update;
  if not found then raise exception 'This homework is no longer assigned. Refresh Homework.'; end if;
  if v_role<>'admin' then
    select value->p_actor::text into v_scope from public.settings where client_id='shata' and key='assist_schools';
    if jsonb_typeof(v_scope)='array' and jsonb_array_length(v_scope)>0
       and not(v_scope ? v_hw.school) then raise exception 'You do not have access to this class.'; end if;
  end if;
  if jsonb_typeof(p_results) is distinct from 'array' then raise exception 'Invalid review decisions.'; end if;
  if jsonb_array_length(p_results)<1 or jsonb_array_length(p_results)>5000 then raise exception 'Review every student first.'; end if;
  for v_item in select value from jsonb_array_elements(p_results) loop
    if nullif(v_item->>'user_id','') is null
       or (v_item->>'status') is null or (v_item->>'status') not in ('submitted','incomplete','missing','excused') then
      raise exception 'Invalid review decisions.';
    end if;
  end loop;
  if (select count(distinct value->>'user_id') from jsonb_array_elements(p_results))<>jsonb_array_length(p_results) then
    raise exception 'Duplicate student decisions.';
  end if;
  select array_agg(distinct uid) into v_required from (
    select user_id as uid from public.profiles where client_id='shata' and role='student' and school=v_hw.school and level=v_hw.level
    union select user_id from public.homework_submissions where client_id='shata' and homework_id=p_hw_id
  ) required;
  if v_required is null or exists(select 1 from unnest(v_required) uid where not exists(
      select 1 from jsonb_array_elements(p_results) e where (e->>'user_id')::uuid=uid)) then
    raise exception 'Some students still need a result. Refresh the review and mark everyone.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_results) e where not((e->>'user_id')::uuid=any(v_required))) then
    raise exception 'The class changed. Refresh the review before finalizing.';
  end if;
  perform id from public.homework_results where client_id='shata' and id=any(v_link.source_ids) order by id for update;
  -- Account deletion cascades to results. Missing source rows must not block the
  -- remaining class: surviving history is updated, and every required student
  -- still needs an explicit decision above before a result can be inserted.
  if exists(select 1 from public.homework_results where client_id='shata'
      and homework_title=v_hw.title and school=v_hw.school and level=v_hw.level
      and due is not distinct from v_hw.due and not(id=any(v_link.source_ids))) then
    raise exception 'Another finalized homework has this name and deadline. The admin must edit the deadline first.';
  end if;
  select coalesce(array_agg(user_id),array[]::uuid[]) into v_original from public.homework_results where client_id='shata' and id=any(v_link.source_ids);
  for v_record in select * from public.homework_results where client_id='shata' and id=any(v_link.source_ids) loop
    select value into v_decision from jsonb_array_elements(p_results) where (value->>'user_id')::uuid=v_record.user_id;
    update public.homework_results set homework_title=v_hw.title,school=v_hw.school,level=v_hw.level,due=v_hw.due,
      status=coalesce(v_decision->>'status',v_record.status),
      reason=case when v_decision is null then v_record.reason when v_decision->>'status'='excused'
        then nullif(left(trim(v_decision->>'reason'),300),'') else null end,
      finalized_at=now()
      where id=v_record.id and client_id='shata';
  end loop;
  insert into public.homework_results(id,client_id,user_id,homework_title,school,level,due,status,reason,finalized_at)
    select gen_random_uuid(),'shata',(e->>'user_id')::uuid,v_hw.title,v_hw.school,v_hw.level,v_hw.due,
      e->>'status',case when e->>'status'='excused' then nullif(left(trim(e->>'reason'),300),'') else null end,now()
    from jsonb_array_elements(p_results) e where not((e->>'user_id')::uuid=any(v_original));
  v_count := cardinality(v_original)+(select count(*) from jsonb_array_elements(p_results) e where not((e->>'user_id')::uuid=any(v_original)));
  update public.shata_homework_reopen_links set completed_at=now() where homework_id=p_hw_id;
  insert into public.activity_log(client_id,user_id,action,detail) values('shata',p_actor,'Finalized reopened homework',
    jsonb_build_object('role',v_role,'target',v_hw.title,'homework_id',p_hw_id,'homework',to_jsonb(v_hw),
      'summary',v_count::text||' results saved; original history updated without double counting'));
  delete from public.homework where client_id='shata' and id=p_hw_id;
  return jsonb_build_object('ok',true,'finalized',true,'homework_id',p_hw_id,'count',v_count,'recovered',false);
end;
$fn$;
revoke all on function public.shata_finalize_reopened_homework(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.shata_finalize_reopened_homework(uuid,jsonb,uuid) to service_role;
