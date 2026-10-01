// Helpers shared by the test scripts. They talk to the simulator, to n8n's webhook and to
// Postgres (ledger + n8n execution table) through docker compose.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(
  readFileSync(root + ".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
export const PROJECT = process.env.COMPOSE_PROJECT_NAME || "expedient";
export const N8N = `http://127.0.0.1:${process.env.N8N_PORT || 5678}`;
export const SIM = `http://127.0.0.1:${process.env.SIM_PORT || 4010}`;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function compose(args, opts = {}) {
  const bin = (() => { try { execFileSync("docker", ["compose", "version"], { stdio: "ignore" }); return ["docker", ["compose"]]; } catch { return ["docker-compose", []]; } })();
  return execFileSync(bin[0], [...bin[1], "-p", PROJECT, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ...env, COMPOSE_PROJECT_NAME: PROJECT }, ...opts });
}

export function sql(query) {
  const out = compose(["exec", "-T", "postgres", "psql", "-U", "n8n", "-d", "n8n", "-At", "-c", `select coalesce(json_agg(t), '[]') from (${query}) t`]);
  return JSON.parse(out.trim());
}
export function sqlExec(statement) {
  return compose(["exec", "-T", "postgres", "psql", "-U", "n8n", "-d", "n8n", "-At", "-c", statement]);
}

export async function sim(path, body) {
  const r = await fetch(SIM + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

// Right after a restart n8n answers /healthz before its webhooks are registered: wait for them.
export async function pollNow() {
  for (let i = 0; ; i++) {
    const r = await fetch(`${N8N}/webhook/expedient-poll-now`, { method: "POST", headers: { "x-poll-token": env.POLL_TRIGGER_TOKEN } }).catch(() => null);
    if (r && r.ok) return;
    if (i >= 40) throw new Error("poll webhook " + (r ? r.status + " " + (await r.text()) : "unreachable"));
    await sleep(1000);
  }
}

// Wait until n8n has no execution running and the ledger has nothing claimable right now.
export async function settle({ timeoutMs = 90000, quietMs = 2500 } = {}) {
  const t0 = Date.now();
  let quietSince = null;
  while (Date.now() - t0 < timeoutMs) {
    const [{ running }] = sql(`select count(*)::int as running from execution_entity where status in ('new','running','waiting')`);
    if (running === 0) {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= quietMs) return;
    } else quietSince = null;
    await sleep(500);
  }
  throw new Error("executions did not settle");
}

export function resetLedger() {
  sqlExec(`truncate recruiting.inquiry_ledger, recruiting.event_log; update recruiting.poll_state set checkpoint = now() - interval '1 day'; delete from execution_entity;`);
}

export const ledger = () => sql(`select submission_key, status, attempts, suggestions_written, task_id, task_action, last_step, last_error, alerted_at is not null as alerted from recruiting.inquiry_ledger order by conversion_at`);
export const events = () => sql(`select to_char(at, 'HH24:MI:SS.MS') as at, submission_key, step, outcome, detail from recruiting.event_log order by id`);
export const executions = () => sql(`select e.id, w.name as workflow, e.status, to_char(e."startedAt", 'HH24:MI:SS') as started, to_char(e."stoppedAt", 'HH24:MI:SS') as stopped from execution_entity e join workflow_entity w on w.id = e."workflowId" order by e.id`);
export { env };
