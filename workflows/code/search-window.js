// The poll scans a bounded window [checkpoint - overlap, now]. JOIN_FORM_NAME is mandatory:
// without it every form on a physician's contact would count as a join inquiry.
const only = String($env.JOIN_FORM_NAME || '').trim();
if (!only) throw new Error('JOIN_FORM_NAME is not set. Refusing to treat every form as a join inquiry.');
const cp = Number($input.first().json.checkpoint_ms);
const from = cp - Number($env.POLL_OVERLAP_MINUTES || 10) * 60000;
const to = Date.now();
// Submission fields frozen at poll time. Keep in sync with the Configuration node of the
// processing workflow.
const payloadProps = { firstName: 'firstname', lastName: 'lastname', credentials: 'physician_credentials', message: 'message' };
const body = {
  filterGroups: [{ filters: [
    { propertyName: 'recent_conversion_date', operator: 'GTE', value: String(from) },
    { propertyName: 'recent_conversion_date', operator: 'LTE', value: String(to) },
  ] }],
  sorts: [{ propertyName: 'recent_conversion_date', direction: 'ASCENDING' }],
  properties: ['recent_conversion_date', 'recent_conversion_event_name', ...Object.values(payloadProps)],
  limit: Number($env.SEARCH_PAGE_SIZE || 100),
};
return [{ json: { from, to, only, payloadProps, body } }];
