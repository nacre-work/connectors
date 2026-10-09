#!/usr/bin/env bash
# The three verbs against a real Nacre. Usage: scripts/ci/live.sh <connector>
#
# Starts the core's published images, makes an organization, two layers and
# two service accounts — one holding `write` for the connector, one holding
# `read` for this script to search with, because `write` does not imply
# `read` and the connector must work without it — then runs the connector's
# own image three times over a source this script edits between runs, and
# watches a search: the document arrives, its text changes, it disappears.
#
# What differs per connector is the source and nothing else, so each one is a
# function of five parts below — `prepare`, `run_once`, `change`, `remove`
# and `CONNECTOR_ENV` — and the verbs are asked of every connector the same
# way. A connector in a workflow matrix without a section here is refused by
# name rather than driven as git.
set -euo pipefail
CONNECTOR="${1:?which connector}"
case "$CONNECTOR" in git|s3|sql) ;; *) echo "::error::live.sh has no section for ${CONNECTOR}; write one before adding it to the matrix"; exit 1 ;; esac
cd "$(dirname "$0")/../.."
COMPOSE="docker compose -f docker-compose.live.yml"
API=http://localhost:8080
LIVE=$(mktemp -d)
say() { printf '\n== %s\n' "$*"; }
die() { echo "::error::$*"; exit 1; }
req() { # method path token [json]
  curl -sS --max-time 30 -X "$1" "${API}$2" -H "authorization: Bearer $3" -H 'content-type: application/json' ${4:+-d "$4"}
}
json() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const v=($1); if(v===undefined) process.exit(3); console.log(typeof v==='string'?v:JSON.stringify(v))"; }

CORE=$(grep -oE 'ghcr.io/nacre-work/nacre:[0-9.]+' docker-compose.live.yml | head -1)
say "core ${CORE}"
$COMPOSE up -d --quiet-pull
# The index's bucket, whichever connector runs: the stack is configured with
# object storage so a binary document has somewhere to live, `/v1/ready`
# refuses until the bucket answers, and the core's client deliberately has no
# create-bucket operation — so the run makes it, through the one S3 client
# this repository carries.
s3() { S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=live S3_SECRET_ACCESS_KEY=live-run-only-not-a-secret node scripts/ci/s3.mjs "$@"; }
for _ in $(seq 1 30); do s3 mkbucket nacre 2>/dev/null && break; sleep 2; done
for _ in $(seq 1 60); do curl -sf "${API}/v1/ready" >/dev/null && break; sleep 2; done
curl -sf "${API}/v1/ready" || die "the API never became ready"

say "init"
INIT=$($COMPOSE run --rm -T api node packages/api/dist/init.js --org acme --email admin@example.com --name Acme)
TOKEN=$(printf '%s\n' "$INIT" | sed -n 's/.*NACRE_TOKEN=\([A-Za-z0-9._-]*\).*/\1/p' | head -1)
WORKSPACE=$(printf '%s\n' "$INIT" | grep -oiE 'Workspace id[[:space:]]+[0-9a-f-]{36}' | grep -oiE '[0-9a-f-]{36}' | head -1)
[ -n "$TOKEN" ] && [ -n "$WORKSPACE" ] || die "init printed no token or workspace"

say "layers, and a writer that cannot read and a reader that cannot write"
HANDBOOK=$(req POST /v1/layers "$TOKEN" "{\"workspace_id\":\"$WORKSPACE\",\"slug\":\"handbook\",\"name\":\"Handbook\"}" | json 'd.id')
CODE=$(req POST /v1/layers "$TOKEN" "{\"workspace_id\":\"$WORKSPACE\",\"slug\":\"code\",\"name\":\"Code\"}" | json 'd.id')
WRITER=$(req POST /v1/service-accounts "$TOKEN" "{\"name\":\"${CONNECTOR}-connector\"}")
READER=$(req POST /v1/service-accounts "$TOKEN" '{"name":"live-reader"}')
WRITER_ID=$(printf '%s' "$WRITER" | json 'd.id'); WRITER_KEY=$(printf '%s' "$WRITER" | json 'd.key')
READER_ID=$(printf '%s' "$READER" | json 'd.id'); READER_KEY=$(printf '%s' "$READER" | json 'd.key')
for layer in "$HANDBOOK" "$CODE"; do
  req POST /v1/grants "$TOKEN" "{\"principal_type\":\"service_account\",\"principal_id\":\"$WRITER_ID\",\"scope_type\":\"layer\",\"scope_id\":\"$layer\",\"permission\":\"write\"}" >/dev/null
  req POST /v1/grants "$TOKEN" "{\"principal_type\":\"service_account\",\"principal_id\":\"$READER_ID\",\"scope_type\":\"layer\",\"scope_id\":\"$layer\",\"permission\":\"read\"}" >/dev/null
done

# The connector runs as its own image, which is what ships. `LIVE_FROM_DIST=1`
# runs the built `dist` on this host instead — a sandbox whose Docker daemon
# cannot reach a registry through its own TLS proxy has no other way to perform
# the run by hand — and says so in the summary, because a run that measured
# the source is not a run that measured the artifact. CI never sets it.
NET="connectors-live_default"
STATE="$LIVE/state"; mkdir -p "$STATE"; chmod 777 "$STATE"
if [ "${LIVE_FROM_DIST:-}" = 1 ]; then
  RAN="the built dist on this host, not the image"
  API_HOST=localhost; MINIO_HOST=localhost; SOURCE_PG=localhost:5433
else
  say "the connector image"
  docker build -q ${LIVE_NODE_IMAGE:+--build-arg BASE="$LIVE_NODE_IMAGE"} -f "connectors/${CONNECTOR}/Dockerfile" -t "connector-${CONNECTOR}:live" . >/dev/null
  RAN="the image"
  API_HOST=api; MINIO_HOST=minio; SOURCE_PG=source-postgres:5432
fi
LEAVE1='# Leave\n\nThe word alphaleave appears only in this document.\n'
LEAVE2='# Leave\n\nThe word gammaleave replaced the old one.\n'
CODE_TS='export const codeword = "betacode"\n'
LAYERS='docs/**=handbook;src/**=code'

# --- git ------------------------------------------------------------------
git_prepare() {
  say "a repository, bare, that the connector will clone"
  WORK="$LIVE/work"; BARE="$LIVE/repo.git"
  git init -q -b main "$WORK"; git init -q --bare "$BARE"
  mkdir -p "$WORK/docs" "$WORK/src"
  printf "$LEAVE1" > "$WORK/docs/leave.md"
  printf "$CODE_TS" > "$WORK/src/a.ts"
  gitw add -A; gitw commit -q -m first; gitw push -q "$BARE" main
  ADDED=2
  MOUNTS=(-v "$BARE:/src/repo.git:ro")
  CONNECTOR_ENV=(GIT_URL="$([ "${LIVE_FROM_DIST:-}" = 1 ] && echo "$BARE" || echo /src/repo.git)" GIT_REF=main "GIT_LAYERS=$LAYERS")
}
gitw() { git -C "$WORK" -c user.name=live -c user.email=live@example.com "$@"; }
git_change() { printf "$LEAVE2" > "$WORK/docs/leave.md"; gitw commit -q -am change; gitw push -q "$BARE" main; }
git_remove() { gitw rm -q docs/leave.md; gitw commit -q -m remove; gitw push -q "$BARE" main; }

# --- s3 -------------------------------------------------------------------
# A second bucket in the same MinIO, `source`, which the connector reads. The
# Word document is the case the suite's map cannot ask: the bytes go up as a
# file, the core extracts the text, and the phrase comes back out of a search.
s3_prepare() {
  say "a source bucket with three objects under corp/"
  s3 mkbucket source
  printf "$LEAVE1" > "$LIVE/leave.md"; printf "$CODE_TS" > "$LIVE/a.ts"
  python3 scripts/ci/make-docx.py "$LIVE/budget.docx" "The word deltabudget is in a Word document."
  s3 put source corp/docs/leave.md "$LIVE/leave.md" text/markdown
  s3 put source corp/src/a.ts "$LIVE/a.ts"
  s3 put source corp/docs/budget.docx "$LIVE/budget.docx" application/octet-stream
  ADDED=3
  MOUNTS=()
  CONNECTOR_ENV=(S3_ENDPOINT="http://${MINIO_HOST}:9000" S3_BUCKET=source S3_PREFIX=corp/ S3_FORCE_PATH_STYLE=true
    S3_ACCESS_KEY_ID=live S3_SECRET_ACCESS_KEY=live-run-only-not-a-secret "S3_LAYERS=$LAYERS")
}
s3_change() { printf "$LEAVE2" > "$LIVE/leave.md"; s3 put source corp/docs/leave.md "$LIVE/leave.md" text/markdown; }
s3_remove() { s3 rm source corp/docs/leave.md; }

# --- sql ------------------------------------------------------------------
# A second Postgres, `source-postgres`, which the connector queries. Never the
# index's own: a connector pointed at the database behind the index is a
# connector reading what it writes, and a run that measured that would have
# measured nothing. The rows carry a `kind` column so the layer is a template
# over the row rather than a constant, and `updated_at` is the watermark the
# change moves — the row-hash path is the suite's.
psql_source() { $COMPOSE exec -T source-postgres psql -v ON_ERROR_STOP=1 -q -U source -d source -c "$1" >/dev/null; }
sql_prepare() {
  say "a documents table with two rows"
  for _ in $(seq 1 30); do $COMPOSE exec -T source-postgres pg_isready -U source -d source >/dev/null 2>&1 && break; sleep 2; done
  psql_source "CREATE TABLE documents (id serial PRIMARY KEY, kind text NOT NULL, title text NOT NULL, body text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"
  psql_source "INSERT INTO documents (kind, title, body) VALUES ('handbook', 'leave.md', E'$LEAVE1'), ('code', 'a.ts', E'$CODE_TS')"
  ADDED=2
  MOUNTS=()
  CONNECTOR_ENV=(SQL_URL="postgres://source:source@${SOURCE_PG}/source" "SQL_QUERY=SELECT id, kind, title, body, updated_at FROM documents"
    'SQL_LAYER=${kind}' 'SQL_CONTENT=${body}' SQL_VERSION=updated_at)
}
sql_change() { psql_source "UPDATE documents SET body = E'$LEAVE2', updated_at = now() WHERE title = 'leave.md'"; }
sql_remove() { psql_source "DELETE FROM documents WHERE title = 'leave.md'"; }

"${CONNECTOR}_prepare"
with_env() { local out=(); local kv; for kv in "${CONNECTOR_ENV[@]}"; do out+=(-e "$kv"); done; printf '%s\n' "${out[@]}"; }
run_connector() { # detached? extra-env… → runs the connector once (SYNC_ONCE) or as a service
  local mode="$1"; shift
  if [ "${LIVE_FROM_DIST:-}" = 1 ]; then
    if [ "$mode" = once ]; then
      env "${CONNECTOR_ENV[@]}" NACRE_URL="http://${API_HOST}:8080" NACRE_TOKEN="$WRITER_KEY" CONNECTOR_STATE="$STATE/connector.sqlite" "$@" \
        node "connectors/${CONNECTOR}/dist/main.js" 2>&1
    else
      env "${CONNECTOR_ENV[@]}" NACRE_URL="http://${API_HOST}:8080" NACRE_TOKEN="$WRITER_KEY" CONNECTOR_STATE="$STATE/connector.sqlite" "$@" \
        node "connectors/${CONNECTOR}/dist/main.js" >"$LIVE/service.log" 2>&1 & echo $!
    fi
  else
    local envs; mapfile -t envs < <(with_env)
    local extra=(); local kv; for kv in "$@"; do extra+=(-e "$kv"); done
    if [ "$mode" = once ]; then
      docker run --rm --network "$NET" -v "$STATE:/state" "${MOUNTS[@]}" "${envs[@]}" "${extra[@]}" \
        -e NACRE_URL="http://${API_HOST}:8080" -e NACRE_TOKEN="$WRITER_KEY" "connector-${CONNECTOR}:live" 2>&1
    else
      docker run -d --rm --network "$NET" -v "$STATE:/state" "${MOUNTS[@]}" "${envs[@]}" "${extra[@]}" -p 9400:9400 \
        -e NACRE_URL="http://${API_HOST}:8080" -e NACRE_TOKEN="$WRITER_KEY" "connector-${CONNECTOR}:live"
    fi
  fi
}
run_once() { # prints the connector's log, and its exit code when it is not 0 —
  # a process that died must leave its reason on the screen, not a bare
  # "exit 1" from the assignment that captured it
  run_connector once SYNC_ONCE=true || echo "the connector exited $?"
}
search() { req POST /v1/search "$READER_KEY" "{\"query\":\"$1\",\"top_k\":50,\"include_content\":true}"; }
# Under the constant-vector stub every permitted document is in every answer,
# so the questions are about presence and text, never about rank.
wait_for() { # title text-fragment → waits for a hit titled $1 whose text contains $2
  for _ in $(seq 1 45); do
    if search "$1" | json "d.items.find(h=>h.title===\"$1\" && h.text.includes(\"$2\")) ? 'yes' : undefined" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
absent() { # title → true once no hit carries it
  for _ in $(seq 1 45); do
    if ! search "$1" | json "d.items.some(h=>h.title===\"$1\") ? 'present' : undefined" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

say "verb 1: add"
LOG=$(run_once); echo "$LOG"
echo "$LOG" | grep -q "\"added\":${ADDED}" || die "the first sweep did not report ${ADDED} documents added"
wait_for leave.md alphaleave || die "docs/leave.md never arrived in a search by the reader"
wait_for a.ts betacode || die "src/a.ts never arrived in a search by the reader"
if [ "$CONNECTOR" = s3 ]; then
  wait_for budget.docx deltabudget || die "the Word document's text never arrived: the bytes went up as a file and the core read them, or they did not"
fi
search leave.md | json "d.items.find(h=>h.title==='leave.md').layer==='handbook' ? 'ok' : undefined" >/dev/null || die "leave.md is not in the handbook layer"
search a.ts | json "d.items.find(h=>h.title==='a.ts').layer==='code' ? 'ok' : undefined" >/dev/null || die "a.ts is not in the code layer"

say "verb 2: change"
"${CONNECTOR}_change"
LOG=$(run_once); echo "$LOG"
echo "$LOG" | grep -q '"changed":1' || die "the second sweep did not report one document changed"
wait_for leave.md gammaleave || die "the changed text never reached the index"
search leave.md | json "d.items.some(h=>h.title==='leave.md' && h.text.includes('alphaleave')) ? undefined : 'gone'" >/dev/null || die "the old text is still served"

say "verb 3: remove"
"${CONNECTOR}_remove"
LOG=$(run_once); echo "$LOG"
echo "$LOG" | grep -q '"removed":1' || die "the third sweep did not report one document removed"
absent leave.md || die "docs/leave.md is still in the index after leaving the tree"
wait_for a.ts betacode || die "src/a.ts went missing while only leave.md was removed"

say "the status contract, from a running connector"
CID=$(run_connector service SYNC_INTERVAL=60)
for _ in $(seq 1 20); do curl -sf http://localhost:9400/healthz >/dev/null && break; sleep 1; done
STATUS=$(curl -sf http://localhost:9400/status); echo "$STATUS"
printf '%s' "$STATUS" | json "d.contract===1 && d.connector==='${CONNECTOR}' && d.layers.includes('code') ? 'ok' : undefined" >/dev/null || die "/status does not honour contract 1"
curl -sf http://localhost:9400/metrics | grep -q "^nacre_connector_state_documents{connector=\"${CONNECTOR}\"} $((ADDED-1))\$" || die "/metrics does not count the one remaining document"
if [ "${LIVE_FROM_DIST:-}" = 1 ]; then kill "$CID"; else docker stop "$CID" >/dev/null; fi

say "all three verbs arrived in a search against ${CORE}, running ${RAN}"
