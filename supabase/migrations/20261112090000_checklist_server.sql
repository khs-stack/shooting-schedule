-- 2026-11-12 현장 체크리스트 서버 저장 + 완료 조건 서버 검증
-- 아직 운영 DB에 적용하지 않음. 적용 전 승인 필요.
--
-- 바뀌는 것
--   1) jobs.checklist (jsonb) 열 추가: {"checked": ["항목", ...], "at": 시각}
--   2) partner_check_save(token, job, checked[]) 새 함수: 파트너가 체크한 항목을 서버에 저장
--   3) partner_update_job: '완료'로 바꿀 때 필수 체크 항목이 다 체크됐는지 검사 (need_check)
--   4) partner_jobs: 응답에 checklist 추가
-- 필수 항목 = 관리자 설정 app_settings.partner_ui.checklists[시공|촬영] (없으면 기본 목록)
-- 끄기: app_settings.ops 에 "checklist_required": false
-- 기존 정산·금액·상태 데이터는 건드리지 않음. 이미 '완료'된 건에는 영향 없음.

alter table public.jobs add column if not exists checklist jsonb not null default '{}'::jsonb;

create or replace function private.checklist_on() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (value->>'checklist_required')::boolean from public.app_settings where key = 'ops' and value ? 'checklist_required'), true)
$$;

create or replace function private.checklist_required(p_part text) returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select array(select btrim(x) from jsonb_array_elements_text(value->'checklists'->p_part) x where btrim(x) <> '')
       from public.app_settings
      where key = 'partner_ui' and jsonb_typeof(value->'checklists'->p_part) = 'array' and jsonb_array_length(value->'checklists'->p_part) > 0),
    case p_part
      when '시공' then array['시공 일정·주소 재확인','장비·부품·공구 수량 확인','태블릿·충전기·거치대 준비','매장 전기·네트워크 환경 확인','설치 전 사진 촬영','기기 설치 및 배선 정리','통신·전원·메뉴판 동작 테스트','점주 최종 확인']
      when '촬영' then array['카메라 배터리 충전','메모리카드 여유 공간','조명·삼각대 장비 점검','매장·대표 메뉴 사전 확인','주방·홀 정리 상태 확인','메뉴별 촬영 완료','원본 백업 · 결과물 일정 안내','점주 최종 확인']
      else array[]::text[] end)
$$;

create or replace function private.checklist_missing(p_part text, p_ck jsonb) returns json language sql stable security definer set search_path = '' as $$
  select coalesce(json_agg(r.item), '[]'::json) from unnest(private.checklist_required(p_part)) r(item)
   where not (coalesce(p_ck->'checked', '[]'::jsonb) ? r.item)
$$;

revoke all on function private.checklist_on() from public, anon, authenticated;
revoke all on function private.checklist_required(text) from public, anon, authenticated;
revoke all on function private.checklist_missing(text, jsonb) from public, anon, authenticated;

create or replace function public.partner_check_save(p_token text, p_job uuid, p_checked text[]) returns json language plpgsql security definer set search_path = '' as $$
declare pid uuid := private.session_partner(p_token); j public.jobs; ck jsonb;
begin
  if pid is null then return json_build_object('ok', false, 'error', 'auth'); end if;
  select * into j from public.jobs where id = p_job and partner_id = pid and status <> '취소';
  if j.id is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if j.status = '완료' then return json_build_object('ok', false, 'error', 'locked'); end if;
  ck := jsonb_build_object('checked', coalesce((select jsonb_agg(distinct left(btrim(x), 200)) from unnest((coalesce(p_checked, array[]::text[]))[1:60]) x where btrim(x) <> ''), '[]'::jsonb), 'at', now());
  update public.jobs set checklist = ck where id = j.id;
  return json_build_object('ok', true, 'checklist', ck, 'missing', private.checklist_missing(j.part, ck));
end $$;
grant execute on function public.partner_check_save(text, uuid, text[]) to anon, authenticated;

create or replace function public.partner_update_job(p_token text, p_job uuid, p_visit_date date, p_visit_time text, p_status text, p_note text) returns json language plpgsql security definer set search_path = '' as $$
declare pid uuid := private.session_partner(p_token); j public.jobs;
begin
  if pid is null then return json_build_object('ok', false, 'error', 'auth'); end if;
  select * into j from public.jobs where id = p_job and partner_id = pid and status <> '취소';
  if j.id is null then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if p_status not in ('배정','일정확정','완료') then return json_build_object('ok', false, 'error', 'bad_status'); end if;
  if p_status = '완료' and j.status <> '완료' and (j.status <> '일정확정' or j.visit_date is null) then
    return json_build_object('ok', false, 'error', 'need_date'); end if;
  if p_status = '완료' and j.status <> '완료' and j.part = '시공' and not exists (select 1 from public.job_photos where job_id = j.id) then
    return json_build_object('ok', false, 'error', 'need_photo'); end if;
  if p_status = '완료' and j.status <> '완료' and private.checklist_on()
     and exists (select 1 from unnest(private.checklist_required(j.part)) r(item)
                 where not (coalesce(j.checklist->'checked', '[]'::jsonb) ? r.item)) then
    return json_build_object('ok', false, 'error', 'need_check', 'missing', private.checklist_missing(j.part, j.checklist)); end if;
  if p_status = '일정확정' and p_visit_date is null then return json_build_object('ok', false, 'error', 'need_date'); end if;
  if j.status = '완료' and p_status <> '완료' and (j.signed_at is not null or (j.settle_month is not null and private.settle_locked(pid, j.settle_month))) then
    return json_build_object('ok', false, 'error', 'locked'); end if;
  update public.jobs set
    visit_date = case when j.status = '완료' and p_status = '완료' then j.visit_date else p_visit_date end,
    visit_time = left(coalesce(p_visit_time, ''), 40),
    status = case when p_status = '배정' and p_visit_date is not null then '일정확정' else p_status end,
    partner_note = left(coalesce(p_note, ''), 2000),
    completed_at = case when p_status = '완료' then coalesce(j.completed_at, now()) else null end
  where id = j.id;
  return json_build_object('ok', true);
end $$;

create or replace function public.partner_jobs(p_token text) returns json language plpgsql stable security definer set search_path = '' as $$
declare pid uuid := private.session_partner(p_token);
begin
  if pid is null then return json_build_object('ok', false, 'error', 'auth'); end if;
  return json_build_object('ok', true,
    'me', (select json_build_object('name', name, 'parts', parts, 'settings', settings, 'home_address', home_address) from public.partners where id = pid),
    'jobs', coalesce((select json_agg(json_build_object(
      'id', j.id, 'part', j.part, 'store_name', j.store_name, 'store_address', j.store_address,
      'contact_name', j.contact_name, 'contact_phone', j.contact_phone, 'work_detail', j.work_detail,
      'special_notes', j.special_notes, 'install_env', j.install_env, 'install_items', j.install_items, 'store_phone', j.store_phone, 'biz_no', j.biz_no, 'cert', j.cert, 'checked_by', j.checked_by,
      'tablet_count', j.tablet_count, 'pos_type', j.pos_type, 'requested_date', j.requested_date,
      'visit_date', j.visit_date, 'visit_time', j.visit_time, 'status', j.status,
      'partner_note', j.partner_note, 'completed_at', j.completed_at,
      'sign_token', j.sign_token, 'signed', j.signed_at is not null, 'signed_at', j.signed_at, 'sign_name', j.sign_name,
      'work_type', j.work_type, 'qty', j.qty, 'base_fee', j.base_fee, 'extra_fee', j.extra_fee, 'extra_note', j.extra_note,
      'extra_claim', j.extra_claim, 'extra_claim_note', j.extra_claim_note, 'settle_month', j.settle_month,
      'reports', j.reports, 'cancel_requested', j.cancel_requested, 'cancel_reason', j.cancel_reason,
      'locked', j.settle_month is not null and private.settle_locked(pid, j.settle_month),
      'route_km', j.route_km, 'route_src', j.route_src, 'route_err', j.route_err, 'fuel_mode', j.fuel_mode,
      'checklist', j.checklist,
      'photos', coalesce((select json_agg(json_build_object('id', p.id, 'url', p.url) order by p.created_at) from public.job_photos p where p.job_id = j.id), '[]'::json),
      'created_at', j.created_at)
      order by coalesce(j.visit_date, j.requested_date, j.created_at::date), j.created_at)
      from public.jobs j where j.partner_id = pid and j.status <> '취소'), '[]'::json));
end $$;
