-- Definitions only. No existing homework is reopened or finalized by this migration.
create table public.shata_homework_reopen_links (
  homework_id uuid primary key,
  source_key text not null,
  source_newest timestamptz not null,
  source_ids uuid[] not null,
  source_title text not null,
  source_school text not null,
  source_level text not null,
  source_due date,
  reopened_by uuid not null,
  reopened_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (source_key, source_newest)
);
alter table public.shata_homework_reopen_links enable row level security;
revoke all on public.shata_homework_reopen_links from public, anon, authenticated;
grant select, insert, update, delete on public.shata_homework_reopen_links to service_role;

create or replace function public.shata_reopen_homework(
  p_title text, p_school text, p_level text, p_old_due date,
  p_expected_newest timestamptz, p_due date, p_due_at timestamptz,
  p_description text, p_actor uuid
) returns jsonb language plpgsql security invoker set search_path = ''
as $fn$
declare
  v_key text;
  v_link public.shata_homework_reopen_links;
  v_hw public.homework;
  v_ids uuid[];
  v_newest timestamptz;
  v_id uuid;
begin
  if not exists(select 1 from public.profiles where client_id='shata' and user_id=p_actor and role='admin') then
    raise exception 'Only an admin can reopen homework.';
  end if;
  if nullif(trim(p_title),'') is null or nullif(trim(p_school),'') is null
     or nullif(trim(p_level),'') is null or p_expected_newest is null
     or p_due is null or p_due_at is null or p_due_at<=now()
     or p_description is null or length(p_description)>20000 then
    raise exception 'Choose a future deadline and valid homework details.';
  end if;
  v_key := md5(jsonb_build_array(p_title,p_school,p_level,p_old_due)::text);
  perform pg_advisory_xact_lock(hashtextextended('shata:reopen:'||v_key,0));
  select * into v_link from public.shata_homework_reopen_links
    where source_key=v_key and source_newest=p_expected_newest;
  if found then
    select * into v_hw from public.homework where client_id='shata' and id=v_link.homework_id;
    if found and v_link.completed_at is null then
      return jsonb_build_object('ok',true,'homework',to_jsonb(v_hw),'already_reopened',true);
    end if;
    raise exception 'This homework was already reopened and closed. Refresh History.';
  end if;
  perform id from public.homework_results
    where client_id='shata' and homework_title=p_title and school=p_school
      and level=p_level and due is not distinct from p_old_due
    order by id for update;
  select array_agg(id order by id), max(finalized_at) into v_ids,v_newest
    from public.homework_results where client_id='shata' and homework_title=p_title
      and school=p_school and level=p_level and due is not distinct from p_old_due;
  if v_ids is null or v_newest is distinct from p_expected_newest then
    raise exception 'The saved results changed. Refresh History before reopening.';
  end if;
  if exists(select 1 from public.homework where client_id='shata'
      and title=p_title and school=p_school and level=p_level) then
    raise exception 'Homework with this name is already assigned to this class. Open Assigned now.';
  end if;
  if exists(select 1 from public.shata_homework_reopen_links l
      join public.homework h on h.id=l.homework_id and h.client_id='shata'
      where l.source_key=v_key and l.completed_at is null) then
    raise exception 'This homework is already reopened. Open Assigned now.';
  end if;
  if exists(select 1 from public.homework_results where client_id='shata'
      and homework_title=p_title and school=p_school and level=p_level
      and due=p_due and not(id=any(v_ids))) then
    raise exception 'Another finalized homework has this name and deadline. Choose a different deadline.';
  end if;
  v_id := gen_random_uuid();
  insert into public.homework(id,client_id,title,description,school,level,due,due_at,expires_at)
    values(v_id,'shata',p_title,p_description,p_school,p_level,p_due,p_due_at,
      greatest(now()+interval '14 days',p_due_at+interval '14 days'))
    returning * into v_hw;
  insert into public.shata_homework_reopen_links
    (homework_id,source_key,source_newest,source_ids,source_title,source_school,source_level,source_due,reopened_by)
    values(v_id,v_key,v_newest,v_ids,p_title,p_school,p_level,p_old_due,p_actor);
  insert into public.homework_reviews(client_id,homework_id,user_id,status,reason,reviewed_by,updated_at)
    select 'shata',v_id,r.user_id,
      case when r.status='cancelled' then 'missing' else r.status end,
      r.reason,p_actor,now()
    from public.homework_results r
    join public.profiles p on p.user_id=r.user_id and p.client_id='shata'
    where r.id=any(v_ids) and r.client_id='shata'
      and r.status in ('submitted','incomplete','missing','excused','cancelled');
  insert into public.activity_log(client_id,user_id,action,detail)
    values('shata',p_actor,'Reopened finalized homework',
      jsonb_build_object('role','admin','target',p_title,'homework_id',v_id,
        'previous_due',p_old_due,'new_due',p_due,'new_due_at',p_due_at,
        'preserved_results',cardinality(v_ids),'homework',to_jsonb(v_hw)));
  return jsonb_build_object('ok',true,'homework',to_jsonb(v_hw),'preserved_results',cardinality(v_ids));
end;
$fn$;

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
  if (select count(*) from public.homework_results where client_id='shata' and id=any(v_link.source_ids))<>cardinality(v_link.source_ids) then
    raise exception 'Original history records were removed. Contact the admin before finalizing.';
  end if;
  if exists(select 1 from public.homework_results where client_id='shata'
      and homework_title=v_hw.title and school=v_hw.school and level=v_hw.level
      and due is not distinct from v_hw.due and not(id=any(v_link.source_ids))) then
    raise exception 'Another finalized homework has this name and deadline. The admin must edit the deadline first.';
  end if;
  select array_agg(user_id) into v_original from public.homework_results where client_id='shata' and id=any(v_link.source_ids);
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
  v_count := cardinality(v_link.source_ids)+(select count(*) from jsonb_array_elements(p_results) e where not((e->>'user_id')::uuid=any(v_original)));
  update public.shata_homework_reopen_links set completed_at=now() where homework_id=p_hw_id;
  insert into public.activity_log(client_id,user_id,action,detail) values('shata',p_actor,'Finalized reopened homework',
    jsonb_build_object('role',v_role,'target',v_hw.title,'homework_id',p_hw_id,'homework',to_jsonb(v_hw),
      'summary',v_count::text||' results saved; original history updated without double counting'));
  delete from public.homework where client_id='shata' and id=p_hw_id;
  return jsonb_build_object('ok',true,'finalized',true,'homework_id',p_hw_id,'count',v_count,'recovered',false);
end;
$fn$;
revoke all on function public.shata_reopen_homework(text,text,text,date,timestamptz,date,timestamptz,text,uuid) from public,anon,authenticated;
revoke all on function public.shata_finalize_reopened_homework(uuid,jsonb,uuid) from public,anon,authenticated;
grant execute on function public.shata_reopen_homework(text,text,text,date,timestamptz,date,timestamptz,text,uuid) to service_role;
grant execute on function public.shata_finalize_reopened_homework(uuid,jsonb,uuid) to service_role;
