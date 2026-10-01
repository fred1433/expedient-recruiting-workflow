// Mapping table: everything specific to your portal lives here.
// Left: role in this workflow. Right: HubSpot internal property name.
const cfg = {
  hubspotBase: $env.HUBSPOT_BASE_URL,
  modelBase: $env.MODEL_BASE_URL,
  model: $env.MODEL_NAME,                       // one provider, no fallback
  recruitingOwnerId: $env.RECRUITING_OWNER_ID,  // who receives the review task
  maxAttempts: Number($env.MAX_ATTEMPTS || 5),
  retryBaseSeconds: Number($env.RETRY_BASE_SECONDS || 30),
  leaseSeconds: Number($env.LEASE_SECONDS || 300),
  assocPageSize: Number($env.ASSOC_PAGE_SIZE || 100),
  props: {
    firstName: 'firstname',
    lastName: 'lastname',
    credentials: 'physician_credentials',       // "Credentials" select of the join form
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
  // Sent to the model: these two submission fields, a yes/no flag and what the physician's own
  // earlier inquiries already said. The free text is NOT de-identified (see README).
  modelFields: ['credentials', 'message'],
  taskMarker: 'expedient-inquiry-review',
  dueHourLocal: 10,
  timeZone: 'America/Los_Angeles',
};
return [{ json: { ...$input.first().json, cfg } }];
