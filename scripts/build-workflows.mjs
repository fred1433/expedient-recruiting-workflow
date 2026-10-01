// Generates workflows/*.json (n8n 2.42.2 export format) from readable source.
// The JSON files are the deliverable; this script only exists so the Code nodes can be
// reviewed as plain JavaScript. Run: node scripts/build-workflows.mjs

import { writeFileSync, readFileSync } from "node:fs";

const POLLER_ID = "ExpInqPoller0001";
const PROCESS_ID = "ExpInqProcess001";
const CRED_HUBSPOT = { id: "ExpHubspotTok001", name: "HubSpot private app token" };
const CRED_MODEL = { id: "ExpModelKey00001", name: "Model API key (Authorization: Bearer)" };
const CRED_PG = { id: "ExpPostgres00001", name: "Postgres (recruiting ledger)" };

const SYSTEM_PROMPT = readFileSync(new URL("../workflows/model-instructions.txt", import.meta.url), "utf8").trim();

let x = 0;
const pos = (col, row) => [col * 260, row * 180];
function node(name, type, typeVersion, parameters, extra = {}) {
  return { parameters, id: `n${String(++x).padStart(3, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`.slice(0, 36), name, type, typeVersion, ...extra };
}
const hubspotHttp = (name, method, url, body, at, extra = {}) =>
  node(name, "n8n-nodes-base.httpRequest", 4.2, {
    method,
    url,
    authentication: "predefinedCredentialType",
    nodeCredentialType: "hubspotAppToken",
    ...(body ? { sendBody: true, specifyBody: "json", jsonBody: body } : {}),
    options: { timeout: 20000 },
  }, { position: at, credentials: { hubspotAppToken: CRED_HUBSPOT }, retryOnFail: true, maxTries: 3, waitBetweenTries: 1500, onError: "continueErrorOutput", ...extra });
const pg = (name, query, params, at, extra = {}) =>
  node(name, "n8n-nodes-base.postgres", 2.6, { operation: "executeQuery", query, options: { queryReplacement: params } },
    { position: at, credentials: { postgres: CRED_PG }, ...extra });
const code = (name, jsCode, at, extra = {}) => node(name, "n8n-nodes-base.code", 2, { jsCode }, { position: at, ...extra });
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

// ---------------------------------------------------------------------------------------
// Sub-workflow: process ONE submission. Every external call is resumable from the ledger.
// ---------------------------------------------------------------------------------------
function buildProcess() {
  x = 0;
  const N = [];
  const C = {};

  N.push(node("Start", "n8n-nodes-base.executeWorkflowTrigger", 1.1, { inputSource: "passthrough" }, { position: pos(0, 2) }));

  N.push(code("Configuration", `// Mapping table: everything specific to your portal lives here.
// Left: role in this workflow. Right: HubSpot internal property name.
const cfg = {
  hubspotBase: $env.HUBSPOT_BASE_URL,
  modelBase: $env.MODEL_BASE_URL,
  model: $env.MODEL_NAME,                       // one provider, no fallback
  recruitingOwnerId: $env.RECRUITING_OWNER_ID,  // who receives the review task
  maxAttempts: Number($env.MAX_ATTEMPTS || 5),
  retryBaseSeconds: Number($env.RETRY_BASE_SECONDS || 30),
  props: {
    firstName: 'firstname',
    lastName: 'lastname',
    credentials: 'physician_credentials',       // "Credentials" field of the join form
    message: 'message',                         // free-text field of the join form
    verifiedQmeStatus: 'expedient_qme_status_verified', // set by staff only, never written here
    sugSpecialty: 'ai_inquiry_specialty',
    sugLicenseStates: 'ai_inquiry_license_states',
    sugCertification: 'ai_inquiry_certification_statement',
    sugIntent: 'ai_inquiry_intent',
    sugCallWindow: 'ai_inquiry_call_availability',
    sugReviewStatus: 'ai_inquiry_review_status',
    sugFlags: 'ai_inquiry_flags',
    sugRef: 'ai_inquiry_ref',
  },
  // The ONLY contact fields sent to the model. Name, email, phone, owner, history,
  // notes and attachments never leave HubSpot.
  modelFields: ['credentials', 'message'],
  taskMarker: 'expedient-inquiry-review',
  dueHourPacific: 10,
};
return [{ json: { ...$input.first().json, cfg } }];`, pos(1, 2)));
  connect(C, "Start", "Configuration");

  N.push(hubspotHttp("Read contact", "GET",
    "={{ $json.cfg.hubspotBase }}/crm/v3/objects/contacts/{{ $json.contact_id }}?properties={{ Object.values($json.cfg.props).concat(['hubspot_owner_id','lifecyclestage']).join(',') }}",
    null, pos(2, 2)));
  connect(C, "Configuration", "Read contact");

  N.push(code("Prepare interpretation", `const start = $('Configuration').first().json;
const cfg = start.cfg, P = cfg.props;
const p = $input.first().json.properties || {};
const contact = {
  id: String($input.first().json.id),
  firstName: p[P.firstName] || '',
  lastName: p[P.lastName] || '',
  credentials: (p[P.credentials] || '').trim(),
  message: (p[P.message] || '').trim(),
  verifiedQmeStatus: p[P.verifiedQmeStatus] || null,
  ownerId: p.hubspot_owner_id || null,
  lifecyclestage: p.lifecyclestage || null,
};

// Already interpreted on an earlier attempt: reuse it, never pay for the model twice.
if (start.model_result) {
  return [{ json: { contact, needsModel: false, reused: true, result: start.model_result } }];
}

// Too little text to interpret: plain code, no model call.
if (contact.message.replace(/\\s+/g, ' ').length < 20) {
  const result = {
    specialty: { value: null, evidence: null },
    license_states: { value: null, evidence: null },
    certification_statement: { value: 'not_stated', evidence: null },
    intent: { value: 'unclear', evidence: null },
    call_availability: { value: null, evidence: null },
    questions: [],
    ambiguities: ['The message is empty or too short to interpret.'],
    flags: ['no_model_call:message_too_short'],
    review_status: 'needs_information',
    proposed_reply: (contact.lastName ? 'Dear Dr. ' + contact.lastName : 'Hello') + ',\\n\\nThank you for reaching out about joining Expedient. To make our first conversation useful, could you tell us a little about your specialty, where you are licensed, and whether you are already a QME or exploring certification?\\n\\nBest regards,\\n[Your name], Expedient recruiting',
    source: 'rules',
  };
  return [{ json: { contact, needsModel: false, reused: false, result } }];
}

const allowed = {};
for (const f of cfg.modelFields) allowed[f] = contact[f];
// One yes/no flag, no record data: the team already knows this contact (owner or verified status set).
allowed.known_to_team = !!(contact.verifiedQmeStatus || contact.ownerId);
// One provider (OpenAI Chat Completions, pinned model snapshot), no fallback.
const modelRequest = {
  model: cfg.model,
  reasoning_effort: 'low',
  max_completion_tokens: 4000,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: ${JSON.stringify(SYSTEM_PROMPT)} },
    { role: 'user', content: JSON.stringify(allowed) },
  ],
};
return [{ json: { contact, needsModel: true, reused: false, modelRequest } }];`, pos(3, 2)));
  connect(C, "Read contact", "Prepare interpretation");

  N.push(ifTrue("Model needed?", "={{ $json.needsModel }}", pos(4, 2)));
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
  }, { position: pos(5, 1), credentials: { httpHeaderAuth: CRED_MODEL }, retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: "continueErrorOutput" }));
  connect(C, "Model needed?", "Ask the model", 0);

  N.push(code("Check the interpretation", `// The model proposes; this code checks. Any value whose quoted evidence is not found
// word for word in what the physician wrote is dropped and flagged.
const prep = $('Prepare interpretation').first().json;
const c = prep.contact;
const flags = [];
let raw = ((($input.first().json.choices || [])[0] || {}).message || {}).content || '';
raw = raw.replace(/^\\s*\`\`\`(?:json)?\\s*/i, '').replace(/\`\`\`\\s*$/, '');
let m;
try { m = JSON.parse(raw); } catch (e) { throw new Error('Model reply is not valid JSON'); }

const norm = s => String(s || '').toLowerCase().replace(/[\\u2018\\u2019]/g, "'").replace(/[\\u201c\\u201d]/g, '"').replace(/\\s+/g, ' ').trim();
const source = norm(c.message + ' ' + c.credentials);
const field = (name, allowed, fallback) => {
  const f = m[name] || {};
  let value = f.value ?? null, evidence = f.evidence ?? null;
  if (allowed && !allowed.includes(value)) { flags.push('invalid_value:' + name); value = fallback; evidence = null; }
  const empty = value === null || value === fallback || (Array.isArray(value) && value.length === 0);
  if (!empty) {
    // Tolerate the quote marks and final period a model sometimes wraps a quote in; nothing else.
    const q = norm(evidence).replace(/^["']+|["'.]+$/g, '').trim();
    if (!evidence || !q || !source.includes(q)) { flags.push('unsupported:' + name); value = fallback; evidence = null; }
  }
  // Store the quote without the quote marks a model sometimes adds around it.
  if (evidence) evidence = String(evidence).trim().replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, '');
  return { value, evidence };
};
const result = {
  specialty: field('specialty', null, null),
  license_states: field('license_states', null, null),
  certification_statement: field('certification_statement', ['says_certified_qme', 'says_lapsed', 'says_in_progress', 'says_not_certified', 'not_stated'], 'not_stated'),
  intent: field('intent', ['explore_qme_certification', 'established_qme_joining', 'returning_qme', 'other', 'unclear'], 'unclear'),
  call_availability: field('call_availability', null, null),
  questions: Array.isArray(m.questions) ? m.questions.slice(0, 5).map(String) : [],
  ambiguities: Array.isArray(m.ambiguities) ? m.ambiguities.slice(0, 5).map(String) : [],
  // The model never sees the name; the greeting is filled in here from the contact record.
  // The closing is fixed here too: whoever sends it signs it.
  proposed_reply: String(m.proposed_reply || '').slice(0, 2000).replace(/^\\s*Hello,/, c.lastName ? 'Dear Dr. ' + c.lastName + ',' : 'Hello,')
    .replace(/\\s*(best regards|kind regards|sincerely|regards),?[\\s\\S]*$/i, '').trim() + '\\n\\nBest regards,\\n[Your name], Expedient recruiting',
  flags,
  source: 'model',
};
if (result.license_states.value && !Array.isArray(result.license_states.value)) result.license_states.value = [String(result.license_states.value)];

// Review routing is ordinary code, not model judgment.
const v = c.verifiedQmeStatus, s = result.certification_statement.value;
const contradicts =
  (v === 'certified_qme' && (s === 'says_not_certified' || s === 'says_in_progress' || s === 'says_lapsed')) ||
  (v === 'not_certified' && s === 'says_certified_qme') ||
  (v === 'in_progress' && s === 'says_not_certified');
const states = result.license_states.value || [];
// A physician the team does not know yet and who names no state: the coordinator asks.
const noStateForNewContact = states.length === 0 && !(c.verifiedQmeStatus || c.ownerId);
const outsideCalifornia = states.length > 0 && !states.some(x => /^(CA|california)$/i.test(String(x).trim()));
if (contradicts) {
  result.review_status = 'conflict_with_verified_record';
  flags.push('conflict:verified_qme_status=' + v + ',message_says=' + s);
} else if (outsideCalifornia || noStateForNewContact || result.intent.value === 'unclear' || result.ambiguities.length) {
  result.review_status = 'needs_clarification';
  if (outsideCalifornia) flags.push('clarify:licensed_states_without_california');
  if (noStateForNewContact) flags.push('clarify:license_state_not_stated');
} else {
  result.review_status = 'ready_for_review';
}
if (!result.proposed_reply) { flags.push('no_proposed_reply'); }
return [{ json: { contact: c, result } }];`, pos(6, 1)));
  connect(C, "Ask the model", "Check the interpretation", 0);

  N.push(pg("Save interpretation", `with u as (
  update recruiting.inquiry_ledger
     set model_result = coalesce(model_result, $2::jsonb), last_step = 'interpreted', updated_at = now()
   where submission_key = $1
  returning submission_key)
insert into recruiting.event_log (submission_key, step, outcome, detail)
select submission_key, 'interpret', $3, $4 from u
returning submission_key`,
    "={{ [ $('Configuration').first().json.submission_key, JSON.stringify($json.result), $('Prepare interpretation').first().json.reused ? 'reused' : 'saved', $json.result.source + ':' + $json.result.review_status ] }}",
    pos(7, 2)));
  connect(C, "Check the interpretation", "Save interpretation");
  connect(C, "Model needed?", "Save interpretation", 1);

  N.push(ifTrue("Suggestions already written?", "={{ $('Configuration').first().json.suggestions_written === true }}", pos(8, 2)));
  connect(C, "Save interpretation", "Suggestions already written?");

  N.push(code("Suggestion fields", `// Suggestions go to separate ai_inquiry_* properties. Lifecycle stage, owner and any
// staff-verified value are never written by this workflow.
const cfg = $('Configuration').first().json.cfg, P = cfg.props;
const r = $('Check the interpretation').isExecuted ? $('Check the interpretation').first().json.result : $('Prepare interpretation').first().json.result;
const ns = v => (v === null || v === undefined || v === '' ? 'not stated' : v);
const properties = {
  [P.sugSpecialty]: ns(r.specialty.value),
  [P.sugLicenseStates]: ns(Array.isArray(r.license_states.value) ? r.license_states.value.join(', ') : r.license_states.value),
  [P.sugCertification]: r.certification_statement.value,
  [P.sugIntent]: r.intent.value,
  [P.sugCallWindow]: ns(r.call_availability.value),
  [P.sugReviewStatus]: r.review_status,
  [P.sugFlags]: (r.flags || []).join('; ') || 'none',
  [P.sugRef]: $('Configuration').first().json.submission_key,
};
return [{ json: { properties } }];`, pos(9, 1)));
  connect(C, "Suggestions already written?", "Suggestion fields", 1);

  N.push(hubspotHttp("Write suggestions to contact", "PATCH",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/contacts/{{ $('Configuration').first().json.contact_id }}",
    "={{ JSON.stringify({ properties: $json.properties }) }}", pos(10, 1)));
  connect(C, "Suggestion fields", "Write suggestions to contact");

  N.push(pg("Mark suggestions written", `with u as (
  update recruiting.inquiry_ledger set suggestions_written = true, last_step = 'suggestions_written', updated_at = now()
   where submission_key = $1 returning submission_key)
insert into recruiting.event_log (submission_key, step, outcome) select submission_key, 'suggestions', 'written' from u
returning submission_key`, "={{ [ $('Configuration').first().json.submission_key ] }}", pos(11, 1)));
  connect(C, "Write suggestions to contact", "Mark suggestions written", 0);

  N.push(ifTrue("Task already recorded?", "={{ !!$('Configuration').first().json.task_id }}", pos(12, 2)));
  connect(C, "Mark suggestions written", "Task already recorded?");
  connect(C, "Suggestions already written?", "Task already recorded?", 0);

  N.push(hubspotHttp("List the contact's tasks", "GET",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v4/objects/contacts/{{ $('Configuration').first().json.contact_id }}/associations/tasks",
    null, pos(13, 3)));
  connect(C, "Task already recorded?", "List the contact's tasks", 1);

  N.push(code("Task ids", `const ids = ($input.first().json.results || []).map(r => String(r.toObjectId));
return [{ json: { ids } }];`, pos(14, 3)));
  connect(C, "List the contact's tasks", "Task ids", 0);

  N.push(ifTrue("Any tasks?", "={{ $json.ids.length > 0 }}", pos(15, 3)));
  connect(C, "Task ids", "Any tasks?");

  N.push(hubspotHttp("Read those tasks", "POST",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/tasks/batch/read",
    "={{ JSON.stringify({ inputs: $json.ids.map(id => ({ id })), properties: ['hs_task_subject','hs_task_body','hs_task_status','hs_timestamp','hubspot_owner_id'] }) }}",
    pos(16, 2)));
  connect(C, "Any tasks?", "Read those tasks", 0);

  N.push(code("Plan the review task", `// Three outcomes, decided by plain code:
//  reconciled: a task carrying THIS submission's reference already exists (an earlier
//              attempt created it but never got the answer), so nothing is created;
//  appended:   the physician already has an open review task from this workflow, so the
//              new inquiry is added to it instead of opening a second work item;
//  created:    otherwise, one new task, associated to the contact.
const cfgItem = $('Configuration').first().json;
const cfg = cfgItem.cfg, key = cfgItem.submission_key;
const r = $('Check the interpretation').isExecuted ? $('Check the interpretation').first().json.result : $('Prepare interpretation').first().json.result;
const c = $('Prepare interpretation').first().json.contact;
const tasks = ($input.first().json.results || []).map(t => ({ id: String(t.id), ...t.properties }));
const ref = 'ref:' + key;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ns = v => (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) ? '<i>not stated</i>' : esc(Array.isArray(v) ? v.join(', ') : v);
const label = {
  says_certified_qme: 'says they are a certified QME', says_in_progress: 'says certification is in progress',
  says_not_certified: 'says they are not certified', says_lapsed: 'says their certification lapsed', not_stated: 'not stated',
  explore_qme_certification: 'exploring QME certification', established_qme_joining: 'established QME looking at the group', returning_qme: 'former QME looking to return',
  other: 'other request', unclear: 'unclear',
  ready_for_review: 'Ready for review', needs_clarification: 'Needs clarification',
  conflict_with_verified_record: 'Conflicts with the verified record', needs_information: 'Needs information',
};
const quote = f => f && f.evidence ? ' <span style="color:#666">("' + esc(f.evidence) + '")</span>' : '';
const section =
  '<p><b>' + esc(label[r.review_status] || r.review_status) + '</b>. Nothing has been sent to the physician.</p>' +
  '<p><b>What they wrote</b><br>' + esc(c.message || '(empty message)') + '</p>' +
  '<p><b>Suggested reading, from their own words</b><br>' +
  'Specialty: ' + ns(r.specialty.value) + quote(r.specialty) + '<br>' +
  'Licensed in: ' + ns(r.license_states.value) + quote(r.license_states) + '<br>' +
  'Certification: ' + esc(label[r.certification_statement.value] || r.certification_statement.value) + quote(r.certification_statement) + '<br>' +
  'Looking for: ' + esc(label[r.intent.value] || r.intent.value) + quote(r.intent) + '<br>' +
  'Available for a first call: ' + ns(r.call_availability.value) + quote(r.call_availability) + ' (a call window, not evaluation capacity)</p>' +
  (c.verifiedQmeStatus ? '<p><b>Verified record kept as is</b>: QME status ' + esc(({ certified_qme: 'certified QME', in_progress: 'in progress', not_certified: 'not certified' })[c.verifiedQmeStatus] || c.verifiedQmeStatus) + (r.review_status === 'conflict_with_verified_record' ? '. The new message does not match it; please check with the physician.' : '') + '</p>' : '') +
  ((r.ambiguities || []).length ? '<p><b>To clarify</b><br>' + r.ambiguities.map(esc).join('<br>') + '</p>' : '') +
  '<p><b>Proposed reply</b> (edit, then send it yourself)<br>' + esc(r.proposed_reply).replace(/\\n/g, '<br>') + '</p>' +
  '<p style="color:#999;font-size:11px">' + cfg.taskMarker + ' ' + ref + '</p>';

const exact = tasks.find(t => (t.hs_task_body || '').includes(ref));
if (exact) return [{ json: { action: 'reconciled', taskId: exact.id } }];

const open = tasks.find(t => (t.hs_task_body || '').includes(cfg.taskMarker) && t.hs_task_status !== 'COMPLETED');
if (open) {
  const body = (open.hs_task_body || '') + '<hr><p><b>New inquiry from the same physician</b>, received ' + esc(new Date(cfgItem.conversion_at).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC</p>' + section;
  return [{ json: { action: 'appended', taskId: open.id, request: { properties: { hs_task_body: body, hs_task_priority: r.review_status === 'conflict_with_verified_record' ? 'HIGH' : (open.hs_task_priority || 'MEDIUM') } } } }];
}

// Due: next business day, 10:00 Pacific.
const due = new Date(Date.now() + 24 * 3600e3);
while ([0, 6].includes(due.getUTCDay())) due.setUTCDate(due.getUTCDate() + 1);
const ymd = due.toISOString().slice(0, 10);
const dueAt = new Date(ymd + 'T' + String(cfg.dueHourPacific + 7).padStart(2, '0') + ':00:00Z');
const who = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed physician';
const request = {
  properties: {
    hs_task_subject: 'Physician inquiry: ' + who + (c.credentials ? ', ' + c.credentials : '') + ' (review and reply)',
    hs_task_body: section,
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: r.review_status === 'conflict_with_verified_record' ? 'HIGH' : 'MEDIUM',
    hs_task_type: 'TODO',
    hs_timestamp: dueAt.toISOString(),
    hubspot_owner_id: String(cfg.recruitingOwnerId),
  },
  associations: [{ to: { id: c.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }],
};
return [{ json: { action: 'created', request } }];`, pos(17, 3)));
  connect(C, "Read those tasks", "Plan the review task", 0);
  connect(C, "Any tasks?", "Plan the review task", 1);

  N.push(node("Route by action", "n8n-nodes-base.switch", 3.2, {
    mode: "expression",
    numberOutputs: 3,
    output: "={{ ({ created: 0, appended: 1, reconciled: 2 })[$json.action] }}",
  }, { position: pos(18, 3) }));
  connect(C, "Plan the review task", "Route by action");

  N.push(hubspotHttp("Create review task", "POST",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/tasks",
    "={{ JSON.stringify($json.request) }}", pos(19, 2),
    // Creating is not idempotent: no blind in-node retry. A failed or unanswered create is
    // retried by the ledger on the next attempt, which first looks for the task by reference.
    { retryOnFail: false }));
  N.push(hubspotHttp("Add inquiry to open task", "PATCH",
    "={{ $('Configuration').first().json.cfg.hubspotBase }}/crm/v3/objects/tasks/{{ $json.taskId }}",
    "={{ JSON.stringify($json.request) }}", pos(19, 3)));
  connect(C, "Route by action", "Create review task", 0);
  connect(C, "Route by action", "Add inquiry to open task", 1);

  N.push(code("Task outcome", `const plan = $('Plan the review task').first().json;
const id = $input.first().json.id ? String($input.first().json.id) : plan.taskId;
return [{ json: { task_id: id, task_action: plan.action } }];`, pos(20, 3)));
  connect(C, "Create review task", "Task outcome", 0);
  connect(C, "Add inquiry to open task", "Task outcome", 0);
  connect(C, "Route by action", "Task outcome", 2);

  N.push(pg("Mark done", `with u as (
  update recruiting.inquiry_ledger
     set status = 'done', task_id = coalesce($2, task_id), task_action = coalesce($3, task_action),
         last_step = 'done', lease_until = null, completed_at = now(), updated_at = now()
   where submission_key = $1
  returning submission_key, task_id, task_action)
insert into recruiting.event_log (submission_key, step, outcome, detail)
select submission_key, 'task', 'done', coalesce($3, 'already recorded') || ' ' || task_id from u
returning submission_key`,
    "={{ [ $('Configuration').first().json.submission_key, $json.task_id || null, $json.task_action || null ] }}", pos(21, 2)));
  connect(C, "Task outcome", "Mark done");
  connect(C, "Task already recorded?", "Mark done", 0);

  // ---- failure path: every external call routes its error output here ----
  N.push(code("Describe the failure", `// Keep only the step and the HTTP status: alerts never carry the physician's message.
const e = $input.first().json.error || $input.first().json;
const text = JSON.stringify(e).slice(0, 2000);
const status = (e && (e.httpCode || e.status)) || (text.match(/\\b(4\\d\\d|5\\d\\d)\\b/) || [])[1] || (/ECONNRESET|socket hang up|ETIMEDOUT|timeout/i.test(text) ? 'no response' : 'error');
return [{ json: { step: $prevNode.name, status: String(status) } }];`, pos(8, 5)));
  for (const n of ["Read contact", "Ask the model", "Write suggestions to contact", "List the contact's tasks", "Read those tasks", "Create review task", "Add inquiry to open task"]) {
    connect(C, n, "Describe the failure", 1);
  }

  N.push(pg("Record the failure", `with u as (
  update recruiting.inquiry_ledger
     set status = case when attempts >= $3 then 'failed' else 'retry' end,
         next_attempt_at = now() + make_interval(secs => least(3600, $5 * power(2, greatest(attempts - 1, 0)))::int),
         last_step = $2, last_error = $2 || ': ' || $4, lease_until = null, updated_at = now()
   where submission_key = $1
  returning submission_key, contact_id, status, attempts, last_error),
ev as (
  insert into recruiting.event_log (submission_key, step, outcome, detail)
  select submission_key, $2, 'failed', $4 || ' (attempt ' || attempts || ', now ' || status || ')' from u)
select * from u`,
    "={{ [ $('Configuration').first().json.submission_key, $json.step, $('Configuration').first().json.cfg.maxAttempts, $json.status, $('Configuration').first().json.cfg.retryBaseSeconds ] }}",
    pos(9, 5)));
  connect(C, "Describe the failure", "Record the failure");

  N.push(ifTrue("Out of attempts?", "={{ $json.status === 'failed' }}", pos(10, 5)));
  connect(C, "Record the failure", "Out of attempts?");

  N.push(node("Send failure alert", "n8n-nodes-base.httpRequest", 4.2, {
    method: "POST",
    url: "={{ $env.ALERT_WEBHOOK_URL }}",
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ text: 'Physician inquiry workflow: submission ' + $json.submission_key + ' stopped after ' + $json.attempts + ' attempts at step \"' + $json.last_error + '\". Contact record ' + $json.contact_id + '. Nothing was sent to the physician. Check the execution and the ledger.', submission_key: $json.submission_key, contact_id: $json.contact_id, last_error: $json.last_error, attempts: $json.attempts }) }}",
    options: { timeout: 10000 },
  }, { position: pos(11, 4), retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: "continueRegularOutput" }));
  connect(C, "Out of attempts?", "Send failure alert", 0);

  N.push(pg("Mark alerted", `update recruiting.inquiry_ledger set alerted_at = now() where submission_key = $1 returning submission_key`,
    "={{ [ $('Configuration').first().json.submission_key ] }}", pos(12, 4)));
  connect(C, "Send failure alert", "Mark alerted");

  N.push(node("Fail visibly", "n8n-nodes-base.stopAndError", 1, {
    errorMessage: "={{ 'Step \"' + $('Describe the failure').first().json.step + '\" failed (' + $('Describe the failure').first().json.status + '). Ledger status: ' + $('Record the failure').first().json.status + '.' }}",
  }, { position: pos(13, 5) }));
  connect(C, "Mark alerted", "Fail visibly");
  connect(C, "Out of attempts?", "Fail visibly", 1);

  N.forEach((n) => { if (!n.position) n.position = [0, 0]; });
  return {
    id: PROCESS_ID,
    name: "Physician inquiry: process one submission",
    nodes: N,
    connections: C,
    settings: { executionOrder: "v1", callerPolicy: "workflowsFromSameOwner", saveManualExecutions: true },
    pinData: {},
    active: false,
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

// ---------------------------------------------------------------------------------------
// Poller: the single entry mechanism. It asks HubSpot for contacts whose most recent form
// submission is newer than the checkpoint, records each submission once in the ledger,
// claims the ones due, and hands each to the processing workflow.
// ---------------------------------------------------------------------------------------
function buildPoller() {
  x = 0;
  const N = [];
  const C = {};
  N.push(node("Every 2 minutes", "n8n-nodes-base.scheduleTrigger", 1.2, { rule: { interval: [{ field: "minutes", minutesInterval: 2 }] } }, { position: pos(0, 1) }));
  N.push(node("Poll now (manual)", "n8n-nodes-base.webhook", 2, { httpMethod: "POST", path: "expedient-poll-now", responseMode: "onReceived", options: {} }, { position: pos(0, 3), webhookId: "5c1e8f0a-2b7d-4e43-9d0b-7a1f3c2e9b10" }));
  N.push(ifTrue("Token matches?", "={{ $json.headers['x-poll-token'] === $env.POLL_TRIGGER_TOKEN }}", pos(1, 3)));
  connect(C, "Poll now (manual)", "Token matches?");

  N.push(pg("Read checkpoint", `select (extract(epoch from checkpoint) * 1000)::bigint as checkpoint_ms from recruiting.poll_state where id = 1`, "={{ [] }}", pos(2, 2)));
  connect(C, "Every 2 minutes", "Read checkpoint");
  connect(C, "Token matches?", "Read checkpoint", 0);

  N.push(hubspotHttp("Find recent form submissions", "POST",
    "={{ $env.HUBSPOT_BASE_URL }}/crm/v3/objects/contacts/search",
    "={{ JSON.stringify({ filterGroups: [{ filters: [{ propertyName: 'recent_conversion_date', operator: 'GTE', value: String($json.checkpoint_ms - Number($env.POLL_OVERLAP_MINUTES || 10) * 60000) }] }], sorts: [{ propertyName: 'recent_conversion_date', direction: 'ASCENDING' }], properties: ['recent_conversion_date', 'recent_conversion_event_name'], limit: 100 }) }}",
    pos(3, 2), { onError: "stopWorkflow" }));
  connect(C, "Read checkpoint", "Find recent form submissions");

  N.push(code("List submissions", `// One submission = one contact + the timestamp of its most recent form submission.
// A physician who submits again gets a new key, so the new inquiry is processed.
// JOIN_FORM_NAME (optional): keep only submissions whose recent conversion is the join form.
const only = String($env.JOIN_FORM_NAME || '').toLowerCase();
const rows = ($input.first().json.results || [])
  .filter(r => r.properties && r.properties.recent_conversion_date)
  .filter(r => !only || String(r.properties.recent_conversion_event_name || '').toLowerCase().includes(only))
  .map(r => {
    const ms = Date.parse(r.properties.recent_conversion_date) || Number(r.properties.recent_conversion_date);
    return { submission_key: r.id + ':' + ms, contact_id: String(r.id), conversion_at: new Date(ms).toISOString() };
  });
return [{ json: { rows: JSON.stringify(rows), count: rows.length } }];`, pos(4, 2)));
  connect(C, "Find recent form submissions", "List submissions", 0);

  N.push(pg("Record submissions once", `with seen as (
  select * from jsonb_to_recordset($1::jsonb) as x(submission_key text, contact_id text, conversion_at timestamptz)),
ins as (
  insert into recruiting.inquiry_ledger (submission_key, contact_id, conversion_at)
  select submission_key, contact_id, conversion_at from seen
  on conflict (submission_key) do nothing
  returning submission_key),
ev as (
  insert into recruiting.event_log (submission_key, step, outcome) select submission_key, 'poll', 'recorded' from ins),
cp as (
  update recruiting.poll_state
     set checkpoint = greatest(checkpoint, coalesce((select max(conversion_at) from seen), checkpoint))
   where id = 1 returning checkpoint)
select (select count(*) from ins) as new_submissions, (select checkpoint from cp) as checkpoint`,
    "={{ [ $json.rows ] }}", pos(5, 2)));
  connect(C, "List submissions", "Record submissions once");

  N.push(pg("Claim work", `with swept as (
  -- stopped mid-processing too many times (crash, restart): give up loudly
  update recruiting.inquiry_ledger
     set status = 'failed', last_error = coalesce(last_error, 'stopped mid-processing'), updated_at = now()
   where status = 'processing' and lease_until < now() and attempts >= $2
  returning submission_key, contact_id, conversion_at, attempts, model_result, suggestions_written, task_id, last_error, 'alert'::text as kind),
claimable as (
  select submission_key from recruiting.inquiry_ledger
   where (status in ('pending', 'retry') and next_attempt_at <= now())
      or (status = 'processing' and lease_until < now() and attempts < $2)
   order by conversion_at
   limit 20
   for update skip locked),
claimed as (
  update recruiting.inquiry_ledger l
     set status = 'processing', attempts = l.attempts + 1,
         lease_until = now() + make_interval(secs => $1), updated_at = now()
    from claimable c
   where l.submission_key = c.submission_key
  returning l.submission_key, l.contact_id, l.conversion_at, l.attempts, l.model_result, l.suggestions_written, l.task_id, l.last_error, 'work'::text as kind),
ev as (
  insert into recruiting.event_log (submission_key, step, outcome, detail)
  select submission_key, 'claim', 'attempt ' || attempts, coalesce('resuming after: ' || last_error, null) from claimed
  union all
  select submission_key, 'claim', 'gave up', last_error from swept)
select * from claimed union all select * from swept`,
    "={{ [ Number($env.LEASE_SECONDS || 300), Number($env.MAX_ATTEMPTS || 5) ] }}", pos(6, 2)));
  connect(C, "Record submissions once", "Claim work");

  N.push(ifTrue("Gave up on it?", "={{ $json.kind === 'alert' }}", pos(7, 2)));
  connect(C, "Claim work", "Gave up on it?");

  N.push(node("Process each submission", "n8n-nodes-base.executeWorkflow", 1.1, {
    source: "database",
    workflowId: { __rl: true, value: PROCESS_ID, mode: "id" },
    mode: "each",
    options: { waitForSubWorkflow: true },
  }, { position: pos(8, 3), onError: "continueRegularOutput" }));
  connect(C, "Gave up on it?", "Process each submission", 1);

  N.push(node("Send failure alert", "n8n-nodes-base.httpRequest", 4.2, {
    method: "POST",
    url: "={{ $env.ALERT_WEBHOOK_URL }}",
    sendBody: true,
    specifyBody: "json",
    jsonBody: "={{ JSON.stringify({ text: 'Physician inquiry workflow: submission ' + $json.submission_key + ' was interrupted ' + $json.attempts + ' times and is no longer retried. Contact record ' + $json.contact_id + '. Nothing was sent to the physician.', submission_key: $json.submission_key, contact_id: $json.contact_id, last_error: $json.last_error, attempts: $json.attempts }) }}",
    options: { timeout: 10000 },
  }, { position: pos(8, 1), retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: "continueRegularOutput" }));
  connect(C, "Gave up on it?", "Send failure alert", 0);

  N.push(pg("Mark alerted", `update recruiting.inquiry_ledger set alerted_at = now() where submission_key = $1 returning submission_key`,
    "={{ [ $('Gave up on it?').item.json.submission_key ] }}", pos(9, 1)));
  connect(C, "Send failure alert", "Mark alerted");

  return {
    id: POLLER_ID,
    name: "Physician inquiry: poll HubSpot form submissions",
    nodes: N,
    connections: C,
    settings: { executionOrder: "v1", saveManualExecutions: true },
    pinData: {},
    active: false,
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

const proc = buildProcess();
const poll = buildPoller();
writeFileSync(new URL("../workflows/process-physician-inquiry.json", import.meta.url), JSON.stringify(proc, null, 2) + "\n");
writeFileSync(new URL("../workflows/poll-physician-inquiries.json", import.meta.url), JSON.stringify(poll, null, 2) + "\n");
console.log(`process: ${proc.nodes.length} nodes; poller: ${poll.nodes.length} nodes`);
