\set ON_ERROR_STOP on
begin;
insert into auth.users values('00000000-0000-4000-8000-000000000001'),('00000000-0000-4000-8000-000000000002'),('00000000-0000-4000-8000-000000000003');
insert into public.team_organizations values('10000000-0000-4000-8000-000000000001','Controlled test org');
insert into public.team_memberships values('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',true),('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',true);
insert into public.team_repositories values('10000000-0000-4000-8000-000000000001','42','test/repo','7',true);
insert into public.team_repository_grants values('10000000-0000-4000-8000-000000000001','42','00000000-0000-4000-8000-000000000001','101',now(),now()+interval '60 seconds'),('10000000-0000-4000-8000-000000000001','42','00000000-0000-4000-8000-000000000002','102',now(),now()+interval '60 seconds');
create function pg_temp.assert(value boolean,label text) returns void language plpgsql as $$begin if value is distinct from true then raise exception 'FAIL: %',label;end if;end$$;
-- Same immutable key both authorized users load, no personal fields in canonical artifact.
select jsonb_build_object('orgId','10000000-0000-4000-8000-000000000001','repositoryId','42','prNumber',1,'baseSha',repeat('a',40),'headSha',repeat('b',40),'contextDigest',repeat('c',64),'analysisVersion','test-v1') as key \gset
insert into public.team_review_artifacts(key,org_id,repository_id,review,digest) values(:'key','10000000-0000-4000-8000-000000000001','42',jsonb_build_object('pr',jsonb_build_object('baseSha',repeat('a',40),'headSha',repeat('b',40),'number',1)),repeat('d',64));
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=1 from public.team_review_artifacts),'user A reads canonical artifact');
select public.team_write_progress(:'key',jsonb_build_object('key',:'key'::jsonb,'revision',0,'cursor','a.ts','notes','private A'),0,'20000000-0000-4000-8000-000000000001');
select public.team_write_progress(:'key',jsonb_build_object('key',:'key'::jsonb,'revision',0,'cursor','a.ts','notes','private A'),0,'20000000-0000-4000-8000-000000000001');
select pg_temp.assert((select revision=1 from public.team_review_progress),'retry idempotent');
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select count(*)=1 from public.team_review_artifacts),'user B reads same canonical artifact');
select pg_temp.assert((select count(*)=0 from public.team_review_progress),'user B cannot read A notes/cursor');
select public.team_write_progress(:'key',jsonb_build_object('key',:'key'::jsonb,'revision',0,'cursor','b.ts','notes','private B'),0,'20000000-0000-4000-8000-000000000002');
select pg_temp.assert((select progress->>'notes'='private B' from public.team_review_progress),'user B independent progress');
do $$begin begin insert into public.team_repository_grants values('10000000-0000-4000-8000-000000000001','42',auth.uid(),'bad',now(),now()+interval '1 second');raise exception 'unexpected escalation';exception when insufficient_privilege then null;end;end$$;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000003';
select pg_temp.assert((select count(*)=0 from public.team_review_artifacts),'nonmember denied');
reset role;
update public.team_repository_grants set checked_at=now()-interval '61 seconds',expires_at=now()-interval '1 second' where user_id='00000000-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000002';
select pg_temp.assert((select count(*)=0 from public.team_review_artifacts),'expired repo grant denied despite membership');
select pg_temp.assert((select count(*)=0 from public.team_review_progress),'expired repo grant hides private progress');
reset role;
update public.team_memberships set active=false where user_id='00000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claim.sub='00000000-0000-4000-8000-000000000001';
select pg_temp.assert((select count(*)=0 from public.team_review_artifacts),'revoked member denied despite fresh repo grant');
reset role;
-- Raw webhook redelivery and lease fencing, all writes server-only.
select public.team_ingest_webhook('30000000-0000-4000-8000-000000000001',repeat('e',64),'10000000-0000-4000-8000-000000000001','42','7','{}');
select public.team_ingest_webhook('30000000-0000-4000-8000-000000000001',repeat('e',64),'10000000-0000-4000-8000-000000000001','42','7','{}');
select pg_temp.assert((select count(*)=1 from public.team_webhooks),'duplicate webhook fenced');
select public.team_claim('webhook',120)->>'lease_token' as lease \gset
update public.team_webhooks set lease_until=now()-interval '1 second';
select public.team_claim('webhook',120)->>'lease_token' as next_lease \gset
select pg_temp.assert(:'lease'<>:'next_lease','lease fencing token rotated');
select pg_temp.assert(not public.team_renew('webhook','30000000-0000-4000-8000-000000000001',:'lease',120),'stale owner cannot renew');
select public.team_enqueue_preparation(:'key',jsonb_build_object('pr',jsonb_build_object('baseSha',repeat('a',40),'headSha',repeat('b',40))),'30000000-0000-4000-8000-000000000001',:'next_lease');
select public.team_claim('preparation',120)->>'lease_token' as prep_lease \gset
select id as prep_id from public.team_preparation_jobs \gset
select public.team_finish_preparation(:'prep_id',:'prep_lease',jsonb_build_object('pr',jsonb_build_object('baseSha',repeat('a',40),'headSha',repeat('b',40),'number',1)),repeat('f',64));
select pg_temp.assert((select digest=repeat('d',64) from public.team_review_artifacts),'canonical result never overwritten');
rollback;
