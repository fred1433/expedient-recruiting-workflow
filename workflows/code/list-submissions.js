// One submission = one contact + the time of its most recent form conversion, with the form
// fields frozen now (the contact's message property is overwritten by the next submission).
const w = $('Search window').first().json;
const only = w.only.toLowerCase();
const pages = $input.all().map(i => i.json);
const all = pages.flatMap(p => p.results || []);
const last = pages[pages.length - 1] || {};
const complete = !(last.paging && last.paging.next && last.paging.next.after);
const rows = [];
let lastScanned = 0;
for (const r of all) {
  const p = r.properties || {};
  const ms = Date.parse(p.recent_conversion_date) || Number(p.recent_conversion_date);
  if (!ms) continue;
  lastScanned = Math.max(lastScanned, ms);
  if (!String(p.recent_conversion_event_name || '').toLowerCase().includes(only)) continue;
  const payload = {};
  for (const [k, prop] of Object.entries(w.payloadProps)) payload[k] = p[prop] ?? null;
  rows.push({ submission_key: r.id + ':' + ms, contact_id: String(r.id), conversion_at: new Date(ms).toISOString(), payload });
}
// The scan checkpoint reaches the end of the window only when every page was read; otherwise
// it stops at the last record scanned, and the next poll continues from there.
const checkpointMs = complete ? w.to : (lastScanned || w.from);
return [{ json: {
  rows: JSON.stringify(rows),
  checkpoint: new Date(checkpointMs).toISOString(),
  scan: 'scanned ' + all.length + ' contacts on ' + pages.length + ' page(s), ' + rows.length + ' join inquiries' + (complete ? '' : ', window not finished'),
} }];
