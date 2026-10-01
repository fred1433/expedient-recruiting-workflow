// Unit checks on two Code nodes, run outside n8n with the same source files the workflow
// inlines: the interpretation validator and the review-task planner (due date, priority).
//   node tests/unit.mjs   -> prints results, writes tests/results/unit.json
import { readFileSync, writeFileSync } from "node:fs";
const srcOf = (f) => readFileSync(new URL("../workflows/code/" + f, import.meta.url), "utf8");
const run = (file, nodes, input) => {
  const $ = (name) => ({ first: () => ({ json: nodes[name] }), all: () => [{ json: nodes[name] }], isExecuted: name in nodes });
  const $input = { first: () => ({ json: input[0] }), all: () => input.map((json) => ({ json })) };
  return new Function("$", "$input", srcOf(file))($, $input)[0].json;
};
const checks = [];
const check = (label, ok, detail) => { checks.push({ label, ok: !!ok, ...(detail !== undefined ? { detail } : {}) }); };

const contact = (message, extra = {}) => ({ contact: { id: "1", firstName: "Test", lastName: "Case", credentials: "M.D.", message, verifiedQmeStatus: null, ...extra }, previously: {} });
const reply = "Hello,\n\nThank you for writing to us about QME work. We would be glad to set up a first conversation and the team will propose a time.\n\nBest regards,";
const model = (o) => ({ choices: [{ message: { content: JSON.stringify({ specialty: { value: null, evidence: null }, license_states: { value: null, evidence: null }, states_not_licensed: { value: null, evidence: null }, certification_statement: { value: "not_stated", evidence: null }, intent: { value: "unclear", evidence: null }, call_availability: { value: null, evidence: null }, questions: [], ambiguities: [], proposed_reply: reply, ...o }) } }] });
const check1 = (msg, o, extra) => run("check-interpretation.js", { "Prepare interpretation": contact(msg, extra) }, [model(o)]).result;

let r = check1("I am licensed in Arizona and would like to talk.", { license_states: { value: ["CA"], evidence: "licensed in Arizona" } });
check("a state the quote does not name is dropped", r.license_states.value === null && r.flags.some((f) => /license_states/.test(f)), r.flags);
r = check1("Is QME work possible if I'm not licensed in California yet?", { license_states: { value: ["CA"], evidence: "not licensed in California yet" }, states_not_licensed: { value: ["CA"], evidence: "not licensed in California yet" } });
check("a negated state is refused as a licence and kept as 'not licensed in'", r.license_states.value === null && (r.states_not_licensed.value || []).join() === "CA", r);
r = check1("Email is the best way to reach me.", { call_availability: { value: "Email", evidence: "Email is the best way to reach me" } });
check("a channel preference is not kept as a call window", r.call_availability.value === null, r.call_availability);
r = check1("A colleague mentioned your group and I wanted to see what you offer.", { intent: { value: "explore_qme_certification", evidence: "wanted to see what you offer" } });
check("'explore QME certification' needs a quote about QME or certification", r.intent.value === "unclear", r.intent);
r = check1("I've been a QME since 2019.", { intent: { value: "established_qme_joining", evidence: "I've been a QME since 2019" } });
check("'established QME' needs a stated current certification", r.intent.value === "unclear", r.intent);
r = check1("I like to talk.", { license_states: { value: "CA", evidence: "I like to talk" } });
check("a non-array state value from an unrelated quote is dropped", r.license_states.value === null);
r = check1("I'm licensed in Arizona. Is QME work possible if I'm not licensed in California yet?", { license_states: { value: ["AZ"], evidence: "I'm licensed in Arizona" }, states_not_licensed: { value: ["CA"], evidence: "not licensed in California yet" }, ambiguities: ["Whether they already have any California licensure", "Whether they plan to apply for a California license", "Whether they are already QME certified"] });
check("a question about licensure the message already answered is dropped, a question about plans is kept", r.ambiguities.length === 2 && /plan/.test(r.ambiguities[0]), r.ambiguities);
let threw = null;
try { run("check-interpretation.js", { "Prepare interpretation": contact("I would like to talk about QME work.") }, [model({ proposed_reply: "Best regards," })]); } catch (e) { threw = e.message; }
check("a reply with no content fails the attempt, even though a signature would be added", /No usable proposed reply/.test(threw || ""), threw);

// Planner: due dates and priority.
const cfg = { taskMarker: "expedient-inquiry-review", dueHourLocal: 10, timeZone: "America/Los_Angeles", recruitingOwnerId: "900001" };
const baseResult = { review_status: "ready_for_review", specialty: { value: null }, license_states: { value: null }, states_not_licensed: { value: null }, certification_statement: { value: "not_stated" }, intent: { value: "unclear" }, call_availability: { value: null }, ambiguities: [], proposed_reply: "Hello,\n\nText.\n\nBest regards,\n[Your name], Expedient recruiting" };
const plan = (now, tasks = [], result = baseResult) => run("plan-review-task.js", {
  Configuration: { cfg: { ...cfg, now }, submission_key: "1:1", conversion_at: now },
  "Prepare interpretation": { contact: { id: "1", firstName: "T", lastName: "C", credentials: "M.D.", message: "m" }, result },
}, [{ results: tasks }]);
const due = (now) => new Date(plan(now).request.properties.hs_timestamp);
const la = (d) => new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
let d = due("2026-10-05T01:00:00Z"); // Sunday Oct 4, 6 p.m. Pacific
check("Sunday 6 p.m. Pacific is due Monday 10:00 Pacific", la(d) === "Mon, Oct 5, 10:00", la(d));
d = due("2026-12-01T18:00:00Z"); // Tuesday Dec 1, 10 a.m. Pacific (PST)
check("Tuesday Dec 1, 10 a.m. Pacific is due Wednesday Dec 2, 10:00 Pacific", la(d) === "Wed, Dec 2, 10:00", la(d));
d = due("2026-10-03T03:00:00Z"); // Friday Oct 2, 8 p.m. Pacific
check("Friday evening Pacific is due Monday 10:00 Pacific", la(d) === "Mon, Oct 5, 10:00", la(d));
const open = { id: "9", properties: { hs_task_body: "<p>x expedient-inquiry-review ref:1:0</p>", hs_task_status: "NOT_STARTED", hs_task_priority: "HIGH" } };
let p = plan("2026-10-05T01:00:00Z", [open]);
check("an ordinary append sends no priority (a High task stays High)", p.action === "appended" && !("hs_task_priority" in p.request.properties), p.request.properties);
p = plan("2026-10-05T01:00:00Z", [open], { ...baseResult, review_status: "conflict_with_verified_record" });
check("an append that brings a conflict raises priority to High", p.request.properties.hs_task_priority === "HIGH");

const passed = checks.filter((c) => c.ok).length;
for (const c of checks) console.log((c.ok ? "ok   " : "FAIL ") + c.label + (c.ok ? "" : " " + JSON.stringify(c.detail)));
console.log(`${passed} of ${checks.length} unit checks passed`);
writeFileSync(new URL("./results/unit.json", import.meta.url), JSON.stringify({ ranAt: new Date().toISOString(), passed, total: checks.length, checks }, null, 2));
if (passed !== checks.length) process.exit(1);
