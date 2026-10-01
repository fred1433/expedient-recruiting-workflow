// Generates workflows/*.json (n8n 2.42.2 export format). The Code nodes live as plain
// JavaScript in workflows/code/ so they can be reviewed and unit-tested; this script inlines
// them. Run: node scripts/build-workflows.mjs

import { writeFileSync, readFileSync } from "node:fs";

const POLLER_ID = "ExpInqPoller0001";
const PROCESS_ID = "ExpInqProcess001";
const ERROR_ID = "ExpInqErrAlert01";
const CRED_HUBSPOT = { id: "ExpHubspotTok001", name: "HubSpot private app token" };
const CRED_MODEL = { id: "ExpModelKey00001", name: "Model API key (Authorization: Bearer)" };
const CRED_PG = { id: "ExpPostgres00001", name: "Postgres (recruiting ledger)" };

const SYSTEM_PROMPT = readFileSync(new URL("../workflows/model-instructions.txt", import.meta.url), "utf8").trim();
const src = (f) => readFileSync(new URL("../workflows/code/" + f, import.meta.url), "utf8").replace("__SYSTEM_PROMPT__", JSON.stringify(SYSTEM_PROMPT));

let x = 0;
const pos = (col, row) => [col * 260, row * 180];
function node(name, type, typeVersion, parameters, extra = {}) {
  return { parameters, id: `n${String(++x).padStart(3, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 36), name, type, typeVersion, ...extra };
}
const hubspotHttp = (name, method, url, body, at, extra = {}, options = {}) =>
  node(name, "n8n-nodes-base.httpRequest", 4.2, {
    method,
    url,
    authentication: "predefinedCredentialType",
    nodeCredentialType: "hubspotAppToken",
    ...(body ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
    options: { timeout: 20000, ...options },
  }, { position: at, credentials: { hubspotAppToken: CRED_HUBSPOT }, retryOnFail: true, maxTries: 3, waitBetweenTries: 1500, onError: "continueErrorOutput", ...extra });
const pg = (name, query, params, at, extra = {}) =>
  node(name, "n8n-nodes-base.postgres", 2.6, { operation: "executeQuery", query, options: { queryReplacement: params } },
    { position: at, credentials: { postgres: CRED_PG }, ...extra });
const code = (name, file, at, extra = {}) => node(name, "n8n-nodes-base.code", 2, { jsCode: src(file) }, { position: at, ...extra });
const ifTrue = (name, expr, at) =>
  node(name, "n8n-nodes-base.if", 2.2, {
    conditions: {
      options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
      conditions: [{ id: "c1", leftValue: expr, rightValue: "", operator: { type: "boolean", operation: "true", singleValue: true } }],
      combinator: "and",
    },
    options: {},
  }, { position: at });
function connect(conns, from, to, outIndex = 0) {
  conns[from] ??= { main: [] };
  while (conns[from].main.length <= outIndex) conns[from].main.push([]);
  conns[from].main[outIndex].push({ node: to, type: "main", index: 0 });
}
const alertNode = (name, textExpr, at) => node(name, "n8n-nodes-base.httpRequest", 4.2, {
  method: "POST",
  url: "={{ $env.ALERT_WEBHOOK_URL }}",
  sendBody: true,
  specifyBody: "json",
  jsonBody: textExpr,
  options: { timeout: 10000 },
}, { position: at, onError: "continueErrorOutput" });
const ALERT_BODY = (lead) => `={{ JSON.stringify({ text: 'Physician inquiry workflow: submission ' + $json.submission_key + ' ${lead} ' + $json.attempts + ' attempts (last error: ' + ($json.last_error || 'interrupted') + '). Contact record ' + $json.contact_id + '. Nothing was sent to the physician. Check the execution and the ledger.', submission_key: $json.submission_key, contact_id: $json.contact_id, last_error: $json.last_error, attempts: $json.attempts }) }}`;
const MARK_ALERTED = `with u as (update recruiting.inquiry_ledger set alerted_at = now(), alert_last_error = null, updated_at = now()
   where submission_key = $1 returning submission_key)
insert into recruiting.event_log (submission_key, step, outcome) select submission_key, 'alert', 'delivered' from u
returning submission_key`;
const MARK_ALERT_PENDING = `with u as (update recruiting.inquiry_ledger
     set alert_attempts = alert_attempts + 1, alert_last_error = $2,
         alert_next_at = now() + make_interval(secs => least(3600, $3 * power(2, alert_attempts))::int), updated_at = now()
   where submission_key = $1 returning submission_key, alert_attempts)
insert into recruiting.event_log (submission_key, step, outcome, detail)
select submission_key, 'alert', 'not delivered', $2 || ' (try ' || alert_attempts || ', will retry)' from u
returning submission_key`;
// Renews the lease only if this execution still owns it (same token, still processing).
const OWNER_CHECK = `with u as (
  update recruiting.inquiry_ledger set lease_until = now() + make_interval(secs => $3), updated_at = now()
   where submission_key = $1 and lease_token = $2::uuid and status = 'processing'
  returning 1)
select exists (select 1 from u) as owner`;
const OWNER_PARAMS = "={{ [ $('Configuration').first().json.submission_key, $('Configuration').first().json.lease_token, $('Configuration').first().json.cfg.leaseSeconds ] }}";
const KEY = "$('Configuration').first().json.submission_key";
const TOKEN = "$('Configuration').first().json.lease_token";

// ---------------------------------------------------------------------------------------
// Sub-workflow: process ONE submission. Every external call is resumable from the ledger.
// ---------------------------------------------------------------------------------------
function buildProcess() {
  x = 0;
  const N = [], C = {};
  N.push(node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, { inputSource: "passthrough" }, { position: pos(0, 2) }));
  N.push(code("Configuration", "configuration.js", pos(1, 2)));
  connect(C, "Start", "Configuration");

  N.push(pg("Take the lease", OWNER_CHECK, OWNER_PARAMS, pos(2, 2), { alwaysOutputData: true }));
  connect(C, "Configuration", "Take the lease");
  N.push(ifTrue("Owner at start?", "={{ $json.owner === true }}", pos(3, 2)));
  connect(C, "Take the lease", "Owner at start?");
  N.push(pg("Lease lost", `insert into recruiting.event_log (submission_key, step, outcome, detail)
values ($1, 'lease', 'lost', 'another attempt owns this submission; this one stopped without writing') returning id`,
    `={{ [ ${KEY} ] }}`, pos(4, 5)));
  connect(C, "Owner at start?", "Lease lost", 1);

  N.push(hubspotHttp("Read contact", "GET",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/contacts/{{ $('Configuration').first().json.contact_id }}?properties={{ [$('Configuration').first().json.cfg.props.verifiedQmeStatus, 'hubspot_owner_id', 'lifecyclestage'].join(',') }}",
    null, pos(4, 2)));
  connect(C, "Owner at start?", "Read contact", 0);

  N.push(pg("Still the owner?", OWNER_CHECK, OWNER_PARAMS, pos(5, 2), { alwaysOutputData: true }));
  connect(C, "Read contact", "Still the owner?", 0);
  N.push(ifTrue("Owner after reading?", "={{ $json.owner === true }}", pos(6, 2)));
  connect(C, "Still the owner?", "Owner after reading?");
  connect(C, "Owner after reading?", "Lease lost", 1);

  N.push(pg("Earlier readings", `select model_result from recruiting.inquiry_ledger
 where contact_id = $1 and submission_key <> $2 and conversion_at < $3::timestamptz and model_result is not null
 order by conversion_at desc limit 3`,
    `={{ [ $('Configuration').first().json.contact_id, ${KEY}, $('Configuration').first().json.conversion_at ] }}`, pos(7, 2), { alwaysOutputData: true }));
  connect(C, "Owner after reading?", "Earlier readings", 0);

  N.push(code("Prepare interpretation", "prepare-interpretation.js", pos(8, 2)));
  connect(C, "Earlier readings", "Prepare interpretation");
  N.push(ifTrue("Model needed?", "={{ $json.needsModel }}", pos(9, 2)));
  connect(C, "Prepare interpretation", "Model needed?");

  N.push(node("Ask the model", "n8n-nodes-base.httpRequest", 4.2, {
    method: "POST",
    url: "={{ $('Configuration').first().json.cfg.modelBase }}/v1/chat/completions",
    authentication: "genericCredentialType",
    genericAuthType: "httpHeaderAuth",
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify($json.modelRequest) }}",
    options: { timeout: 60000 },
  }, { position: pos(10, 1), credentials: { httpHeaderAuth: CRED_MODEL }, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: "continueErrorOutput" }));
  connect(C, "Model needed?", "Ask the model", 0);

  N.push(code("Check the interpretation", "check-interpretation.js", pos(11, 1), { onError: "continueErrorOutput" }));
  connect(C, "Ask the model", "Check the interpretation", 0);

  N.push(pg("Save interpretation", `with u as (
  update recruiting.inquiry_ledger
     set model_result = coalesce(model_result, $2::jsonb), last_step = 'interpreted', updated_at = now()
   where submission_key = $1 and lease_token = $5::uuid
  returning submission_key)
insert into recruiting.event_log (submission_key, step, outcome, detail)
select submission_key, 'interpret', $3, $4 from u
returning submission_key`,
    `={{ [ ${KEY}, JSON.stringify($json.result), $('Prepare interpretation').first().json.reused ? 'reused' : 'saved', $json.result.source + ':' + $json.result.review_status, ${TOKEN} ] }}`,
    pos(12, 2)));
  connect(C, "Check the interpretation", "Save interpretation", 0);
  connect(C, "Model needed?", "Save interpretation", 1);

  N.push(pg("Owner before writing?", OWNER_CHECK, OWNER_PARAMS, pos(12, 3), { alwaysOutputData: true }));
  connect(C, "Save interpretation", "Owner before writing?");
  N.push(ifTrue("Still owner to write?", "={{ $json.owner === true }}", pos(12, 4)));
  connect(C, "Owner before writing?", "Still owner to write?");
  connect(C, "Still owner to write?", "Lease lost", 1);
  N.push(ifTrue("Suggestions already written?", "={{ $('Configuration').first().json.suggestions_written === true }}", pos(13, 2)));
  connect(C, "Still owner to write?", "Suggestions already written?", 0);
  N.push(code("Suggestion fields", "suggestion-fields.js", pos(14, 1)));
  connect(C, "Suggestions already written?", "Suggestion fields", 1);
  N.push(hubspotHttp("Write suggestions to contact", "PATCH",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/contacts/{{ $('Configuration').first().json.contact_id }}",
    "={{ JSON.stringify({ properties: $json.properties }) }}", pos(15, 1)));
  connect(C, "Suggestion fields", "Write suggestions to contact");
  N.push(pg("Mark suggestions written", `with u as (
  update recruiting.inquiry_ledger set suggestions_written = true, last_step = 'suggestions_written', updated_at = now()
   where submission_key = $1 and lease_token = $2::uuid returning submission_key)
insert into recruiting.event_log (submission_key, step, outcome) select submission_key, 'suggestions', 'written' from u
returning submission_key`, `={{ [ ${KEY}, ${TOKEN} ] }}`, pos(16, 1)));
  connect(C, "Write suggestions to contact", "Mark suggestions written", 0);

  N.push(ifTrue("Task already recorded?", "={{ !!$('Configuration').first().json.task_id }}", pos(17, 2)));
  connect(C, "Mark suggestions written", "Task already recorded?");
  connect(C, "Suggestions already written?", "Task already recorded?", 0);

  N.push(pg("Owner before the task?", OWNER_CHECK, OWNER_PARAMS, pos(18, 3), { alwaysOutputData: true }));
  connect(C, "Task already recorded?", "Owner before the task?", 1);
  N.push(ifTrue("Still owner for the task?", "={{ $json.owner === true }}", pos(19, 3)));
  connect(C, "Owner before the task?", "Still owner for the task?");
  connect(C, "Still owner for the task?", "Lease lost", 1);

  N.push(hubspotHttp("List the contact's tasks", "GET",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v4/objects/contacts/{{ $('Configuration').first().json.contact_id }}/associations/tasks?limit={{ $('Configuration').first().json.cfg.assocPageSize }}",
    null, pos(20, 3), {}, {
      pagination: { pagination: {
        parameters: { parameters: [{ type: "qs", name: "after", value: "={{ $response.body.paging?.next?.after }}" }] },
        paginationCompleteWhen: "other",
        completeExpression: "={{ !$response.body.paging?.next?.after }}",
        limitPagesFetched: true, maxRequests: 50,
      } },
    }));
  connect(C, "Still owner for the task?", "List the contact's tasks", 0);
  N.push(code("Task ids", "task-ids.js", pos(21, 3)));
  connect(C, "List the contact's tasks", "Task ids", 0);
  N.push(ifTrue("Any tasks?", "={{ $json.ids.length > 0 }}", pos(22, 3)));
  connect(C, "Task ids", "Any tasks?");
  N.push(hubspotHttp("Read those tasks", "POST",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/tasks/batch/read",
    "={{ JSON.stringify({ inputs: $json.ids.map(id => ({ id })), properties: ['hs_task_subject','hs_task_body','hs_task_status','hs_task_priority','hs_timestamp','hubspot_owner_id'] }) }}",
    pos(23, 2)));
  connect(C, "Any tasks?", "Read those tasks", 0);

  N.push(code("Plan the review task", "plan-review-task.js", pos(24, 3)));
  connect(C, "Read those tasks", "Plan the review task", 0);
  connect(C, "Any tasks?", "Plan the review task", 1);

  N.push(node("Route by action", "n8n-nodes-base.switch", 3.2, {
    mode: "expression", numberOutputs: 3,
    output: "={{ ({ created: 0, appended: 1, reconciled: 2 })[$json.action] }}",
  }, { position: pos(25, 3) }));
  connect(C, "Plan the review task", "Route by action");
  N.push(hubspotHttp("Create review task", "POST",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/tasks",
    "={{ JSON.stringify($json.request) }}", pos(26, 2),
    // Creating is not idempotent: no blind in-node retry. A failed or unanswered create is
    // retried by the ledger on the next attempt, which first looks for the task by reference.
    { retryOnFail: false }));
  N.push(hubspotHttp("Add inquiry to open task", "PATCH",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/tasks/{{ $json.taskId }}",
    "={{ JSON.stringify($json.request) }}", pos(26, 3)));
  connect(C, "Route by action", "Create review task", 0);
  connect(C, "Route by action", "Add inquiry to open task", 1);

  N.push(node("Task outcome", "n8n-nodes-base.code", 2, { jsCode: `const plan = $('Plan the review task').first().json;
const id = $input.first().json.id ? String($input.first().json.id) : plan.taskId;
return [{ json: { task_id: id, task_action: plan.action } }];` }, { position: pos(27, 3) }));
  connect(C, "Create review task", "Task outcome", 0);
  connect(C, "Add inquiry to open task", "Task outcome", 0);
  connect(C, "Route by action", "Task outcome", 2);

  N.push(pg("Mark done", `with u as (
  update recruiting.inquiry_ledger
     set status = 'done', task_id = coalesce($2, task_id), task_action = coalesce($3, task_action),
         last_step = 'done', lease_until = null, lease_token = null, completed_at = now(), updated_at = now()
   where submission_key = $1 and lease_token = $4::uuid
  returning submission_key, task_id, task_action)
insert into recruiting.event_log (submission_key, step, outcome, detail)
select submission_key, 'task', 'done', coalesce($3, 'already recorded') || ' ' || task_id from u
returning submission_key`,
    `={{ [ ${KEY}, $json.task_id || null, $json.task_action || null, ${TOKEN} ] }}`, pos(28, 2)));
  connect(C, "Task outcome", "Mark done");
  connect(C, "Task already recorded?", "Mark done", 0);

  // ---- failure path: every external call and the interpretation check route errors here ----
  N.push(code("Describe the failure", "describe-failure.js", pos(12, 5)));
  for (const n of ["Read contact", "Ask the model", "Check the interpretation", "Write suggestions to contact", "List the contact's tasks", "Read those tasks", "Create review task", "Add inquiry to open task"]) {
    connect(C, n, "Describe the failure", 1);
  }
  N.push(pg("Record the failure", `with u as (
  update recruiting.inquiry_ledger
     set status = case when attempts >= $3 then 'failed' else 'retry' end,
         next_attempt_at = now() + make_interval(secs => least(3600, $5 * power(2, greatest(attempts - 1, 0)))::int),
         alert_next_at = case when attempts >= $3 then now() + interval '60 seconds' else alert_next_at end,
         last_step = $2, last_error = $2 || ': ' || $4, lease_until = null, lease_token = null, updated_at = now()
   where submission_key = $1 and lease_token = $6::uuid
  returning submission_key, contact_id, status, attempts, last_error),
ev as (
  insert into recruiting.event_log (submission_key, step, outcome, detail)
  select submission_key, $2, 'failed', $4 || ' (attempt ' || attempts || ', now ' || status || ')' from u)
select * from u`,
    `={{ [ ${KEY}, $json.step, $('Configuration').first().json.cfg.maxAttempts, $json.status, $('Configuration').first().json.cfg.retryBaseSeconds, ${TOKEN} ] }}`,
    pos(13, 5)));
  connect(C, "Describe the failure", "Record the failure");
  N.push(ifTrue("Out of attempts?", "={{ $json.status === 'failed' }}", pos(14, 5)));
  connect(C, "Record the failure", "Out of attempts?");
  N.push(alertNode("Send failure alert", ALERT_BODY("stopped after"), pos(15, 4)));
  connect(C, "Out of attempts?", "Send failure alert", 0);
  N.push(pg("Mark alerted", MARK_ALERTED, `={{ [ ${KEY} ] }}`, pos(16, 4)));
  N.push(pg("Mark alert pending", MARK_ALERT_PENDING,
    `={{ [ ${KEY}, 'alert endpoint: ' + String(($json.error && ($json.error.httpCode || $json.error.status)) || 'no response'), $('Configuration').first().json.cfg.retryBaseSeconds ] }}`, pos(16, 6)));
  connect(C, "Send failure alert", "Mark alerted", 0);
  connect(C, "Send failure alert", "Mark alert pending", 1);
  N.push(node("Fail visibly", "n8n-nodes-base.stopAndError", 1, {
    errorMessage: "={{ 'Step \"' + $('Describe the failure').first().json.step + '\" failed (' + $('Describe the failure').first().json.status + '). Ledger status: ' + $('Record the failure').first().json.status + '.' }}",
  }, { position: pos(17, 5) }));
  connect(C, "Mark alerted", "Fail visibly");
  connect(C, "Mark alert pending", "Fail visibly");
  connect(C, "Out of attempts?", "Fail visibly", 1);

  return {
    id: PROCESS_ID, name: "Physician inquiry: process one submission", nodes: N, connections: C,
    settings: { executionOrder: "v1", callerPolicy: "workflowsFromSameOwner", saveManualExecutions: true },
    pinData: {}, active: false, meta: { templateCredsSetupCompleted: true }, tags: [],
  };
}

// ---------------------------------------------------------------------------------------
// Poller: the single entry mechanism. Scans a bounded window of form conversions page by page,
// records each join submission once with its fields frozen, then (whether or not the search
// worked) claims due work and pending alerts.
// ---------------------------------------------------------------------------------------
function buildPoller() {
  x = 0;
  const N = [], C = {};
  N.push(node("Every 2 minutes", "n8n-nodes-base.scheduleTrigger", 1.2, { rule: { interval: [{ field: "minutes", minutesInterval: 2 }] } }, { position: pos(0, 1) }));
  N.push(node("Poll now (manual)", "n8n-nodes-base.webhook", 2, { httpMethod: "POST", path: "expedient-poll-now", responseMode: "onReceived", options: {} }, { position: pos(0, 3), webhookId: "5c1e8f0a-2b7d-4e43-9d0b-7a1f3c2e9b10" }));
  N.push(ifTrue("Token matches?", "={{ $json.headers['x-poll-token'] === $env.POLL_TRIGGER_TOKEN }}", pos(1, 3)));
  connect(C, "Poll now (manual)", "Token matches?");

  N.push(pg("Read checkpoint", `select (extract(epoch from checkpoint) * 1000)::bigint as checkpoint_ms from recruiting.poll_state where id = 1`, "={{ [] }}", pos(2, 2)));
  connect(C, "Every 2 minutes", "Read checkpoint");
  connect(C, "Token matches?", "Read checkpoint", 0);
  N.push(code("Search window", "search-window.js", pos(3, 2)));
  connect(C, "Read checkpoint", "Search window");

  N.push(hubspotHttp("Find recent form submissions", "POST",
    "={{ $env.HUBSPOT_BASE_URL }}/crm/v3/objects/contacts/search",
    "={{ JSON.stringify($json.body) }}", pos(4, 2), {}, {
      pagination: { pagination: {
        parameters: { parameters: [{ type: "body", name: "after", value: "={{ $response.body.paging?.next?.after }}" }] },
        paginationCompleteWhen: "other",
        completeExpression: "={{ !$response.body.paging?.next?.after }}",
        limitPagesFetched: true, maxRequests: 50, requestInterval: 150,
      } },
    }));
  connect(C, "Search window", "Find recent form submissions");

  N.push(code("List submissions", "list-submissions.js", pos(5, 2)));
  connect(C, "Find recent form submissions", "List submissions", 0);

  N.push(pg("Record submissions once", `with seen as (
  select * from jsonb_to_recordset($1::jsonb) as x(submission_key text, contact_id text, conversion_at timestamptz, payload jsonb)),
ins as (
  insert into recruiting.inquiry_ledger (submission_key, contact_id, conversion_at, payload)
  select submission_key, contact_id, conversion_at, payload from seen
  on conflict (submission_key) do nothing
  returning submission_key),
ev as (
  insert into recruiting.event_log (submission_key, step, outcome) select submission_key, 'poll', 'recorded' from ins),
scan as (
  insert into recruiting.event_log (submission_key, step, outcome, detail) values (null, 'scan', 'ok', $3)),
cp as (
  update recruiting.poll_state set checkpoint = greatest(checkpoint, $2::timestamptz) where id = 1 returning checkpoint)
select (select count(*) from ins) as new_submissions, (select checkpoint from cp) as checkpoint`,
    "={{ [ $json.rows, $json.checkpoint, $json.scan ] }}", pos(6, 2)));
  connect(C, "List submissions", "Record submissions once");

  N.push(pg("Note search failure", `insert into recruiting.event_log (submission_key, step, outcome, detail)
values (null, 'search', 'failed', $1) returning id`,
    "={{ [ 'contact search failed (' + String(($json.error && ($json.error.httpCode || $json.error.status)) || 'no response') + '); recorded work is still serviced' ] }}", pos(6, 4)));
  connect(C, "Find recent form submissions", "Note search failure", 1);

  N.push(pg("Claim work", `with swept as (
  -- stopped mid-processing too many times (crash, restart): give up; the alert goes out below
  update recruiting.inquiry_ledger
     set status = 'failed', last_error = coalesce(last_error, 'stopped mid-processing'), lease_token = null,
         alert_next_at = now(), updated_at = now()
   where status = 'processing' and lease_until < now() and attempts >= $2
  returning submission_key),
claimable as (
  select l.submission_key from recruiting.inquiry_ledger l
   where ((l.status in ('pending', 'retry') and l.next_attempt_at <= now())
       or (l.status = 'processing' and l.lease_until < now() and l.attempts < $2))
     and not exists (select 1 from recruiting.inquiry_ledger o
                      where o.contact_id = l.contact_id and o.submission_key <> l.submission_key
                        and o.status = 'processing' and o.lease_until >= now())
   order by l.conversion_at
   limit 5
   for update skip locked),
claimed as (
  update recruiting.inquiry_ledger l
     set status = 'processing', attempts = l.attempts + 1, lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => $1), updated_at = now()
    from claimable c
   where l.submission_key = c.submission_key
  returning l.submission_key, l.contact_id, l.conversion_at, l.attempts, l.model_result, l.suggestions_written,
            l.task_id, l.last_error, l.payload, l.lease_token::text as lease_token, 'work'::text as kind),
alerts as (
  select submission_key from recruiting.inquiry_ledger
   where status = 'failed' and alerted_at is null and coalesce(alert_next_at, now()) <= now()
   order by updated_at limit 5
   for update skip locked),
alerting as (
  update recruiting.inquiry_ledger l
     set alert_next_at = now() + interval '60 seconds'
    from alerts a where l.submission_key = a.submission_key
  returning l.submission_key, l.contact_id, l.conversion_at, l.attempts, null::jsonb as model_result, l.suggestions_written,
            l.task_id, l.last_error, null::jsonb as payload, null::text as lease_token, 'alert'::text as kind),
ev as (
  insert into recruiting.event_log (submission_key, step, outcome, detail)
  select submission_key, 'claim', 'attempt ' || attempts, coalesce('resuming after: ' || last_error, null) from claimed
  union all
  select submission_key, 'claim', 'gave up', null from swept)
select * from claimed union all select * from alerting`,
    "={{ [ Number($env.LEASE_SECONDS || 300), Number($env.MAX_ATTEMPTS || 5) ] }}", pos(7, 2)));
  connect(C, "Record submissions once", "Claim work");
  connect(C, "Note search failure", "Claim work");

  N.push(ifTrue("Alert to send?", "={{ $json.kind === 'alert' }}", pos(8, 2)));
  connect(C, "Claim work", "Alert to send?");
  N.push(node("Process each submission", "n8n-nodes-base.executeWorkflow", 1.1, {
    source: "database",
    workflowId: { __rl: true, value: PROCESS_ID, mode: "id" },
    mode: "each",
    options: { waitForSubWorkflow: true },
  }, { position: pos(9, 3), onError: "continueRegularOutput" }));
  connect(C, "Alert to send?", "Process each submission", 1);

  N.push(alertNode("Send failure alert", ALERT_BODY("is no longer retried after"), pos(9, 1)));
  connect(C, "Alert to send?", "Send failure alert", 0);
  N.push(pg("Mark alerted", MARK_ALERTED, "={{ [ $('Alert to send?').item.json.submission_key ] }}", pos(10, 0)));
  N.push(pg("Mark alert pending", MARK_ALERT_PENDING,
    "={{ [ $('Alert to send?').item.json.submission_key, 'alert endpoint: ' + String(($json.error && ($json.error.httpCode || $json.error.status)) || 'no response'), Number($env.RETRY_BASE_SECONDS || 30) ] }}", pos(10, 2)));
  connect(C, "Send failure alert", "Mark alerted", 0);
  connect(C, "Send failure alert", "Mark alert pending", 1);

  return {
    id: POLLER_ID, name: "Physician inquiry: poll HubSpot form submissions", nodes: N, connections: C,
    settings: { executionOrder: "v1", saveManualExecutions: true, errorWorkflow: ERROR_ID },
    pinData: {}, active: false, meta: { templateCredsSetupCompleted: true }, tags: [],
  };
}

// ---------------------------------------------------------------------------------------
// Error workflow: if the poller itself fails (for instance JOIN_FORM_NAME missing), say so.
// ---------------------------------------------------------------------------------------
function buildErrorAlert() {
  x = 0;
  const N = [], C = {};
  N.push(node("Workflow failed", "n8n-nodes-base.errorTrigger", 1, {}, { position: pos(0, 1) }));
  N.push(node("Send workflow alert", "n8n-nodes-base.httpRequest", 4.2, {
    method: "POST",
    url: "={{ $env.ALERT_WEBHOOK_URL }}",
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ text: 'Physician inquiry workflow: \"' + $json.workflow.name + '\" failed at node \"' + ($json.execution.lastNodeExecuted || 'unknown') + '\" (execution ' + $json.execution.id + '): ' + String(($json.execution.error && $json.execution.error.message) || '').slice(0, 160) }) }}",
    options: { timeout: 10000 },
  }, { position: pos(1, 1), retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 }));
  connect(C, "Workflow failed", "Send workflow alert");
  return {
    id: ERROR_ID, name: "Physician inquiry: workflow error alert", nodes: N, connections: C,
    settings: { executionOrder: "v1" }, pinData: {}, active: false, meta: { templateCredsSetupCompleted: true }, tags: [],
  };
}

const out = [
  ["process-physician-inquiry.json", buildProcess()],
  ["poll-physician-inquiries.json", buildPoller()],
  ["workflow-error-alert.json", buildErrorAlert()],
];
for (const [f, wf] of out) writeFileSync(new URL("../workflows/" + f, import.meta.url), JSON.stringify(wf, null, 2) + "\n");
console.log(out.map(([f, wf]) => `${f}: ${wf.nodes.length} nodes`).join("; "));
