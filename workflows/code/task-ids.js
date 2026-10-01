// Every page of the contact's task associations, split into batch-read chunks of 100.
const ids = $input.all().flatMap(i => (i.json.results || []).map(r => String(r.toObjectId)));
const chunks = [];
for (let i = 0; i < ids.length; i += 100) chunks.push({ json: { ids: ids.slice(i, i + 100) } });
return chunks.length ? chunks : [{ json: { ids: [] } }];
