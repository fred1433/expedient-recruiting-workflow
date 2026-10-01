// Runs every scenario against the local bench (n8n + Postgres + HubSpot simulator) and writes
// tests/results/<scenario>.json plus tests/results/summary.json. Model calls are real calls to
// the configured provider, forwarded unchanged by the simulator so they can be recorded.
//   node tests/run-scenarios.mjs [scenarioId ...]
import { writeFileSync, mkdirSync } from "node:fs";
import { sim, pollNow, settle, resetLedger, ledger, events, executions, sleep, compose, sql, N8N, env } from "./lib.mjs";
import { people, ortizExisting } from "./fixtures.mjs";

const OUT = new URL("./results/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const MAX = Number(env.MAX_ATTEMPTS || 3);
const LEASE = Number(env.LEASE_SECONDS || 45);

async function fresh(seed = {}, faults = []) {
  await sim("/__sim/reset", seed);
  await sim("/__sim/model", { mode: "proxy", replies: [] });
  resetLedger();
  await sim("/__sim/faults", { faults });
}
const submit = (p, at) => sim("/__sim/submit", { ...p, ...(at ? { at } : {}) });
const done = () => ledger().every((r) => r.status === "done" || r.status === "failed");

// Poll, let executions finish, repeat until every submission is done or given up.
async function drive({ maxRounds = 12 } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    await pollNow();
    await sleep(1200);
    await settle();
    if (ledger().length && done()) return;
    await sleep(2500);
  }
  throw new Error("scenario did not finish");
}

async function snapshot() {
  const st = await sim("/__sim/state");
  const log = (await sim("/__sim/log")).filter((e) => !e.path.startsWith("/__"));
  return { contacts: st.contacts, tasks: st.tasks, assoc: st.assoc, alerts: st.alerts, modelCalls: st.modelCalls, http: log,
    ledger: ledger(), events: events(), executions: executions() };
}
const count = (http, method, re) => http.filter((e) => e.method === method && re.test(e.path)).length;
const check = (label, ok, detail) => ({ label, ok: !!ok, ...(detail !== undefined ? { detail } : {}) });

const scenarios = {
  async ordinary() {
    await fresh();
    await submit(people.raman);
    await drive();
    const s = await snapshot();
    const t = s.tasks[0]?.properties || {};
    return { s, checks: [
      check("exactly one review task", s.tasks.length === 1),
      check("certification read as not yet certified", s.contacts[0].properties.ai_inquiry_certification_statement === "says_not_certified", s.contacts[0].properties.ai_inquiry_certification_statement),
      check("complete inquiry routed as ready for review", s.contacts[0].properties.ai_inquiry_review_status === "ready_for_review", s.contacts[0].properties.ai_inquiry_review_status),
      check("task associated to the contact", (s.assoc[s.contacts[0].id] || []).length === 1),
      check("task assigned to the recruiting owner", t.hubspot_owner_id === "900001"),
      check("task has a due date", !!t.hs_timestamp, t.hs_timestamp),
      check("proposed reply is in the task body", /Proposed reply/.test(t.hs_task_body || "")),
      check("one model call, two fields sent", s.modelCalls.length === 1 && s.modelCalls[0].fieldsSent.join(",") === "credentials,message", s.modelCalls.map((m) => m.fieldsSent)),
      check("no email sent (no email or communication endpoint called)", !s.http.some((e) => /emails|communications|messages/.test(e.path) && !e.path.startsWith("/v1/"))),
    ] };
  },
  async established() {
    await fresh();
    await submit(people.okoye);
    await drive();
    const s = await snapshot();
    return { s, checks: [
      check("exactly one review task", s.tasks.length === 1),
      check("intent read as an established QME", s.contacts[0].properties.ai_inquiry_intent === "established_qme_joining", s.contacts[0].properties.ai_inquiry_intent),
    ] };
  },
  async sparse() {
    await fresh();
    await submit(people.bell);
    await drive();
    const s = await snapshot();
    return { s, checks: [
      check("no model call for a one-word message", s.modelCalls.length === 0),
      check("review status: needs information", s.contacts[0].properties.ai_inquiry_review_status === "needs_information"),
      check("everything else left as not stated", s.contacts[0].properties.ai_inquiry_specialty === "not stated"),
      check("still one review task, with a reply asking for the basics", s.tasks.length === 1),
    ] };
  },
  async outOfState() {
    await fresh();
    await submit(people.park);
    await drive();
    const s = await snapshot();
    const p = s.contacts[0].properties;
    return { s, checks: [
      check("not rejected: a review task exists", s.tasks.length === 1),
      check("routed to clarification", p.ai_inquiry_review_status === "needs_clarification", p.ai_inquiry_review_status),
      check("flagged: licensed states without California", /clarify:licensed_states_without_california/.test(p.ai_inquiry_flags || ""), p.ai_inquiry_flags),
    ] };
  },
  async conflict() {
    await fresh({ contacts: [ortizExisting] });
    const before = (await sim("/__sim/state")).contacts[0];
    await submit(people.ortiz);
    await drive();
    const s = await snapshot();
    const after = s.contacts[0].properties;
    s.before = before;
    return { s, checks: [
      check("verified QME status unchanged", after.expedient_qme_status_verified === "certified_qme"),
      check("contact owner unchanged", after.hubspot_owner_id === "900002"),
      check("lifecycle stage unchanged", after.lifecyclestage === "opportunity"),
      check("conflict flagged for review", after.ai_inquiry_review_status === "conflict_with_verified_record", after.ai_inquiry_review_status),
      check("task raised to high priority", s.tasks[0]?.properties.hs_task_priority === "HIGH"),
    ] };
  },
  async unclear() {
    await fresh();
    await submit(people.liu);
    await drive();
    const s = await snapshot();
    const p = s.contacts[0].properties;
    return { s, checks: [
      check("routed to clarification", p.ai_inquiry_review_status === "needs_clarification", p.ai_inquiry_review_status),
      check("no certification status invented", p.ai_inquiry_certification_statement === "not_stated", p.ai_inquiry_certification_statement),
    ] };
  },
  async doubleDelivery() {
    await fresh();
    await submit(people.okoye);
    await Promise.all([pollNow(), pollNow()]);
    await sleep(1500); await settle();
    await drive();
    const s = await snapshot();
    const procs = s.executions.filter((e) => /process one/.test(e.workflow));
    const polls = s.executions.filter((e) => /poll/.test(e.workflow));
    return { s, checks: [
      check("two polls ran at the same time", polls.length >= 2, polls.length),
      check("the submission was processed once", procs.length === 1, procs.length),
      check("one contact update", count(s.http, "PATCH", /contacts/) === 1),
      check("one review task", s.tasks.length === 1),
      check("one model call", s.modelCalls.length === 1),
    ] };
  },
  async samePhysicianAgain() {
    await fresh();
    await submit(people.raman, Date.now() - 3 * 3600e3);
    await drive();
    await submit(people.raman2);
    await drive();
    const s = await snapshot();
    const body = s.tasks[0]?.properties.hs_task_body || "";
    return { s, checks: [
      check("both inquiries recorded and done", s.ledger.length === 2 && s.ledger.every((r) => r.status === "done")),
      check("the second inquiry was interpreted, not skipped", s.modelCalls.length === 2),
      check("still one open review task for this physician", s.tasks.length === 1),
      check("second inquiry added to that task", s.ledger[1]?.task_action === "appended" && /New inquiry from the same physician/.test(body)),
    ] };
  },
  async taskFailsAfterUpdate() {
    await fresh({}, [{ method: "POST", path: "^/crm/v3/objects/tasks$", mode: "error", status: 502, times: 1 }]);
    await submit(people.park);
    await drive();
    const s = await snapshot();
    return { s, checks: [
      check("first task creation failed (502)", s.http.some((e) => e.method === "POST" && /objects\/tasks$/.test(e.path) && e.status === 502)),
      check("contact updated once, not again on retry", count(s.http, "PATCH", /contacts/) === 1),
      check("model called once, interpretation reused", s.modelCalls.length === 1),
      check("one review task in the end", s.tasks.length === 1),
      check("finished on attempt 2", s.ledger[0].status === "done" && s.ledger[0].attempts === 2),
    ] };
  },
  async responseLost() {
    await fresh({}, [{ method: "POST", path: "^/crm/v3/objects/tasks$", mode: "drop_after_commit", times: 1 }]);
    await submit(people.liu);
    await drive();
    const s = await snapshot();
    return { s, checks: [
      check("the task was created but the answer never arrived", s.http.some((e) => e.dropped)),
      check("no second task created", count(s.http, "POST", /objects\/tasks$/) === 1 && s.tasks.length === 1),
      check("found by its reference and reconciled", s.ledger[0].task_action === "reconciled", s.ledger[0].task_action),
    ] };
  },
  async restartMidway() {
    await fresh({}, [{ method: "POST", path: "^/crm/v3/objects/tasks$", mode: "delay", delayMs: 15000, times: 1 }]);
    await submit(people.okoye);
    await pollNow();
    const t0 = Date.now();
    while (!(await sim("/__sim/log")).some((e) => e.method === "POST" && /objects\/tasks$/.test(e.path))) {
      if (Date.now() - t0 > 60000) throw new Error("task call never started");
      await sleep(300);
    }
    const restartedAt = new Date().toISOString();
    compose(["restart", "n8n"], { stdio: "ignore" });
    for (let i = 0; i < 90; i++) { try { if ((await fetch(N8N + "/healthz")).ok) break; } catch {} await sleep(1000); }
    const ledgerAfterRestart = ledger();
    // the lease of the interrupted attempt must expire before anyone may take it again
    await sleep((LEASE + 3) * 1000);
    await drive();
    const s = await snapshot();
    s.restartedAt = restartedAt;
    s.ledgerAfterRestart = ledgerAfterRestart;
    return { s, checks: [
      check("n8n restarted while the task call was in flight", ledgerAfterRestart[0]?.status === "processing", ledgerAfterRestart[0]?.status),
      check("the inquiry was not lost: picked up again after the lease expired", s.ledger[0].attempts === 2 && s.ledger[0].status === "done"),
      check("exactly one review task", s.tasks.length === 1),
      check("model not called again", s.modelCalls.length === 1),
    ] };
  },
  async givesUp() {
    await fresh({}, [{ method: "GET", path: "^/crm/v3/objects/contacts/\\d+$", mode: "error", status: 503, times: -1 }]);
    await submit(people.raman);
    await drive({ maxRounds: 20 });
    const s = await snapshot();
    const alert = JSON.stringify(s.alerts);
    return { s, checks: [
      check(`stopped after ${MAX} attempts`, s.ledger[0].status === "failed" && s.ledger[0].attempts === MAX, s.ledger[0]),
      check("one failure alert sent", s.alerts.length === 1),
      check("alert carries no message text, name or email", !/psychiatrist|Raman|Priya|example\.test/.test(alert)),
      check("failed executions visible in n8n", s.executions.some((e) => e.status === "error")),
      check("nothing written to HubSpot", count(s.http, "PATCH", /./) === 0 && count(s.http, "POST", /objects\/tasks/) === 0),
    ] };
  },
};

const only = process.argv.slice(2);
const summary = [];
const version = compose(["exec", "-T", "n8n", "n8n", "--version"]).trim();
for (const [id, fn] of Object.entries(scenarios)) {
  if (only.length && !only.includes(id)) continue;
  const started = new Date().toISOString();
  process.stdout.write(id + " ... ");
  try {
    const { s, checks } = await fn();
    const replies = s.tasks.map((t) => t.properties.hs_task_body || "").join(" ").split("Proposed reply").slice(1).join(" ");
    if (replies) checks.push(check("proposed reply does not ask for phone, email or name", !/(phone number|(your|best|a) (phone|contact) (number|details)|e-?mail address|your (full )?name)/i.test(replies)));
    const passed = checks.every((c) => c.ok);
    writeFileSync(OUT + id + ".json", JSON.stringify({ id, started, n8n: version, checks, ...s }, null, 2));
    summary.push({ id, started, passed, checks });
    console.log(passed ? "pass" : "FAIL " + JSON.stringify(checks.filter((c) => !c.ok)));
  } catch (e) {
    summary.push({ id, started, passed: false, error: String(e) });
    console.log("ERROR " + e);
  }
}
writeFileSync(OUT + (only.length ? "summary-partial.json" : "summary.json"), JSON.stringify({ n8n: version, ranAt: new Date().toISOString(), scenarios: summary }, null, 2));
