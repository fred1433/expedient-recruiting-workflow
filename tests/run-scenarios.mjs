// Runs every scenario against the local bench (n8n + Postgres + HubSpot simulator) and writes
// tests/results/<scenario>.json plus tests/results/summary.json. Model calls are real calls to
// the configured provider, forwarded unchanged by the simulator so they can be recorded.
//   node tests/run-scenarios.mjs [scenarioId ...]
import { writeFileSync, mkdirSync } from "node:fs";
import { sim, pollNow, settle, resetLedger, ledger, events, executions, sleep, compose, N8N, env } from "./lib.mjs";
import { people, ortizExisting, ramanWithTasks } from "./fixtures.mjs";

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
const submit = (p, at, event) => sim("/__sim/submit", { ...p, ...(at ? { at } : {}), ...(event ? { event } : {}) });
const done = () => ledger().every((r) => r.status === "done" || r.status === "failed");

// Poll, let executions finish, repeat until every submission is done or given up.
async function drive({ maxRounds = 14, until = null } = {}) {
  for (let i = 0; i < maxRounds; i++) {
    await pollNow();
    await sleep(1200);
    await settle();
    if (until ? until() : ledger().length && done()) return;
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
const text = (html) => String(html || "").replace(/<br>/g, "\n").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
// Sections of a task body (one per inquiry), and the proposed reply of each.
const sections = (task) => String(task?.properties.hs_task_body || "").split("<hr>");
const replyIn = (section) => { const m = /<b>Proposed reply<\/b>[^<]*<br>([\s\S]*?)<\/p>/.exec(section); return m ? text(m[1]) : ""; };
const replyBody = (reply) => reply.replace(/^\s*(Dear[^,\n]*|Hello),/, "").replace(/Best regards,[\s\S]*$/, "").trim();
const reading = (s, i = 0) => (s.ledger[i] && s.ledger[i].model_result) || {};
const STATE_QUESTION = /(which|what) states?\b|states? (where|in which) you|license states?|state licen[cs]e|where you are licensed|where you're licensed|(hold|have) (a|an active|a current) California (medical )?licen/i;
const CONTACT_QUESTION = /phone number|(your|best|a) (phone|contact) (number|details)|e-?mail address|your (full )?name/i;

// Checks applied to every scenario that produced a task.
function replyChecks(s) {
  const out = [];
  if (!s.tasks.length) return out;
  const replies = s.tasks.flatMap(sections).map(replyIn).filter(Boolean);
  out.push(check("every proposed reply has at least two sentences of content", replies.length && replies.every((r) => replyBody(r).length >= 80 && (replyBody(r).match(/[.?!](\s|$)/g) || []).length >= 2)));
  out.push(check("every proposed reply is signed [Your name], Expedient recruiting", replies.every((r) => /Best regards,\n\[Your name\], Expedient recruiting\s*$/.test(r))));
  out.push(check("no proposed reply asks for phone, email or name", replies.every((r) => !CONTACT_QUESTION.test(r.replaceAll("[Your name]", "")))));
  return out;
}

const scenarios = {
  async ordinary() {
    await fresh();
    await submit(people.raman);
    await drive();
    const s = await snapshot();
    const t = s.tasks[0]?.properties || {};
    const r = reading(s);
    return { s, checks: [
      check("exactly one review task", s.tasks.length === 1),
      check("task associated to the contact", (s.assoc[s.contacts[0].id] || []).length === 1),
      check("task assigned to the recruiting owner", t.hubspot_owner_id === "900001"),
      check("due the next weekday at 10:00 in Los Angeles", (() => { const d = new Date(t.hs_timestamp); const h = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).format(d); return /^(Mon|Tue|Wed|Thu|Fri) 10:00$/.test(h); })(), t.hs_timestamp),
      check("complete inquiry routed as ready for review", r.review_status === "ready_for_review", r.review_status),
      check("specialty read from the message", /psychiatr/i.test(r.specialty?.value || ""), r.specialty),
      check("licensed in CA, quoted", (r.license_states?.value || []).join() === "CA", r.license_states),
      check("certification read as not yet certified", r.certification_statement?.value === "says_not_certified", r.certification_statement),
      check("call window is Thursday afternoons", /thursday/i.test(r.call_availability?.value || ""), r.call_availability),
      check("one model call, sent only credentials, message, the known-to-team flag and earlier statements", s.modelCalls.length === 1 && s.modelCalls[0].fieldsSent.join(",") === "credentials,message,known_to_team,previously_stated", s.modelCalls.map((m) => m.fieldsSent)),
      check("no email sent (no email or communication endpoint called)", !s.http.some((e) => /emails|communications/.test(e.path))),
    ] };
  },
  async established() {
    await fresh();
    await submit(people.okoye);
    await drive();
    const s = await snapshot();
    const r = reading(s);
    return { s, checks: [
      check("exactly one review task", s.tasks.length === 1),
      check("intent read as an established QME", r.intent?.value === "established_qme_joining", r.intent),
      check("certification read as currently certified", r.certification_statement?.value === "says_certified_qme", r.certification_statement),
      check("email preference not mistaken for a call window", !r.call_availability?.value, r.call_availability),
    ] };
  },
  async sparse() {
    await fresh();
    await submit(people.bell);
    await drive();
    const s = await snapshot();
    const r = reading(s);
    const reply = replyIn(sections(s.tasks[0])[0]);
    return { s, checks: [
      check("no model call for a one-word message", s.modelCalls.length === 0),
      check("review status: needs information", r.review_status === "needs_information"),
      check("specialty, states, certification, intent and call window all left as not stated", !r.specialty.value && !r.license_states.value && r.certification_statement.value === "not_stated" && r.intent.value === "unclear" && !r.call_availability.value),
      check("one review task whose reply asks for specialty, licensed states and QME status", s.tasks.length === 1 && /specialty/i.test(reply) && /licensed/i.test(reply) && /QME/.test(reply)),
    ] };
  },
  async outOfState() {
    await fresh();
    await submit(people.park);
    await drive();
    const s = await snapshot();
    const r = reading(s);
    const reply = replyIn(sections(s.tasks[0])[0]);
    return { s, checks: [
      check("not rejected: a review task exists", s.tasks.length === 1),
      check("licensed in AZ and NV, quoted", (r.license_states?.value || []).sort().join() === "AZ,NV", r.license_states),
      check("says not licensed in California, quoted", (r.states_not_licensed?.value || []).join() === "CA", r.states_not_licensed),
      check("routed to clarification", r.review_status === "needs_clarification", r.review_status),
      check("the reply does not ask whether she holds a California license", !STATE_QUESTION.test(reply), reply),
    ] };
  },
  async conflict() {
    await fresh({ contacts: [ortizExisting] });
    const before = (await sim("/__sim/state")).contacts[0];
    await submit(people.ortiz);
    await drive();
    const s = await snapshot();
    const after = s.contacts[0].properties;
    const r = reading(s);
    const reply = replyIn(sections(s.tasks[0])[0]);
    s.before = before;
    return { s, checks: [
      check("verified QME status unchanged", after.expedient_qme_status_verified === "certified_qme"),
      check("contact owner unchanged", after.hubspot_owner_id === "900002"),
      check("lifecycle stage unchanged", after.lifecyclestage === "opportunity"),
      check("conflict flagged for review", r.review_status === "conflict_with_verified_record", r.review_status),
      check("task raised to high priority", s.tasks[0]?.properties.hs_task_priority === "HIGH"),
      check("lapsed certification read as lapsed", r.certification_statement?.value === "says_lapsed", r.certification_statement),
      check("read as a former QME looking to return, not an established one", r.intent?.value === "returning_qme", r.intent),
      check("the reply does not offer work before the certification is current", !/(in the meantime|while you (are )?(retak|wait|prepar))[^.]{0,80}(work|evaluat|cases|assign)/i.test(reply) && !/you (can|could) (still )?(work|start|take)/i.test(reply), reply),
      check("the reply does not ask for background the team already holds", !/(specialty|license state|state licen|where you are licensed|certification history)/i.test(reply), reply),
    ] };
  },
  async unclear() {
    await fresh();
    await submit(people.liu);
    await drive();
    const s = await snapshot();
    const r = reading(s);
    return { s, checks: [
      check("routed to clarification", r.review_status === "needs_clarification", r.review_status),
      check("no certification status invented", r.certification_statement?.value === "not_stated", r.certification_statement),
      check("not read as exploring QME certification", r.intent?.value !== "explore_qme_certification", r.intent),
      check("no state invented", !r.license_states?.value, r.license_states),
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
      check("email preference not mistaken for a call window", !reading(s).call_availability?.value, reading(s).call_availability),
    ] };
  },
  async samePhysicianAgain() {
    await fresh();
    await submit(people.raman, Date.now() - 3 * 3600e3);
    await drive();
    await submit(people.raman2);
    await drive();
    const s = await snapshot();
    const secs = sections(s.tasks[0]);
    const second = reading(s, 1);
    return { s, checks: [
      check("both inquiries recorded and done", s.ledger.length === 2 && s.ledger.every((r) => r.status === "done")),
      check("the second inquiry was interpreted, not skipped", s.modelCalls.length === 2),
      check("still one open review task for this physician", s.tasks.length === 1),
      check("second inquiry added to that task", s.ledger[1]?.task_action === "appended" && secs.length === 2 && /New inquiry from the same physician/.test(secs[1])),
      check("second inquiry read as certification in progress", second.certification_statement?.value === "says_in_progress", second.certification_statement),
      check("the second reply does not ask for the state she already gave", !STATE_QUESTION.test(replyIn(secs[1] || "")), replyIn(secs[1] || "")),
    ] };
  },
  async payloadFrozen() {
    // A is interpreted, its task fails; B arrives from the same physician before the retry.
    await fresh({}, [{ method: "POST", path: "^/crm/v3/objects/tasks$", mode: "error", status: 502, times: 1 }]);
    await submit(people.raman, Date.now() - 600e3);
    await pollNow(); await sleep(1200); await settle();
    const afterA = ledger();
    await submit(people.raman2);
    await drive();
    const s = await snapshot();
    s.ledgerAfterFirstAttempt = afterA;
    const secs = sections(s.tasks[0]);
    const a = s.ledger[0], b = s.ledger[1];
    return { s, checks: [
      check("A's task creation failed on the first attempt", afterA[0]?.status === "retry", afterA[0]?.status),
      check("A's retry used A's own words, not B's", /haven't taken the course/.test(secs[0] || "") && !/signed up for the QME course/.test(secs[0] || "")),
      check("B's inquiry carries B's words", /signed up for the QME course/.test(secs[1] || "")),
      check("A's frozen payload is A's message", /haven't taken the course/.test(a?.payload?.message || "")),
      check("A's saved reading quotes A's message", JSON.stringify(a?.model_result || {}).includes("haven't taken the course") || !a?.model_result?.certification_statement?.evidence),
      check("one model call per submission", s.modelCalls.length === 2),
      check("one review task, B appended after A", s.tasks.length === 1 && b?.task_action === "appended"),
    ] };
  },
  async taskFailsAfterUpdate() {
    await fresh({}, [{ method: "POST", path: "^/crm/v3/objects/tasks$", mode: "error", status: 502, times: 1 }]);
    await submit(people.park);
    await drive();
    const s = await snapshot();
    const reply = replyIn(sections(s.tasks[0])[0]);
    return { s, checks: [
      check("first task creation failed (502)", s.http.some((e) => e.method === "POST" && /objects\/tasks$/.test(e.path) && e.status === 502)),
      check("contact updated once, not again on retry", count(s.http, "PATCH", /contacts/) === 1),
      check("model called once, the saved reading reused", s.modelCalls.length === 1),
      check("one review task in the end", s.tasks.length === 1),
      check("finished on attempt 2", s.ledger[0].status === "done" && s.ledger[0].attempts === 2),
      check("says not licensed in California, and the reply does not ask about it", (reading(s).states_not_licensed?.value || []).includes("CA") && !STATE_QUESTION.test(reply), reply),
    ] };
  },
  async searchDownDuringRetry() {
    // The first poll works; every later contact search fails. The retry must still happen.
    await fresh({}, [
      { method: "POST", path: "^/crm/v3/objects/tasks$", mode: "error", status: 502, times: 1 },
      { method: "POST", path: "contacts/search$", mode: "error", status: 503, skip: 1, times: -1 },
    ]);
    await submit(people.okoye);
    await drive();
    const s = await snapshot();
    return { s, checks: [
      check("contact search failed on the later polls", s.http.some((e) => /contacts\/search$/.test(e.path) && e.status === 503)),
      check("the failure was logged by the poller", s.events.some((e) => e.step === "search" && e.outcome === "failed")),
      check("the retry still ran and finished", s.ledger[0].status === "done" && s.ledger[0].attempts === 2),
      check("one review task", s.tasks.length === 1),
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
      check("not read as exploring QME certification", reading(s).intent?.value !== "explore_qme_certification", reading(s).intent),
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
  async staleWorker() {
    // Attempt 1 waits on the model past its lease; attempt 2 takes over and finishes.
    await fresh({}, [{ method: "POST", path: "^/v1/chat/completions$", mode: "delay", delayMs: 54000, times: 1 }]);
    await submit(people.okoye);
    await pollNow();
    await sleep((LEASE + 4) * 1000);
    await pollNow();
    await sleep(1500);
    await settle({ timeoutMs: 120000 });
    const s = await snapshot();
    return { s, checks: [
      check("a second attempt took over after the first one's lease expired", s.ledger[0].attempts === 2 && s.ledger[0].status === "done"),
      check("the stalled attempt stopped when it woke up, without writing", s.events.some((e) => e.step === "lease" && e.outcome === "lost")),
      check("one contact update and one task: the stalled attempt wrote nothing to HubSpot", count(s.http, "PATCH", /contacts/) === 1 && s.tasks.length === 1),
    ] };
  },
  async paging() {
    // Six form conversions in the window, three of them from another form; pages of two.
    await fresh();
    const t = Date.now() - 300e3;
    await submit({ email: "w1@example.test", firstname: "Ana", lastname: "Webb" }, t, "Webinar registration");
    await submit({ email: "w2@example.test", firstname: "Ben", lastname: "Webb" }, t + 1000, "Webinar registration");
    await submit(people.raman, t + 2000);
    await submit({ email: "w3@example.test", firstname: "Cy", lastname: "Webb" }, t + 3000, "Webinar registration");
    await submit(people.okoye, t + 4000);
    await submit(people.bell, t + 5000);
    await drive();
    const s = await snapshot();
    const scan = s.events.find((e) => e.step === "scan");
    return { s, checks: [
      check("all six conversions scanned across three pages", /scanned 6 contacts on 3 page/.test(scan?.detail || ""), scan?.detail),
      check("only the three join inquiries recorded", s.ledger.length === 3),
      check("three review tasks, none for the webinar contacts", s.tasks.length === 3 && !s.tasks.some((x) => /Webb/.test(x.properties.hs_task_subject))),
    ] };
  },
  async taskBeyondFirstPage() {
    // The open review task is the third association; pages of one.
    await fresh(ramanWithTasks);
    await submit(people.raman);
    await drive();
    const s = await snapshot();
    const open = s.tasks.find((x) => x.id === "5003");
    return { s, checks: [
      check("associations read across three pages", count(s.http, "GET", /associations\/tasks/) >= 3, count(s.http, "GET", /associations\/tasks/)),
      check("the inquiry was added to the open task found on the last page", s.ledger[0].task_action === "appended" && s.ledger[0].task_id === "5003"),
      check("no new task created", s.tasks.length === 3),
      check("the High priority set by a person was kept", open?.properties.hs_task_priority === "HIGH", open?.properties.hs_task_priority),
    ] };
  },
  async emptyReply() {
    await fresh({}, [{ method: "POST", path: "^/v1/chat/completions$", mode: "blank_reply", times: -1 }]);
    await submit(people.liu);
    await drive({ maxRounds: 20 });
    const s = await snapshot();
    return { s, checks: [
      check("a model answer without a usable reply fails the attempt", /no usable proposed reply/.test(s.ledger[0].last_error || ""), s.ledger[0].last_error),
      check(`stopped after ${MAX} attempts`, s.ledger[0].status === "failed" && s.ledger[0].attempts === MAX),
      check("no task and no contact update written", s.tasks.length === 0 && count(s.http, "PATCH", /contacts/) === 0),
    ] };
  },
  async contactReadsFail() {
    await fresh({}, [{ method: "GET", path: "^/crm/v3/objects/contacts/\\d+$", mode: "error", status: 503, times: -1 }]);
    await submit(people.raman);
    await drive({ maxRounds: 20 });
    const s = await snapshot();
    const alert = JSON.stringify(s.alerts);
    return { s, checks: [
      check(`stopped after ${MAX} attempts`, s.ledger[0].status === "failed" && s.ledger[0].attempts === MAX, s.ledger[0].attempts),
      check("one failure alert delivered and recorded", s.alerts.length === 1 && s.ledger[0].alerted),
      check("alert carries no message text, name or email", !/psychiatrist|Raman|Priya|example\.test/.test(alert)),
      check("failed executions visible in n8n", s.executions.some((e) => e.status === "error")),
      check("nothing written to HubSpot", count(s.http, "PATCH", /./) === 0 && count(s.http, "POST", /objects\/tasks/) === 0),
    ] };
  },
  async alertFails() {
    // Contact reads keep failing, and the alert endpoint refuses the first three deliveries.
    await fresh({}, [
      { method: "GET", path: "^/crm/v3/objects/contacts/\\d+$", mode: "error", status: 503, times: -1 },
      { method: "POST", path: "^/hooks/alert$", mode: "error", status: 500, times: 3 },
    ]);
    await submit(people.liu);
    await drive({ maxRounds: 20 });
    const afterGiveUp = ledger();
    await drive({ maxRounds: 30, until: () => ledger()[0]?.alerted });
    const s = await snapshot();
    s.ledgerAfterGiveUp = afterGiveUp;
    const hooks = s.http.filter((e) => e.path === "/hooks/alert");
    return { s, checks: [
      check("the first alert delivery failed and was not recorded as sent", afterGiveUp[0]?.status === "failed" && !afterGiveUp[0]?.alerted),
      check("delivery retried until the endpoint accepted it", hooks.filter((h) => h.status === 500).length === 3 && hooks.some((h) => h.status === 200)),
      check("recorded as sent only after the acknowledged delivery", s.ledger[0].alerted && s.alerts.length === 1),
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
    checks.push(...replyChecks(s));
    const passed = checks.every((c) => c.ok);
    writeFileSync(OUT + id + ".json", JSON.stringify({ id, started, n8n: version, checks, ...s }, null, 2));
    summary.push({ id, started, passed, checks });
    console.log(passed ? "pass" : "FAIL " + JSON.stringify(checks.filter((c) => !c.ok)).slice(0, 900));
  } catch (e) {
    summary.push({ id, started, passed: false, error: String(e) });
    console.log("ERROR " + e);
  }
}
writeFileSync(OUT + (only.length ? "summary-partial.json" : "summary.json"), JSON.stringify({ n8n: version, ranAt: new Date().toISOString(), scenarios: summary }, null, 2));
