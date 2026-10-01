#!/usr/bin/env bash
# Bring up the local bench and load credentials + workflows into n8n.
#   ops/up.sh                 # against the HubSpot simulator (default)
#   HUBSPOT_TOKEN=... MODEL_API_KEY=... HUBSPOT_BASE_URL=https://api.hubapi.com MODEL_BASE_URL=https://api.openai.com ops/up.sh
# Secrets are read from the environment and written only to ops/runtime/ (git-ignored),
# then imported into n8n, which stores them encrypted with N8N_ENCRYPTION_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
: "${COMPOSE_PROJECT_NAME:=expedient}"; export COMPOSE_PROJECT_NAME
: "${N8N_PORT:=5678}"; export N8N_PORT

dc() { if docker compose version >/dev/null 2>&1; then docker compose "$@"; else docker-compose "$@"; fi; }

mkdir -p ops/runtime
dc up -d
echo "waiting for n8n on :$N8N_PORT"
for i in $(seq 1 90); do
  curl -sf "http://127.0.0.1:$N8N_PORT/healthz" >/dev/null && break
  sleep 2
done
curl -sf "http://127.0.0.1:$N8N_PORT/healthz" >/dev/null || { echo "n8n did not start"; exit 1; }

python3 - <<'PY'
import json, os
creds = [
  {"id": "ExpHubspotTok001", "name": "HubSpot private app token", "type": "hubspotAppToken",
   "data": {"appToken": os.environ.get("HUBSPOT_TOKEN", "simulator-token")}},
  {"id": "ExpModelKey00001", "name": "Model API key (Authorization: Bearer)", "type": "httpHeaderAuth",
   "data": {"name": "Authorization", "value": "Bearer " + os.environ.get("MODEL_API_KEY", "simulator-key")}},
  {"id": "ExpPostgres00001", "name": "Postgres (recruiting ledger)", "type": "postgres",
   "data": {"host": "postgres", "port": 5432, "database": "n8n", "user": "n8n",
            "password": os.environ["POSTGRES_PASSWORD"], "ssl": "disable"}},
]
with open("ops/runtime/credentials.json", "w") as f:
    json.dump(creds, f)
os.chmod("ops/runtime/credentials.json", 0o600)
PY

dc exec -T n8n n8n import:credentials --input=/import/runtime/credentials.json
dc exec -T n8n n8n import:workflow --input=/import/workflows/process-physician-inquiry.json
dc exec -T n8n n8n import:workflow --input=/import/workflows/poll-physician-inquiries.json
dc exec -T n8n n8n publish:workflow --id=ExpInqProcess001
dc exec -T n8n n8n publish:workflow --id=ExpInqPoller0001
dc restart n8n
for i in $(seq 1 90); do
  curl -sf "http://127.0.0.1:$N8N_PORT/healthz" >/dev/null && break
  sleep 2
done
# The runtime file held plaintext secrets only for the import.
: > ops/runtime/credentials.json
echo "ready: n8n $(dc exec -T n8n n8n --version) on http://127.0.0.1:$N8N_PORT"
