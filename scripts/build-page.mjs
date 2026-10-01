// Builds site/ from page/template.html and the recorded runs in tests/results/.
// Nothing on the page calls an API: every value shown comes from these files.
//   node scripts/build-page.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const R = (id) => JSON.parse(readFileSync(root + "tests/results/" + id + ".json", "utf8"));
const summary = JSON.parse(readFileSync(root + "tests/results/summary.json", "utf8"));
const { people } = await import(root + "tests/fixtures.mjs");

const label = (m, p) => {
  const path = p.replace(/^\/crm\//, "");
  if (/contacts\/search$/.test(path)) return "Looked for new form submissions";
  if (m === "GET" && /^v3\/objects\/contacts\/\d+$/.test(path)) return "Read the contact";
  if (p === "/v1/chat/completions") return "Asked the model to read the message";
  if (m === "PATCH" && /contacts\/\d+$/.test(path)) return "Wrote the suggestions to the contact";
  if (/associations\/tasks$/.test(path)) return "Checked the contact's existing tasks";
  if (/tasks\/batch\/read$/.test(path)) return "Read those tasks";
  if (m === "POST" && /objects\/tasks$/.test(path)) return "Created the review task";
  if (m === "PATCH" && /tasks\/\d+$/.test(path)) return "Added the new inquiry to the open task";
  return m + " " + path;
};

function calls(d) {
  const t0 = Date.parse(d.http[0]?.at || d.started);
  const out = [];
  for (const e of d.http) {
    const row = { t: (Date.parse(e.at) - t0) / 1000, what: label(e.method, e.path), status: e.status ?? null, fault: e.fault || null, dropped: !!e.dropped };
    const last = out[out.length - 1];
    if (last && last.what === row.what && last.status === row.status && row.status >= 400 && row.t - last.t < 5) { last.times = (last.times || 1) + 1; continue; }
    out.push(row);
  }
  if (d.restartedAt) out.push({ t: (Date.parse(d.restartedAt) - t0) / 1000, what: "n8n restarted (docker compose restart)", marker: "restart" });
  for (const a of d.alerts || []) out.push({ t: (Date.parse(a.at) - t0) / 1000, what: "Failure alert sent", marker: "alert", alert: a.body.text });
  return out.sort((a, b) => a.t - b.t);
}

const SUG = ["specialty", "license_states", "certification_statement", "intent", "call_availability", "review_status", "flags"];
function reading(d, fixture) {
  const c = d.contacts.find((x) => x.properties.email === fixture.email) || d.contacts[0];
  const p = c.properties;
  const mc = (d.modelCalls || []).find((m) => m.content);
  let raw = null;
  try { raw = mc ? JSON.parse(mc.content) : null; } catch {}
  const ev = {};
  if (raw) for (const k of ["specialty", "license_states", "certification_statement", "intent", "call_availability"]) {
    const v = p["ai_inquiry_" + k];
    if (v && !["not stated", "not_stated", "unclear"].includes(v) && raw[k]?.evidence) ev[k] = String(raw[k].evidence).replace(/^["']+|["'.]+$/g, "");
  }
  return {
    values: Object.fromEntries(SUG.map((k) => [k, p["ai_inquiry_" + k] ?? null])),
    evidence: ev,
    questions: raw?.questions || [],
    protected: d.before ? ["expedient_qme_status_verified", "hubspot_owner_id", "lifecyclestage"].map((k) => ({ k, before: d.before.properties[k], after: p[k] })) : null,
  };
}

function task(d) {
  const t = d.tasks[0];
  if (!t) return null;
  const P = t.properties;
  return { subject: P.hs_task_subject, body: P.hs_task_body, due: P.hs_timestamp, owner: P.hubspot_owner_id, priority: P.hs_task_priority, status: P.hs_task_status, type: P.hs_task_type, associated: Object.values(d.assoc || {}).some((ids) => ids.includes(t.id)) };
}

function scenario(id, fixtureKey, extra = {}) {
  const d = R(id);
  const f = people[fixtureKey];
  return {
    id, checks: d.checks, form: { name: f.firstname + " " + f.lastname, credentials: f.physician_credentials, email: f.email, phone: f.phone, message: f.message },
    reading: reading(d, f), task: task(d), tasks: d.tasks.length, calls: calls(d),
    model: (d.modelCalls || []).map((m) => ({ fields: m.fieldsSent, served: m.servedModel, ms: m.ms, tokens: m.usage?.total_tokens })),
    ledger: d.ledger, executions: d.executions.map((e) => ({ wf: /poll/.test(e.workflow) ? "poller" : "process", status: e.status })),
    patches: d.http.filter((e) => e.method === "PATCH" && /contacts/.test(e.path)).length,
    ...extra,
  };
}

const data = {
  ranAt: summary.ranAt, n8n: summary.n8n,
  model: (R("ordinary").modelCalls[0] || {}).servedModel,
  allPassed: summary.scenarios.every((s) => s.passed),
  totalChecks: summary.scenarios.reduce((n, s) => n + (s.checks?.length || 0), 0),
  passedChecks: summary.scenarios.reduce((n, s) => n + (s.checks?.filter((c) => c.ok).length || 0), 0),
  scenarios: {
    ordinary: scenario("ordinary", "raman"),
    established: scenario("established", "okoye"),
    sparse: scenario("sparse", "bell"),
    outOfState: scenario("outOfState", "park"),
    conflict: scenario("conflict", "ortiz"),
    unclear: scenario("unclear", "liu"),
    doubleDelivery: scenario("doubleDelivery", "okoye"),
    samePhysicianAgain: scenario("samePhysicianAgain", "raman", { second: people.raman2.message }),
    taskFailsAfterUpdate: scenario("taskFailsAfterUpdate", "park"),
    responseLost: scenario("responseLost", "liu"),
    restartMidway: scenario("restartMidway", "okoye"),
    givesUp: scenario("givesUp", "raman"),
  },
};

const json = JSON.stringify(data);
if (json.includes("—")) throw new Error("em dash in recorded data: fix the source before publishing");
const html = readFileSync(root + "page/template.html", "utf8").replace("/*__DATA__*/null", json.replace(/</g, "\\u003c"));
if (html.includes("—")) throw new Error("em dash in the page template");
mkdirSync(root + "site/files", { recursive: true });
mkdirSync(root + "site/details", { recursive: true });
writeFileSync(root + "site/index.html", html);
const details = html.replace('/*__MODE__*/"main"', '"details"')
  .replace(/(src|href)="(favicon\.(svg|png)|files\/)/g, '$1="../$2')
  .replace("<title>Physician inquiry workflow</title>", "<title>Recovery runs and details</title>");
writeFileSync(root + "site/details/index.html", details);
for (const [from, to] of [
  ["workflows/process-physician-inquiry.json", "process-physician-inquiry.json"],
  ["workflows/poll-physician-inquiries.json", "poll-physician-inquiries.json"],
  ["README.md", "README.md"],
  ["hubspot/properties.json", "hubspot-properties.json"],
  ["db/init.sql", "recovery-ledger.sql"],
  ["workflows/model-instructions.txt", "model-instructions.txt"],
  ["tests/results/summary.json", "recorded-test-runs.json"],
]) copyFileSync(root + from, root + "site/files/" + to);
copyFileSync("/Users/frederic/ProjetsDev/the-ai-pipe-website/website/public/favicon.svg", root + "site/favicon.svg");
copyFileSync("/Users/frederic/ProjetsDev/the-ai-pipe-website/website/public/favicon.png", root + "site/favicon.png");
console.log("site built:", (html.length / 1024).toFixed(0) + " KB");
