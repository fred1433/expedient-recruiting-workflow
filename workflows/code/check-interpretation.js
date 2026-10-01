// The model proposes; this code checks. A value is kept only if its quote is found word for
// word in the message AND the quote itself supports the value (state named, time words, etc.).
// Anything else is dropped and flagged. An unusable reply fails the attempt.
const prep = $('Prepare interpretation').first().json;
const c = prep.contact, previously = prep.previously || {};
const flags = [];
let raw = ((($input.first().json.choices || [])[0] || {}).message || {}).content || '';
raw = String(raw).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
let m;
try { m = JSON.parse(raw); } catch (e) { throw new Error('Model reply is not valid JSON'); }
if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('Model reply is not a JSON object');

const norm = s => String(s ?? '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
const unquote = s => String(s ?? '').trim().replace(/^["'“‘]+|["'.”’]+$/g, '').trim();
const source = norm(c.message);
const quoteOf = f => { const q = unquote(f && f.evidence); return q && source.includes(norm(q)) ? q : null; };
const drop = (name, why) => flags.push('unsupported:' + name + (why ? ' (' + why + ')' : ''));

const STATES = { AL: 'alabama', AK: 'alaska', AZ: 'arizona', AR: 'arkansas', CA: 'california', CO: 'colorado', CT: 'connecticut', DE: 'delaware', DC: 'district of columbia', FL: 'florida', GA: 'georgia', HI: 'hawaii', ID: 'idaho', IL: 'illinois', IN: 'indiana', IA: 'iowa', KS: 'kansas', KY: 'kentucky', LA: 'louisiana', ME: 'maine', MD: 'maryland', MA: 'massachusetts', MI: 'michigan', MN: 'minnesota', MS: 'mississippi', MO: 'missouri', MT: 'montana', NE: 'nebraska', NV: 'nevada', NH: 'new hampshire', NJ: 'new jersey', NM: 'new mexico', NY: 'new york', NC: 'north carolina', ND: 'north dakota', OH: 'ohio', OK: 'oklahoma', OR: 'oregon', PA: 'pennsylvania', RI: 'rhode island', SC: 'south carolina', SD: 'south dakota', TN: 'tennessee', TX: 'texas', UT: 'utah', VT: 'vermont', VA: 'virginia', WA: 'washington', WV: 'west virginia', WI: 'wisconsin', WY: 'wyoming' };

function textField(name, supports) {
  const f = m[name] || {};
  let v = f.value;
  if (v === null || v === undefined || v === '') return { value: null, evidence: null };
  if (typeof v !== 'string') { drop(name, 'not text'); return { value: null, evidence: null }; }
  const q = quoteOf(f);
  if (!q) { drop(name, 'quote not found in the message'); return { value: null, evidence: null }; }
  if (supports && !supports(v, q)) { drop(name, 'quote does not support the value'); return { value: null, evidence: null }; }
  return { value: v.trim(), evidence: q };
}

// A state is kept only if the quote names it, with or without a negation as the field requires.
function statesField(name, negative) {
  const f = m[name] || {};
  let v = f.value;
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return { value: null, evidence: null };
  if (!Array.isArray(v)) v = [v];
  const q = quoteOf(f);
  const kept = [];
  for (const s of v) {
    const code = String(s).trim().toUpperCase();
    const named = STATES[code];
    if (!named) { drop(name, 'not a US state: ' + s); continue; }
    if (!q) { drop(name, 'quote not found in the message'); continue; }
    const nq = norm(q);
    let at = nq.indexOf(named);
    if (at < 0) { const mm = new RegExp('\\b' + code + '\\b').exec(q); at = mm ? norm(q.slice(0, mm.index)).length : -1; }
    if (at < 0) { drop(name, code + ' is not named in the quote'); continue; }
    const before = nq.slice(Math.max(0, at - 40), at);
    const negated = /\b(not|never|no longer)\b|n't\b/.test(before);
    if (negated !== negative) { drop(name, code + (negative ? ' is not negated in the quote' : ' is negated in the quote')); continue; }
    kept.push(code);
  }
  return kept.length ? { value: [...new Set(kept)], evidence: q } : { value: null, evidence: null };
}

function enumField(name, allowed, fallback, needs) {
  const f = m[name] || {};
  const v = f.value;
  if (!allowed.includes(v)) { if (v !== null && v !== undefined) flags.push('invalid_value:' + name); return { value: fallback, evidence: null }; }
  if (v === fallback) return { value: v, evidence: null };
  const q = quoteOf(f);
  if (!q) { drop(name, 'quote not found in the message'); return { value: fallback, evidence: null }; }
  if (needs[v] && !needs[v].test(q)) { drop(name, 'quote does not support ' + v); return { value: fallback, evidence: null }; }
  return { value: v, evidence: q };
}

const words = s => norm(s).split(/[^a-z]+/).filter(w => w.length >= 4).map(w => w.slice(0, 5));
const TIME = /\b(mon|tues?|wed|thur?s?|fri|sat|sun)[a-z]*\b|weekday|weekend|morning|afternoon|evening|\bnoon\b|lunch|\d{1,2}\s?(am|pm)\b|\d{1,2}:\d{2}|today|tomorrow|this week|next week/i;

const result = {
  specialty: textField('specialty', (v, q) => words(v).some(w => norm(q).includes(w))),
  license_states: statesField('license_states', false),
  states_not_licensed: statesField('states_not_licensed', true),
  certification_statement: enumField('certification_statement',
    ['says_certified_qme', 'says_lapsed', 'says_in_progress', 'says_not_certified', 'not_stated'], 'not_stated',
    { says_certified_qme: /QME|certif/i, says_lapsed: /laps|expir/i, says_in_progress: /course|exam|appl|certif|QME/i, says_not_certified: /\bnot\b|n't|\byet\b|never/i }),
  intent: enumField('intent',
    ['explore_qme_certification', 'established_qme_joining', 'returning_qme', 'other', 'unclear'], 'unclear',
    { explore_qme_certification: /QME|certif|evaluat/i, established_qme_joining: /QME|evaluat|panel/i, returning_qme: /QME|certif|exam|return|back/i }),
  call_availability: textField('call_availability', (v, q) => TIME.test(q)),
  questions: Array.isArray(m.questions) ? m.questions.filter(x => typeof x === 'string').slice(0, 5) : [],
  ambiguities: Array.isArray(m.ambiguities) ? m.ambiguities.filter(x => typeof x === 'string').slice(0, 5) : [],
  flags,
  source: 'model',
};
// An open question about licensure in a state the message already speaks to is dropped,
// unless it asks about plans (applying, obtaining).
const statedStates = [...(result.license_states.value || []), ...(result.states_not_licensed.value || []), ...(previously.license_states || [])];
result.ambiguities = result.ambiguities.filter(q => {
  const asksPlan = /plan|apply|obtain|pursu|intend/i.test(q);
  const aboutStated = statedStates.some(code => new RegExp('\\b' + code + '\\b').test(q) || norm(q).includes(STATES[code]));
  const aboutLicence = /licen[cs]/i.test(q);
  if (aboutLicence && aboutStated && !asksPlan) { flags.push('dropped_question:already_stated_licensure'); return false; }
  return true;
});
// Cross-checks between fields.
if (result.intent.value === 'established_qme_joining' && result.certification_statement.value !== 'says_certified_qme') {
  drop('intent', 'established QME without a stated current certification'); result.intent = { value: 'unclear', evidence: null };
}
if (result.intent.value === 'returning_qme' && result.certification_statement.value !== 'says_lapsed') {
  drop('intent', 'returning QME without a stated lapse'); result.intent = { value: 'unclear', evidence: null };
}

// The reply must say something; greeting and signature are added here, never by the model.
let body = String(m.proposed_reply ?? '');
body = body.replace(/^\s*(hello|hi|dear[^,\n]*)\s*,/i, '').replace(/\s*(best regards|kind regards|warm regards|sincerely|regards)\s*,?[\s\S]*$/i, '').trim();
if (body.replace(/\s+/g, ' ').length < 60) throw new Error('No usable proposed reply in the model output');
result.proposed_reply = (c.lastName ? 'Dear Dr. ' + c.lastName : 'Hello') + ',\n\n' + body + '\n\nBest regards,\n[Your name], Expedient recruiting';

// Review routing is ordinary code, not model judgment.
const v = c.verifiedQmeStatus, s = result.certification_statement.value;
const contradicts =
  (v === 'certified_qme' && ['says_not_certified', 'says_in_progress', 'says_lapsed'].includes(s)) ||
  (v === 'not_certified' && s === 'says_certified_qme') ||
  (v === 'in_progress' && s === 'says_not_certified');
const states = result.license_states.value || previously.license_states || [];
const notCA = (result.states_not_licensed.value || []).includes('CA');
const outsideCalifornia = notCA || (states.length > 0 && !states.includes('CA'));
const noStateForNewContact = states.length === 0 && !notCA && !v;
if (contradicts) {
  result.review_status = 'conflict_with_verified_record';
  flags.push('conflict:verified_qme_status=' + v + ',message_says=' + s);
} else if (outsideCalifornia || noStateForNewContact || result.intent.value === 'unclear' || result.ambiguities.length) {
  result.review_status = 'needs_clarification';
  if (outsideCalifornia) flags.push('clarify:not_licensed_in_california');
  if (noStateForNewContact) flags.push('clarify:license_state_not_stated');
} else {
  result.review_status = 'ready_for_review';
}
return [{ json: { contact: c, result } }];
