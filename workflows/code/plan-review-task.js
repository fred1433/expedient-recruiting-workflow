// One open review task per physician, with subsequent inquiries appended. Decided by plain code:
//  reconciled: a task carrying THIS submission's reference already exists (an earlier attempt
//              created it but never got the answer), so nothing is created;
//  appended:   the physician already has an open review task from this workflow;
//  created:    otherwise, one new task, associated to the contact.
const cfgItem = $('Configuration').first().json;
const cfg = cfgItem.cfg, key = cfgItem.submission_key;
const r = $('Check the interpretation').isExecuted ? $('Check the interpretation').first().json.result : $('Prepare interpretation').first().json.result;
const c = $('Prepare interpretation').first().json.contact;
const tasks = $input.all().flatMap(i => (i.json.results || []).map(t => ({ id: String(t.id), ...t.properties })));
const ref = 'ref:' + key;

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ns = v => (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) ? '<i>not stated</i>' : esc(Array.isArray(v) ? v.join(', ') : v);
const label = {
  says_certified_qme: 'says they are a certified QME', says_lapsed: 'says their certification lapsed', says_in_progress: 'says certification is in progress',
  says_not_certified: 'says they are not certified', not_stated: 'not stated',
  explore_qme_certification: 'exploring QME certification', established_qme_joining: 'established QME looking at the group',
  returning_qme: 'former QME looking to return', other: 'other request', unclear: 'unclear',
  ready_for_review: 'Ready for review', needs_clarification: 'Needs clarification',
  conflict_with_verified_record: 'Conflicts with the verified record', needs_information: 'Needs information',
  certified_qme: 'certified QME', in_progress: 'in progress', not_certified: 'not certified',
};
const quote = f => f && f.evidence ? ' <span style="color:#666">("' + esc(f.evidence) + '")</span>' : '';
const notLic = r.states_not_licensed && r.states_not_licensed.value;
const section =
  '<p><b>' + esc(label[r.review_status] || r.review_status) + '</b>. Nothing has been sent to the physician.</p>' +
  '<p><b>What they wrote</b><br>' + esc(c.message || '(empty message)') + '</p>' +
  '<p><b>Suggested reading, from their own words</b><br>' +
  'Specialty: ' + ns(r.specialty.value) + quote(r.specialty) + '<br>' +
  'Licensed in: ' + ns(r.license_states.value) + quote(r.license_states) + '<br>' +
  (notLic ? 'Says not licensed in: ' + ns(notLic) + quote(r.states_not_licensed) + '<br>' : '') +
  'Certification: ' + esc(label[r.certification_statement.value] || r.certification_statement.value) + quote(r.certification_statement) + '<br>' +
  'Looking for: ' + esc(label[r.intent.value] || r.intent.value) + quote(r.intent) + '<br>' +
  'Available for a first call: ' + ns(r.call_availability.value) + quote(r.call_availability) + ' (a call window, not evaluation capacity)</p>' +
  (c.verifiedQmeStatus ? '<p><b>Verified record kept as is</b>: QME status ' + esc(label[c.verifiedQmeStatus] || c.verifiedQmeStatus) + (r.review_status === 'conflict_with_verified_record' ? '. The new message does not match it; please check with the physician.' : '') + '</p>' : '') +
  ((r.ambiguities || []).length ? '<p><b>To clarify</b><br>' + r.ambiguities.map(esc).join('<br>') + '</p>' : '') +
  '<p><b>Proposed reply</b> (edit, then send it yourself)<br>' + esc(r.proposed_reply).replace(/\n/g, '<br>') + '</p>' +
  '<p style="color:#999;font-size:11px">' + cfg.taskMarker + ' ' + ref + '</p>';

const exact = tasks.find(t => (t.hs_task_body || '').includes(ref));
if (exact) return [{ json: { action: 'reconciled', taskId: exact.id } }];

const conflict = r.review_status === 'conflict_with_verified_record';
const open = tasks.find(t => (t.hs_task_body || '').includes(cfg.taskMarker) && t.hs_task_status !== 'COMPLETED');
if (open) {
  const body = (open.hs_task_body || '') + '<hr><p><b>New inquiry from the same physician</b>, received ' + esc(new Date(cfgItem.conversion_at).toISOString().slice(0, 16).replace('T', ' ')) + ' UTC</p>' + section;
  // Priority is only ever raised (a new conflict), never sent on an ordinary append.
  const properties = { hs_task_body: body };
  if (conflict) properties.hs_task_priority = 'HIGH';
  return [{ json: { action: 'appended', taskId: open.id, request: { properties } } }];
}

// Due: next weekday (no holiday calendar) at 10:00 in Los Angeles, converted to UTC.
const now = cfg.now ? new Date(cfg.now) : new Date();
function partsIn(tz, d) {
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d)) o[p.type] = p.value;
  return o;
}
function offsetMs(tz, utcMs) {
  const o = partsIn(tz, new Date(utcMs));
  return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - utcMs;
}
function nextWeekdayAt(tz, hour, from) {
  const o = partsIn(tz, from);
  const y = +o.year, mo = +o.month - 1;
  let d = +o.day + 1;
  while ([0, 6].includes(new Date(Date.UTC(y, mo, d)).getUTCDay())) d++;
  const wall = Date.UTC(y, mo, d, hour);
  let t = wall - offsetMs(tz, wall);
  t = wall - offsetMs(tz, t);
  return new Date(t);
}
const dueAt = nextWeekdayAt(cfg.timeZone, cfg.dueHourLocal, now);
const who = [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unnamed physician';
const request = {
  properties: {
    hs_task_subject: 'Physician inquiry: ' + who + (c.credentials ? ', ' + c.credentials : '') + ' (review and reply)',
    hs_task_body: section,
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: conflict ? 'HIGH' : 'MEDIUM',
    hs_task_type: 'TODO',
    hs_timestamp: dueAt.toISOString(),
    hubspot_owner_id: String(cfg.recruitingOwnerId),
  },
  associations: [{ to: { id: c.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }] }],
};
return [{ json: { action: 'created', request } }];
