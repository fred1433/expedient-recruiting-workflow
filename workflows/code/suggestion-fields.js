// Suggestions go to separate ai_inquiry_* properties. Lifecycle stage, owner and any
// staff-verified value are never written by this workflow.
const cfg = $('Configuration').first().json.cfg, P = cfg.props;
const r = $('Check the interpretation').isExecuted ? $('Check the interpretation').first().json.result : $('Prepare interpretation').first().json.result;
const ns = v => (v === null || v === undefined || v === '' ? 'not stated' : v);
const yes = (r.license_states && r.license_states.value) || [];
const no = (r.states_not_licensed && r.states_not_licensed.value) || [];
const states = [yes.length ? yes.join(', ') : '', no.length ? 'not licensed in ' + no.join(', ') : ''].filter(Boolean).join('; ');
const properties = {
  [P.sugSpecialty]: ns(r.specialty.value),
  [P.sugLicenseStates]: ns(states),
  [P.sugCertification]: r.certification_statement.value,
  [P.sugIntent]: r.intent.value,
  [P.sugCallWindow]: ns(r.call_availability.value),
  [P.sugReviewStatus]: r.review_status,
  [P.sugFlags]: (r.flags || []).join('; ') || 'none',
  [P.sugRef]: $('Configuration').first().json.submission_key,
};
return [{ json: { properties } }];
