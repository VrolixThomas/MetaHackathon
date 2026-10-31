#!/usr/bin/env bash
set -euo pipefail
# Ephemeral isolated PostgreSQL, no published ports, no Supabase/cloud credentials.
team_test_container="muse-team-sql-$$"
team_test_root="$(cd -- "$(dirname -- "$0")/../.." && pwd)"
trap 'docker rm -f "$team_test_container" >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name "$team_test_container" -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17 >/dev/null
for _ in {1..40}; do
 if docker exec "$team_test_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
 sleep 0.25
done
for team_test_sql in "$team_test_root/supabase/tests/bootstrap.sql" "$team_test_root"/supabase/migrations/*.sql "$team_test_root/supabase/tests/security.sql"; do
 docker exec -i "$team_test_container" psql -h 127.0.0.1 -U postgres -v ON_ERROR_STOP=1 < "$team_test_sql"
done
