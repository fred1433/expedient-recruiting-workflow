// Keep only the step and a short status: alerts never carry the physician's message.
const e = $input.first().json.error || $input.first().json;
const text = typeof e === 'string' ? e : JSON.stringify(e).slice(0, 2000);
let status = (e && typeof e === 'object' && (e.httpCode || e.status)) || (text.match(/\b(4\d\d|5\d\d)\b/) || [])[1] ||
  (/ECONNRESET|socket hang up|ETIMEDOUT|timeout/i.test(text) ? 'no response' : null);
if (!status) status = /proposed reply/i.test(text) ? 'no usable proposed reply' : /JSON/i.test(text) ? 'invalid model output' : 'error';
return [{ json: { step: $prevNode.name, status: String(status) } }];
