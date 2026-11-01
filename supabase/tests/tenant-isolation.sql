\set ON_ERROR_STOP on
-- MET-72 / MET-8. Run in isolated PostgreSQL after bootstrap.sql and migrations
-- 001-003 (also safe after security.sql, which rolls back). No cloud connection.
-- Only setup uses a privileged role; assertions execute as the app's actual role.
-- Every helper and controlled test row is discarded by the final rollback.
begin;

create function pg_temp.assert(value boolean, label text) returns void
language plpgsql as $$
begin
  if value is distinct from true then raise exception 'FAIL: %', label; end if;
end
$$;

-- Invoker rights are intentional: a helper must never bypass the tested RLS.
-- Catch only 42501; syntax errors, missing fixtures and unexpected success fail.
create function pg_temp.tenant_expect_denied(command text, label text) returns void
language plpgsql as $$
begin
  begin
    execute command;
  exception when insufficient_privilege then
    return;
  end;
  raise exception 'FAIL: % (expected SQLSTATE 42501)', label;
end
$$;

-- Compare exact multisets, not just existence: an extra foreign row must fail.
-- There is exactly one repository/artifact/proposal/decision/job per test org.
create function pg_temp.tenant_assert_scope(
  expected_orgs uuid[], expected_progress_orgs uuid[], label text
) returns void language plpgsql as $$
declare
  relation_name text;
  actual uuid[];
begin
  perform pg_temp.assert(current_user = 'authenticated', label || ': app role');
  perform pg_temp.assert(
    not (select rolbypassrls or rolsuper from pg_roles where rolname = current_user)
      and current_setting('row_security') = 'on', label || ': RLS enabled');
  select coalesce(array_agg(id order by id), '{}'::uuid[]) into actual
    from public.team_organizations;
  perform pg_temp.assert(actual = expected_orgs, label || ': organizations');
  foreach relation_name in array array[
    'team_repositories', 'team_memberships', 'team_repository_grants',
    'team_review_artifacts', 'team_fix_proposals', 'team_proposal_decisions'
  ] loop
    execute format(
      'select coalesce(array_agg(org_id order by org_id), ''{}''::uuid[]) from public.%I',
      relation_name
    ) into actual;
    perform pg_temp.assert(actual = expected_orgs, label || ': ' || relation_name);
  end loop;
  -- Preparation status exposes only these columns, not org_id or raw context.
  select coalesce(array_agg((key->>'orgId')::uuid order by (key->>'orgId')::uuid), '{}'::uuid[])
    into actual from public.team_preparation_jobs;
  perform pg_temp.assert(actual = expected_orgs, label || ': preparation status');
  select coalesce(array_agg(org_id order by org_id), '{}'::uuid[]) into actual
    from public.team_review_progress;
  perform pg_temp.assert(actual = expected_progress_orgs, label || ': private progress');
  perform pg_temp.assert(not exists(
    select 1 from public.team_review_progress where user_id is distinct from auth.uid()
  ), label || ': no other user progress');
  perform pg_temp.assert(not exists(
    select 1 from public.team_repository_grants where user_id is distinct from auth.uid()
  ), label || ': no other user grants');
end
$$;

-- Attack both relational IDs and the JSON key used by app requests. The foreign
-- key has the SAME repository, PR, SHAs, context and version as the caller's key.
create function pg_temp.tenant_assert_hidden(
  foreign_key jsonb, foreign_proposal uuid, label text
) returns void language plpgsql as $$
declare
  foreign_org uuid := (foreign_key->>'orgId')::uuid;
  relation_name text;
  hidden boolean;
begin
  perform pg_temp.assert(not exists(
    select 1 from public.team_organizations where id = foreign_org
  ), label || ': explicit organization ID');
  foreach relation_name in array array[
    'team_repositories', 'team_memberships', 'team_repository_grants',
    'team_organization_owners', 'team_review_artifacts', 'team_fix_proposals',
    'team_proposal_decisions', 'team_review_progress'
  ] loop
    execute format('select not exists(select 1 from public.%I where org_id = $1)', relation_name)
      into hidden using foreign_org;
    perform pg_temp.assert(hidden, label || ': explicit org WHERE on ' || relation_name);
  end loop;
  perform pg_temp.assert(not exists(
    select 1 from public.team_repositories
      where org_id = foreign_org and repository_id = foreign_key->>'repositoryId'
  ), label || ': compound org/repository lookup');
  perform pg_temp.assert(not exists(
    select 1 from public.team_review_artifacts where key = foreign_key
  ), label || ': forged artifact input key');
  perform pg_temp.assert(not exists(
    select 1 from public.team_fix_proposals where key = foreign_key or id = foreign_proposal
  ), label || ': forged proposal key and known UUID');
  perform pg_temp.assert(not exists(
    select 1 from public.team_proposal_decisions where proposal_id = foreign_proposal
  ), label || ': known proposal decision lookup');
  perform pg_temp.assert(not exists(
    select 1 from public.team_review_progress where key = foreign_key
  ), label || ': forged progress input key');
  perform pg_temp.assert(not exists(
    select 1 from public.team_preparation_jobs where key = foreign_key
  ), label || ': forged preparation input key');
end
$$;

create function pg_temp.tenant_assert_writes_denied(input_key jsonb, label text)
returns void language plpgsql as $$
begin
  perform pg_temp.tenant_expect_denied(format(
    'select public.team_write_progress(%L::jsonb, %L::jsonb, 0, %L::uuid)',
    input_key, jsonb_build_object('key', input_key, 'revision', 0,
      'cursor', 'forged.ts', 'notes', 'must not persist'), gen_random_uuid()
  ), label || ': progress RPC with forged org ID');
  perform pg_temp.tenant_expect_denied(format(
    'select public.team_retry_preparation(%L::jsonb, %L::uuid)', input_key, gen_random_uuid()
  ), label || ': retry RPC with forged org ID');
  perform pg_temp.tenant_expect_denied(format(
    'update public.team_review_progress set progress = %L::jsonb where key = %L::jsonb',
    '{"notes":"must not persist"}', input_key
  ), label || ': direct progress update');
  perform pg_temp.tenant_expect_denied(format(
    'delete from public.team_review_progress where key = %L::jsonb', input_key
  ), label || ': direct progress delete');
  perform pg_temp.tenant_expect_denied(format(
    'insert into public.team_review_progress(user_id, key, org_id, repository_id,
      progress, revision, request_id, request_digest)
     values (%L::uuid, %L::jsonb, %L::uuid, %L, %L::jsonb, 1, %L::uuid, %L)',
    auth.uid(), input_key, input_key->>'orgId', input_key->>'repositoryId',
    '{}', gen_random_uuid(), repeat('0', 64)
  ), label || ': direct progress insert');
end
$$;

\set tenant_user_a 72000000-0000-4000-8000-000000000001
\set tenant_user_b 72000000-0000-4000-8000-000000000002
\set tenant_outsider 72000000-0000-4000-8000-000000000003
\set tenant_org_a 72100000-0000-4000-8000-000000000001
\set tenant_org_b 72100000-0000-4000-8000-000000000002
-- Reuse request IDs across users to exercise the user boundary in private ledgers.
\set tenant_progress_request 72200000-0000-4000-8000-000000000001
\set tenant_share_request 72300000-0000-4000-8000-000000000001
\set tenant_decision_request 72400000-0000-4000-8000-000000000001

insert into auth.users(id) values (:'tenant_user_a'), (:'tenant_user_b'), (:'tenant_outsider');
insert into public.team_organizations(id, name) values
  (:'tenant_org_a', 'Tenant isolation A'), (:'tenant_org_b', 'Tenant isolation B');
insert into public.team_memberships(org_id, user_id, active) values
  (:'tenant_org_a', :'tenant_user_a', true), (:'tenant_org_b', :'tenant_user_b', true);
insert into public.team_organization_owners(org_id, user_id) values
  (:'tenant_org_a', :'tenant_user_a'), (:'tenant_org_b', :'tenant_user_b');
-- Identical GitHub identity in distinct orgs: repository ID alone is not authority.
insert into public.team_repositories(org_id, repository_id, full_name, installation_id, enabled) values
  (:'tenant_org_a', '7272', 'controlled/shared-repo', '7', true),
  (:'tenant_org_b', '7272', 'controlled/shared-repo', '7', true);
insert into public.team_repository_grants(
  org_id, repository_id, user_id, github_user_id, checked_at, expires_at
) values
  (:'tenant_org_a', '7272', :'tenant_user_a', '101', now(), now() + interval '60 seconds'),
  (:'tenant_org_b', '7272', :'tenant_user_b', '102', now(), now() + interval '60 seconds'),
  -- A fresh repository grant without any membership must still grant no access.
  (:'tenant_org_a', '7272', :'tenant_outsider', '103', now(), now() + interval '60 seconds'),
  (:'tenant_org_b', '7272', :'tenant_outsider', '103', now(), now() + interval '60 seconds');

select jsonb_build_object('orgId', :'tenant_org_a', 'repositoryId', '7272', 'prNumber', 1,
  'baseSha', repeat('a', 40), 'headSha', repeat('b', 40),
  'contextDigest', repeat('c', 64), 'analysisVersion', 'tenant-test-v1') as tenant_key_a \gset
select jsonb_set(:'tenant_key_a'::jsonb, '{orgId}', to_jsonb(:'tenant_org_b'::text)) as tenant_key_b \gset
select pg_temp.assert(
  (:'tenant_key_a'::jsonb - 'orgId') = (:'tenant_key_b'::jsonb - 'orgId')
    and :'tenant_key_a'::jsonb <> :'tenant_key_b'::jsonb,
  'control: immutable keys differ only by organization');
insert into public.team_review_artifacts(key, org_id, repository_id, review, digest)
select k, (k->>'orgId')::uuid, k->>'repositoryId',
  jsonb_build_object('pr', jsonb_build_object('number', 1,
    'baseSha', repeat('a', 40), 'headSha', repeat('b', 40))), d
from (values (:'tenant_key_a'::jsonb, repeat('d', 64)),
             (:'tenant_key_b'::jsonb, repeat('e', 64))) as seed(k, d);
insert into public.team_preparation_jobs(key, org_id, repository_id, context, state, attempts, error_code)
select k, (k->>'orgId')::uuid, k->>'repositoryId', '{}', 'failed', 1, 'controlled-test'
from (values (:'tenant_key_a'::jsonb), (:'tenant_key_b'::jsonb)) as seed(k);
insert into public.team_pr_heads(org_id, repository_id, pr_number, head_sha, github_author_id, checked_at) values
  (:'tenant_org_a', '7272', 1, repeat('b', 40), '101', now()),
  (:'tenant_org_b', '7272', 1, repeat('b', 40), '102', now());
insert into public.team_feedback_revisions(
  org_id, repository_id, pr_number, kind, source_id, revision, body_digest, checked_at
)
select o, '7272', 1, 'pull-review-comment', '9', '2026-11-01T00:00:00Z',
  encode(extensions.digest('controlled feedback', 'sha256'), 'hex'), now()
from (values (:'tenant_org_a'::uuid), (:'tenant_org_b'::uuid)) as seed(o);
select jsonb_build_array(jsonb_build_object('path', 'a.ts',
  'before', jsonb_build_object('text', 'old', 'sha256', encode(extensions.digest('old', 'sha256'), 'hex')),
  'after', jsonb_build_object('text', 'new', 'sha256', encode(extensions.digest('new', 'sha256'), 'hex'))
)) as tenant_files \gset
select jsonb_build_object('key', :'tenant_key_a'::jsonb, 'baseSha', repeat('b', 40),
  'candidateSha', repeat('f', 40), 'feedback', jsonb_build_object('kind', 'pull-review-comment',
    'id', '9', 'revision', '2026-11-01T00:00:00Z', 'body', 'controlled feedback',
    'bodyDigest', encode(extensions.digest('controlled feedback', 'sha256'), 'hex')),
  'files', :'tenant_files'::jsonb, 'sourcesDigest', team_private.sha(:'tenant_files'::jsonb),
  'patch', jsonb_build_object('text', '-old +new',
    'sha256', encode(extensions.digest('-old +new', 'sha256'), 'hex')),
  'checks', '[]'::jsonb, 'checksDigest', team_private.sha('[]'::jsonb),
  'provenance', 'reported-local-candidate') as tenant_bundle_a \gset
select jsonb_set(:'tenant_bundle_a'::jsonb, '{key}', :'tenant_key_b'::jsonb) as tenant_bundle_b \gset
select team_private.sha(:'tenant_bundle_a'::jsonb) as tenant_digest_a,
       team_private.sha(:'tenant_bundle_b'::jsonb) as tenant_digest_b \gset

-- Seed genuine constrained proposal/decision rows through server-only APIs.
set local role service_role;
select public.team_share_proposal(:'tenant_bundle_a', :'tenant_digest_a',
  :'tenant_share_request', :'tenant_user_a')->>'id' as tenant_proposal_a \gset
select public.team_share_proposal(:'tenant_bundle_b', :'tenant_digest_b',
  :'tenant_share_request', :'tenant_user_b')->>'id' as tenant_proposal_b \gset
select public.team_decide_proposal(:'tenant_proposal_a', :'tenant_digest_a', 'accept',
  :'tenant_decision_request', true, :'tenant_user_a');
select public.team_decide_proposal(:'tenant_proposal_b', :'tenant_digest_b', 'accept',
  :'tenant_decision_request', true, :'tenant_user_b');
reset role;
select pg_temp.assert((select count(*) = 2 from public.team_fix_proposals), 'control: two proposals exist');
select pg_temp.assert((select count(*) = 2 from public.team_proposal_decisions), 'control: two decisions exist');
select pg_temp.assert((select count(*) = 4 from public.team_repository_grants
  where checked_at = now() and expires_at > now()), 'control: all four repository grants fresh');

set local role authenticated;
set local request.jwt.claim.sub = :'tenant_user_a';
select pg_temp.tenant_assert_scope(array[:'tenant_org_a'::uuid], '{}'::uuid[], 'disjoint A before progress');
select public.team_write_progress(:'tenant_key_a', jsonb_build_object('key', :'tenant_key_a'::jsonb,
  'revision', 0, 'cursor', 'a.ts', 'notes', 'private A'), 0, :'tenant_progress_request');
select pg_temp.tenant_assert_scope(array[:'tenant_org_a'::uuid], array[:'tenant_org_a'::uuid], 'disjoint A');
select pg_temp.assert((select key = :'tenant_key_a'::jsonb and digest = repeat('d', 64)
  from public.team_review_artifacts), 'A reads exact own artifact');
select pg_temp.assert((select bundle = :'tenant_bundle_a'::jsonb and id = :'tenant_proposal_a'::uuid
  from public.team_fix_proposals), 'A reads exact own proposal');
select pg_temp.assert((select proposal_id = :'tenant_proposal_a'::uuid and author_id = auth.uid()
  from public.team_proposal_decisions), 'A reads exact own decision');
select pg_temp.assert((select progress->>'notes' = 'private A' and revision = 1
  from public.team_review_progress), 'A reads exact own progress');
select pg_temp.tenant_assert_hidden(:'tenant_key_b', :'tenant_proposal_b', 'A cannot read B');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_b', 'A cannot write B');

set local request.jwt.claim.sub = :'tenant_user_b';
select pg_temp.tenant_assert_scope(array[:'tenant_org_b'::uuid], '{}'::uuid[], 'disjoint B before progress');
select public.team_write_progress(:'tenant_key_b', jsonb_build_object('key', :'tenant_key_b'::jsonb,
  'revision', 0, 'cursor', 'b.ts', 'notes', 'private B'), 0, :'tenant_progress_request');
select pg_temp.tenant_assert_scope(array[:'tenant_org_b'::uuid], array[:'tenant_org_b'::uuid], 'disjoint B');
select pg_temp.assert((select key = :'tenant_key_b'::jsonb and digest = repeat('e', 64)
  from public.team_review_artifacts), 'B reads exact own artifact');
select pg_temp.assert((select bundle = :'tenant_bundle_b'::jsonb and id = :'tenant_proposal_b'::uuid
  from public.team_fix_proposals), 'B reads exact own proposal');
select pg_temp.assert((select proposal_id = :'tenant_proposal_b'::uuid and author_id = auth.uid()
  from public.team_proposal_decisions), 'B reads exact own decision');
select pg_temp.assert((select progress->>'notes' = 'private B' and revision = 1
  from public.team_review_progress), 'B reads exact own progress');
select pg_temp.tenant_assert_hidden(:'tenant_key_a', :'tenant_proposal_a', 'B cannot read A');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_a', 'B cannot write A');
-- Both users have now stored progress; repeat A's foreign-key read against real B rows.
set local request.jwt.claim.sub = :'tenant_user_a';
select pg_temp.tenant_assert_hidden(:'tenant_key_b', :'tenant_proposal_b', 'A cannot read populated B');
-- A user JWT cannot impersonate the other actor in privileged server APIs.
select pg_temp.tenant_expect_denied(format(
  'select public.team_find_shared_proposal(%L::uuid, %L, %L::uuid)',
  :'tenant_share_request', :'tenant_digest_b', :'tenant_user_b'), 'forged server lookup actor denied');
select pg_temp.tenant_expect_denied(format(
  'select public.team_share_proposal(%L::jsonb, %L, %L::uuid, %L::uuid)',
  :'tenant_bundle_b', :'tenant_digest_b', :'tenant_share_request', :'tenant_user_b'),
  'forged server share actor denied');
select pg_temp.tenant_expect_denied(format(
  'select public.team_decide_proposal(%L::uuid, %L, %L, %L::uuid, true, %L::uuid)',
  :'tenant_proposal_b', :'tenant_digest_b', 'accept', :'tenant_decision_request', :'tenant_user_b'),
  'forged server decision actor denied');
select pg_temp.tenant_expect_denied(format(
  'select public.team_find_shared_proposal(%L::uuid, %L)',
  :'tenant_share_request', :'tenant_digest_b'), 'legacy direct lookup denied');
select pg_temp.tenant_expect_denied(format(
  'select public.team_share_proposal(%L::jsonb, %L, %L::uuid)',
  :'tenant_bundle_b', :'tenant_digest_b', :'tenant_share_request'), 'legacy direct share denied');
select pg_temp.tenant_expect_denied(format(
  'select public.team_decide_proposal(%L::uuid, %L, %L, %L::uuid, true)',
  :'tenant_proposal_b', :'tenant_digest_b', 'accept', :'tenant_decision_request'), 'legacy direct decision denied');
do $$
declare relation_name text;
begin
  foreach relation_name in array array[
    'public.team_pr_heads', 'public.team_feedback_revisions', 'public.team_webhooks',
    'team_private.progress_requests', 'team_private.proposal_share_requests',
    'team_private.preparation_retries', 'team_private.onboarding_requests'
  ] loop
    perform pg_temp.tenant_expect_denied('select * from ' || relation_name,
      'authenticated cannot read server-only data: ' || relation_name);
  end loop;
  perform pg_temp.tenant_expect_denied('select context from public.team_preparation_jobs',
    'authenticated status access does not expose raw preparation context');
end
$$;
select pg_temp.tenant_expect_denied(format(
  'insert into public.team_memberships(org_id, user_id) values (%L::uuid, %L::uuid)',
  :'tenant_org_b', :'tenant_user_a'), 'self-joining foreign team denied');
select pg_temp.tenant_expect_denied(format(
  'insert into public.team_repository_grants values (%L::uuid, %L, %L::uuid, %L, now(), now()+interval ''60 seconds'')',
  :'tenant_org_b', '7272', :'tenant_user_a', '101'), 'self-granting foreign repository denied');

-- A fresh grant alone is insufficient, including for an explicit foreign key.
set local request.jwt.claim.sub = :'tenant_outsider';
select pg_temp.tenant_assert_scope('{}'::uuid[], '{}'::uuid[], 'nonmember with two fresh grants');
select pg_temp.tenant_assert_hidden(:'tenant_key_a', :'tenant_proposal_a', 'nonmember A denied');
select pg_temp.tenant_assert_hidden(:'tenant_key_b', :'tenant_proposal_b', 'nonmember B denied');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_a', 'nonmember cannot write A');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_b', 'nonmember cannot write B');

-- Anonymous is denied at the table/function privilege boundary even when a
-- forged subject names a real member; clearing it must also remain denied.
reset role;
set local role anon;
set local request.jwt.claim.sub = :'tenant_user_a';
do $$
declare relation_name text;
begin
  perform pg_temp.assert(current_user = 'anon', 'anonymous role active');
  foreach relation_name in array array[
    'team_organizations', 'team_memberships', 'team_organization_owners',
    'team_repositories', 'team_repository_grants', 'team_review_artifacts',
    'team_review_progress', 'team_fix_proposals', 'team_proposal_decisions',
    'team_preparation_jobs', 'team_pr_heads', 'team_feedback_revisions', 'team_webhooks'
  ] loop
    perform pg_temp.tenant_expect_denied(format('select * from public.%I', relation_name),
      'anonymous table read: ' || relation_name);
  end loop;
end
$$;
select pg_temp.tenant_assert_writes_denied(:'tenant_key_a', 'anonymous forged subject');
set local request.jwt.claim.sub = '';
select pg_temp.tenant_expect_denied('select * from public.team_review_artifacts', 'anonymous without subject');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_b', 'anonymous without subject');

reset role;
select pg_temp.assert((select count(*) = 2 and bool_and(revision = 1)
  from public.team_review_progress), 'denied attacks left both original progress rows intact');
select pg_temp.assert((select count(*) = 2 from team_private.progress_requests), 'denied attacks added no progress receipts');
select pg_temp.assert((select count(*) = 0 from team_private.preparation_retries), 'denied attacks added no retry receipts');
select pg_temp.assert((select count(*) = 2 from public.team_preparation_jobs
  where state = 'failed' and attempts = 1), 'denied retry attacks did not change jobs');

-- Membership in both teams permits shared content, but still needs a grant in
-- each team. Membership alone must not reuse A's grant for the same repository ID.
insert into public.team_memberships(org_id, user_id, active) values (:'tenant_org_b', :'tenant_user_a', true);
set local role authenticated;
set local request.jwt.claim.sub = :'tenant_user_a';
select pg_temp.assert((select count(*) = 2 from public.team_organizations), 'multi-org membership lists both orgs');
select pg_temp.assert((select count(*) = 1 from public.team_repositories), 'membership cannot borrow same-repo grant');
select pg_temp.assert(not exists(select 1 from public.team_review_artifacts where key = :'tenant_key_b'::jsonb),
  'second membership without its org-specific grant cannot read artifact');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_b', 'second membership without grant');
reset role;
insert into public.team_repository_grants values
  (:'tenant_org_b', '7272', :'tenant_user_a', '101', now(), now() + interval '60 seconds');
set local role authenticated;
select pg_temp.tenant_assert_scope(array[:'tenant_org_a'::uuid, :'tenant_org_b'::uuid],
  array[:'tenant_org_a'::uuid], 'A authorized in both teams');
select pg_temp.assert(not exists(select 1 from public.team_review_progress where user_id = :'tenant_user_b'::uuid),
  'multi-org A cannot read B private notes in shared org B');
select public.team_write_progress(:'tenant_key_b', jsonb_build_object('key', :'tenant_key_b'::jsonb,
  'revision', 0, 'cursor', 'a-in-b.ts', 'notes', 'private A in B'), 0,
  '72200000-0000-4000-8000-000000000002');
select pg_temp.tenant_assert_scope(array[:'tenant_org_a'::uuid, :'tenant_org_b'::uuid],
  array[:'tenant_org_a'::uuid, :'tenant_org_b'::uuid], 'A has private progress in both teams');
select pg_temp.assert((select progress->>'notes' = 'private A in B' and user_id = auth.uid()
  from public.team_review_progress where key = :'tenant_key_b'::jsonb), 'same-key progress belongs only to A');
set local request.jwt.claim.sub = :'tenant_user_b';
select pg_temp.tenant_assert_scope(array[:'tenant_org_b'::uuid], array[:'tenant_org_b'::uuid],
  'B still sees only B after A joins');
select pg_temp.assert((select progress->>'notes' = 'private B' and revision = 1
  from public.team_review_progress), 'A joining B did not overwrite B progress');
select pg_temp.assert(not exists(select 1 from public.team_review_progress where user_id = :'tenant_user_a'::uuid),
  'B cannot read either private progress row of multi-org A');
select pg_temp.tenant_assert_hidden(:'tenant_key_a', :'tenant_proposal_a', 'B still cannot read org A');

-- Revoke only A's original membership, retaining its fresh grant, owner row and
-- private cursor. Losing one org must not hide the other still-authorized org.
reset role;
update public.team_memberships set active = false
  where org_id = :'tenant_org_a'::uuid and user_id = :'tenant_user_a'::uuid;
select pg_temp.assert((select expires_at > now() from public.team_repository_grants
  where org_id = :'tenant_org_a'::uuid and user_id = :'tenant_user_a'::uuid), 'control: revoked member grant still fresh');
select pg_temp.assert((select count(*) = 3 from public.team_review_progress), 'control: all three private rows still exist');
set local role authenticated;
set local request.jwt.claim.sub = :'tenant_user_a';
select pg_temp.tenant_assert_scope(array[:'tenant_org_b'::uuid], array[:'tenant_org_b'::uuid],
  'revoked A membership with fresh grants');
select pg_temp.tenant_assert_hidden(:'tenant_key_a', :'tenant_proposal_a', 'revoked own team A denied');
select pg_temp.tenant_assert_writes_denied(:'tenant_key_a', 'revoked own team A cannot write');
-- Exact retry input was previously successful. Revocation must precede cached
-- idempotent results, so an old receipt cannot return private cursor/notes.
select pg_temp.tenant_expect_denied(format(
  'select public.team_write_progress(%L::jsonb, %L::jsonb, 0, %L::uuid)',
  :'tenant_key_a', jsonb_build_object('key', :'tenant_key_a'::jsonb,
    'revision', 0, 'cursor', 'a.ts', 'notes', 'private A'), :'tenant_progress_request'),
  'revoked membership cannot replay previously successful private progress receipt');
set local request.jwt.claim.sub = :'tenant_user_b';
select pg_temp.tenant_assert_scope(array[:'tenant_org_b'::uuid], array[:'tenant_org_b'::uuid],
  'B unaffected by A revocation');
reset role;
select pg_temp.assert((select count(*) = 3 and bool_and(revision = 1)
  from public.team_review_progress), 'revocation neither deleted nor mutated private rows');
select pg_temp.assert((select count(*) = 3 from team_private.progress_requests), 'only three authorized writes recorded');
select pg_temp.assert((select count(*) = 0 from team_private.preparation_retries), 'no denied retry mutated private ledger');

rollback;
