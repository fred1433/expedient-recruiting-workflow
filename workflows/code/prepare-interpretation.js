// Builds what the model will read, from the submission payload frozen at poll time.
// The contact is read only for what staff maintain (verified status, owner).
const start = $('Configuration').first().json;
const cfg = start.cfg, P = cfg.props;
const rec = $('Read contact').first().json;
const p = rec.properties || {};
const sub = start.payload || {};
const contact = {
  id: String(rec.id || start.contact_id),
  firstName: sub.firstName || '',
  lastName: sub.lastName || '',
  credentials: String(sub.credentials || '').trim(),
  message: String(sub.message || '').trim(),
  verifiedQmeStatus: p[P.verifiedQmeStatus] || null,
  ownerId: p.hubspot_owner_id || null,
};

// What this physician already wrote in earlier inquiries (validated readings, from the ledger).
const previously = {};
for (const it of $('Earlier readings').all()) {
  const r = it.json && it.json.model_result;
  if (!r) continue;
  if (!previously.specialty && r.specialty && r.specialty.value) previously.specialty = r.specialty.value;
  if (!previously.license_states && r.license_states && Array.isArray(r.license_states.value) && r.license_states.value.length) previously.license_states = r.license_states.value;
}

// Interpreted on an earlier attempt of THIS submission: reuse it (same frozen payload).
if (start.model_result) {
  return [{ json: { contact, previously, needsModel: false, reused: true, result: start.model_result } }];
}

// Too little text to interpret: plain code, no model call.
if (contact.message.replace(/\s+/g, ' ').length < 20) {
  const result = {
    specialty: { value: null, evidence: null },
    license_states: { value: null, evidence: null },
    states_not_licensed: { value: null, evidence: null },
    certification_statement: { value: 'not_stated', evidence: null },
    intent: { value: 'unclear', evidence: null },
    call_availability: { value: null, evidence: null },
    questions: [],
    ambiguities: ['The message is empty or too short to interpret.'],
    flags: ['no_model_call:message_too_short'],
    review_status: 'needs_information',
    proposed_reply: (contact.lastName ? 'Dear Dr. ' + contact.lastName : 'Hello') + ',\n\nThank you for reaching out about joining Expedient. To make our first conversation useful, could you tell us a little about your specialty, the states where you are licensed, and whether you are already a QME or exploring QME certification?\n\nBest regards,\n[Your name], Expedient recruiting',
    source: 'rules',
  };
  return [{ json: { contact, previously, needsModel: false, reused: false, result } }];
}

const input = {};
for (const f of cfg.modelFields) input[f] = contact[f];
input.known_to_team = !!contact.verifiedQmeStatus;   // staff have verified this physician's QME status
input.previously_stated = previously;
// One provider (OpenAI Chat Completions, pinned model snapshot), no fallback.
const modelRequest = {
  model: cfg.model,
  reasoning_effort: 'low',
  max_completion_tokens: 4000,
  response_format: { type: 'json_object' },
  messages: [
    { role: 'system', content: __SYSTEM_PROMPT__ },
    { role: 'user', content: JSON.stringify(input) },
  ],
};
return [{ json: { contact, previously, needsModel: true, reused: false, modelRequest } }];
