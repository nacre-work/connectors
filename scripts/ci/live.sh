#!/usr/bin/env bash
# The three verbs against a real Nacre. Usage: scripts/ci/live.sh git
#
# Starts the core's published images, makes an organization, two layers and
# two service accounts — one holding `write` for the connector, one holding
# `read` for this script to search with, because `write` does not imply
# `read` and the connector must work without it — then runs the connector's
# own image three times over a repository this script edits between runs, and
# watches a search: the document arrives, its text changes, it disappears.
set -euo pipefail
CONNECTOR="${1:?which connector}"
[ "$CONNECTOR" = git ] || { echo "::error::live.sh knows how to drive git; teach it ${CONNECTOR} before adding it to the matrix"; exit 1; }
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
WRITER=$(req POST /v1/service-accounts "$TOKEN" '{"name":"git-connector"}')
READER=$(req POST /v1/service-accounts "$TOKEN" '{"name":"live-reader"}')
WRITER_ID=$(printf '%s' "$WRITER" | json 'd.id'); WRITER_KEY=$(printf '%s' "$WRITER" | json 'd.key')
READER_ID=$(printf '%s' "$READER" | json 'd.id'); READER_KEY=$(printf '%s' "$READER" | json 'd.key')
for layer in "$HANDBOOK" "$CODE"; do
  req POST /v1/grants "$TOKEN" "{\"principal_type\":\"service_account\",\"principal_id\":\"$WRITER_ID\",\"scope_type\":\"layer\",\"scope_id\":\"$layer\",\"permission\":\"write\"}" >/dev/null
  req POST /v1/grants "$TOKEN" "{\"principal_type\":\"service_account\",\"principal_id\":\"$READER_ID\",\"scope_type\":\"layer\",\"scope_id\":\"$layer\",\"permission\":\"read\"}" >/dev/null
done

say "a repository, bare, that the connector will clone"
WORK="$LIVE/work"; BARE="$LIVE/repo.git"
git init -q -b main "$WORK"; git init -q --bare "$BARE"
gitw() { git -C "$WORK" -c user.name=live -c user.email=live@example.com "$@"; }
mkdir -p "$WORK/docs" "$WORK/src"
printf '# Leave\n\nThe word alphaleave appears only in this document.\n' > "$WORK/docs/leave.md"
printf 'export const codeword = "betacode"\n' > "$WORK/src/a.ts"
gitw add -A; gitw commit -q -m first; gitw push -q "$BARE" main

say "the connector image"
docker build -q ${LIVE_NODE_IMAGE:+--build-arg BASE="$LIVE_NODE_IMAGE"} -f "connectors/${CONNECTOR}/Dockerfile" -t "connector-${CONNECTOR}:live" . >/dev/null
NET="connectors-live_default"
STATE="$LIVE/state"; mkdir -p "$STATE"; chmod 777 "$STATE"
run_once() { # prints the container's log, and its exit code when it is not 0 —
  # a container that died must leave its reason on the screen, not a bare
  # "exit 1" from the assignment that captured it
  docker run --rm --network "$NET" -v "$STATE:/state" -v "$BARE:/src/repo.git:ro" \
    -e NACRE_URL=http://api:8080 -e NACRE_TOKEN="$WRITER_KEY" -e SYNC_ONCE=true \
    -e GIT_URL=/src/repo.git -e GIT_REF=main -e 'GIT_LAYERS=docs/**=handbook;src/**=code' \
    "connector-${CONNECTOR}:live" 2>&1 || echo "the connector exited $?"
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
LOG=$(run_once); echo "$LOG" | tail -3
echo "$LOG" | grep -q '"added":2' || die "the first sweep did not report two documents added"
wait_for leave.md alphaleave || die "docs/leave.md never arrived in a search by the reader"
wait_for a.ts betacode || die "src/a.ts never arrived in a search by the reader"
search leave.md | json "d.items.find(h=>h.title==='leave.md').layer==='handbook' ? 'ok' : undefined" >/dev/null || die "leave.md is not in the handbook layer"
search a.ts | json "d.items.find(h=>h.title==='a.ts').layer==='code' ? 'ok' : undefined" >/dev/null || die "a.ts is not in the code layer"

say "verb 2: change"
printf '# Leave\n\nThe word gammaleave replaced the old one.\n' > "$WORK/docs/leave.md"
gitw commit -q -am change; gitw push -q "$BARE" main
LOG=$(run_once); echo "$LOG" | tail -3
echo "$LOG" | grep -q '"changed":1' || die "the second sweep did not report one document changed"
wait_for leave.md gammaleave || die "the changed text never reached the index"
search leave.md | json "d.items.some(h=>h.title==='leave.md' && h.text.includes('alphaleave')) ? undefined : 'gone'" >/dev/null || die "the old text is still served"

say "verb 3: remove"
gitw rm -q docs/leave.md; gitw commit -q -m remove; gitw push -q "$BARE" main
LOG=$(run_once); echo "$LOG" | tail -3
echo "$LOG" | grep -q '"removed":1' || die "the third sweep did not report one document removed"
absent leave.md || die "docs/leave.md is still in the index after leaving the tree"
wait_for a.ts betacode || die "src/a.ts went missing while only leave.md was removed"

say "the status contract, from a running connector"
CID=$(docker run -d --rm --network "$NET" -v "$STATE:/state" -v "$BARE:/src/repo.git:ro" -p 9400:9400 \
  -e NACRE_URL=http://api:8080 -e NACRE_TOKEN="$WRITER_KEY" -e SYNC_INTERVAL=60 \
  -e GIT_URL=/src/repo.git -e GIT_REF=main -e 'GIT_LAYERS=docs/**=handbook;src/**=code' "connector-${CONNECTOR}:live")
for _ in $(seq 1 20); do curl -sf http://localhost:9400/healthz >/dev/null && break; sleep 1; done
STATUS=$(curl -sf http://localhost:9400/status); echo "$STATUS"
printf '%s' "$STATUS" | json "d.contract===1 && d.connector==='git' && d.layers.includes('code') ? 'ok' : undefined" >/dev/null || die "/status does not honour contract 1"
curl -sf http://localhost:9400/metrics | grep -q '^nacre_connector_state_documents{connector="git"} 1$' || die "/metrics does not count the one remaining document"
docker stop "$CID" >/dev/null

say "all three verbs arrived in a search against ${CORE}"
