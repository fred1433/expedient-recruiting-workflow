// Builds site/ (index.html and details/index.html) from page/template.html and the recorded runs
// in tests/results/. Nothing on the page calls an API: every value shown comes from these files.
// Each displayed reading is the validated result the ledger saved for that submission.
//   node scripts/build-page.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";

const root = new URL("..", import.meta.url).pathname;
const R = (id) => JSON.parse(readFileSync(root + "tests/results/" + id + ".json", "utf8"));
const summary = JSON.parse(readFileSync(root + "tests/results/summary.json", "utf8"));
const unit = JSON.parse(readFileSync(root + "tests/results/unit.json", "utf8"));
const { people } = await import(root + "tests/fixtures.mjs");

const label = (m, p, status) => {
  const path = p.replace(/^\/crm\//, "");
  if (/contacts\/search$/.test(path)) return "Looked for new form submissions";
  if (m === "GET" && /^v3\/objects\/contacts\/\d+$/.test(path)) return "Read the contact";
  if (p === "/v1/chat/completions") return "Asked the model to read the message";
  if (m === "PATCH" && /contacts\/\d+$/.test(path)) return "Wrote the suggested values to the contact";
  if (/associations\/tasks/.test(path)) return "Read a page of the contact's tasks";
  if (/tasks\/batch\/read$/.test(path)) return "Read those tasks";
  if (m === "POST" && /objects\/tasks$/.test(path)) return "Created the review task";
  if (m === "PATCH" && /tasks\/\d+$/.test(path)) return "Added the new inquiry to the open task";
  if (p === "/hooks/alert") return status === 200 ? "Delivered the failure alert" : "Tried to deliver the failure alert";
  return m + " " + path;
};

function calls(d) {
  const t0 = Date.parse(d.http[0]?.at || d.started);
  const day = (d.http[0]?.at || d.started).slice(0, 10);
  const out = [];
  for (const e of d.http) {
    const row = { t: (Date.parse(e.at) - t0) / 1000, what: label(e.method, e.path, e.status), status: e.status ?? null, fault: e.fault || null, dropped: !!e.dropped };
    if (row.fault === "blank_reply") row.status = 200;
    const last = out[out.length - 1];
    if (last && last.what === row.what && last.status === row.status && row.status >= 400 && row.t - last.t < 5 && !/alert/.test(row.what)) { last.times = (last.times || 1) + 1; continue; }
    out.push(row);
  }
  if (d.restartedAt) out.push({ t: (Date.parse(d.restartedAt) - t0) / 1000, what: "n8n restarted (docker compose restart)", marker: "restart", note: "The execution in progress is cut off." });
  for (const ev of d.events || []) {
    if (ev.step === "lease" && ev.outcome === "lost") out.push({ t: (Date.parse(day + "T" + ev.at + "Z") - t0) / 1000, what: "The first attempt checked its lease before writing", marker: "lease", note: "Another attempt owned it by then, so it stopped without writing anything." });
  }
  return out.sort((a, b) => a.t - b.t);
}

function reading(d, i, fixture) {
  const row = d.ledger[i] || {};
  const r = row.model_result;
  if (!r) return null;
  const ev = {};
  for (const k of ["specialty", "license_states", "states_not_licensed", "certification_statement", "intent", "call_availability"]) {
    if (r[k] && r[k].evidence && r[k].value && r[k].value !== "not_stated" && r[k].value !== "unclear") ev[k] = r[k].evidence;
  }
  const c = d.contacts.find((x) => x.properties.email === fixture.email) || d.contacts[0];
  return {
    values: {
      review_status: r.review_status, specialty: r.specialty?.value ?? null, license_states: r.license_states?.value ?? null,
      states_not_licensed: r.states_not_licensed?.value ?? null, certification_statement: r.certification_statement?.value,
      intent: r.intent?.value, call_availability: r.call_availability?.value ?? null, flags: r.flags || [],
    },
    evidence: ev,
    reply: r.proposed_reply,
    protected: d.before ? ["expedient_qme_status_verified", "hubspot_owner_id", "lifecyclestage"].map((k) => ({ k, before: d.before.properties[k], after: c.properties[k] })) : null,
  };
}

function task(d, preferId) {
  const t = (preferId && d.tasks.find((x) => x.id === preferId)) || d.tasks.find((x) => /expedient-inquiry-review/.test(x.properties.hs_task_body || "")) || d.tasks[0];
  if (!t) return null;
  const P = t.properties;
  return { subject: P.hs_task_subject, body: P.hs_task_body, due: P.hs_timestamp, owner: P.hubspot_owner_id, priority: P.hs_task_priority, status: P.hs_task_status, associated: Object.values(d.assoc || {}).some((ids) => ids.includes(t.id)) };
}

function scenario(id, fixtureKey) {
  const d = R(id);
  const f = people[fixtureKey];
  const reviewTasks = d.tasks.filter((x) => /expedient-inquiry-review/.test(x.properties.hs_task_body || "")).length;
  return {
    id, checks: d.checks, form: { name: f.firstname + " " + f.lastname, credentials: f.physician_credentials, email: f.email, phone: f.phone, message: f.message },
    reading: reading(d, 0, f), task: task(d, d.ledger[0]?.task_id), tasks: reviewTasks, calls: calls(d),
    model: (d.modelCalls || []).map((m) => ({ fields: m.fieldsSent, served: m.servedModel, ms: m.ms })),
    ledger: d.ledger.map((l) => ({ status: l.status, attempts: l.attempts, task_action: l.task_action, alerted: l.alerted })),
    executions: d.executions.map((e) => ({ wf: /poll/.test(e.workflow) ? "poller" : "process", status: e.status })),
    patches: d.http.filter((e) => e.method === "PATCH" && /contacts/.test(e.path)).length,
    alert: (d.alerts || [])[0]?.body?.text || null,
  };
}

const FIX = { ordinary: "raman", established: "okoye", sparse: "bell", outOfState: "park", conflict: "ortiz", unclear: "liu",
  restartMidway: "okoye", responseLost: "liu", taskFailsAfterUpdate: "park", payloadFrozen: "raman", staleWorker: "okoye",
  searchDownDuringRetry: "okoye", doubleDelivery: "okoye", samePhysicianAgain: "raman", paging: "raman", taskBeyondFirstPage: "raman",
  emptyReply: "liu", contactReadsFail: "raman", alertFails: "liu" };
const scen = Object.fromEntries(Object.entries(FIX).map(([id, f]) => [id, scenario(id, f)]));
const all = summary.scenarios;
const data = {
  ranAt: summary.ranAt, n8n: summary.n8n,
  model: (R("ordinary").modelCalls[0] || {}).servedModel,
  allPassed: all.every((s) => s.passed),
  scenarioCount: all.length,
  totalChecks: all.reduce((n, s) => n + (s.checks?.length || 0), 0),
  passedChecks: all.reduce((n, s) => n + (s.checks?.filter((c) => c.ok).length || 0), 0),
  unit: { passed: unit.passed, total: unit.total },
  scenarios: scen,
};
if (!data.allPassed || data.passedChecks !== data.totalChecks || unit.passed !== unit.total) throw new Error("not every assertion passed: fix the workflow and rerun before publishing");
if (Object.keys(FIX).length !== all.length) throw new Error("the page and the recorded run do not cover the same scenarios");

const json = JSON.stringify(data);
if (json.includes("—")) throw new Error("em dash in recorded data: fix the source before publishing");
const tpl = readFileSync(root + "page/template.html", "utf8");
if (tpl.includes("—")) throw new Error("em dash in the page template");
const html = tpl.replace("/*__DATA__*/null", json.replace(/</g, "\\u003c"));
mkdirSync(root + "site/files", { recursive: true });
mkdirSync(root + "site/details", { recursive: true });
writeFileSync(root + "site/index.html", html);
const details = html.replace('/*__MODE__*/"main"', '"details"')
  .replace(/(src|href)="(favicon\.(svg|png)|files\/)/g, '$1="../$2')
  .replace("<title>Physician inquiry workflow</title>", "<title>Recovery tests and setup</title>");
writeFileSync(root + "site/details/index.html", details);
for (const [from, to] of [
  ["workflows/process-physician-inquiry.json", "process-physician-inquiry.json"],
  ["workflows/poll-physician-inquiries.json", "poll-physician-inquiries.json"],
  ["workflows/workflow-error-alert.json", "workflow-error-alert.json"],
  ["README.md", "README.md"],
  ["hubspot/properties.json", "hubspot-properties.json"],
  ["db/init.sql", "recovery-ledger.sql"],
  ["workflows/model-instructions.txt", "model-instructions.txt"],
  ["tests/results/summary.json", "recorded-test-runs.json"],
]) copyFileSync(root + from, root + "site/files/" + to);
copyFileSync("/Users/frederic/ProjetsDev/the-ai-pipe-website/website/public/favicon.svg", root + "site/favicon.svg");
copyFileSync("/Users/frederic/ProjetsDev/the-ai-pipe-website/website/public/favicon.png", root + "site/favicon.png");
console.log(`site built: ${(html.length / 1024).toFixed(0)} KB, ${data.passedChecks} assertions across ${data.scenarioCount} scenarios, ${unit.passed} unit checks`);
