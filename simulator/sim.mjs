// HubSpot API simulator used for every recorded test run (no HubSpot account was used).
//
// It implements only the endpoints the workflow calls, with response shapes taken from
// HubSpot's public CRM v3/v4 API reference, plus what a real portal cannot give on demand:
//   - faults injected at a precise call (HTTP error, delay, or "commit then drop the response")
//   - the model endpoint, either forwarded to the real provider and recorded ("proxy"),
//     or answered from those recordings ("replay") so failure tests do not pay twice
//   - an alert sink, to check what a failure notification contains
//
// No dependencies: node sim.mjs

import http from "node:http";

const PORT = Number(process.env.PORT || 4010);
const UPSTREAM = process.env.MODEL_UPSTREAM || "https://api.openai.com";
let modelMode = { mode: "replay", replies: [] };  // replies: [{input, content}]

let state;
function reset(seed = {}) {
  state = {
    nextId: 1000,
    contacts: new Map(),   // id -> {id, properties, createdAt, updatedAt}
    tasks: new Map(),      // id -> {id, properties, createdAt, updatedAt}
    assoc: new Map(),      // contactId -> Set(taskId)
    faults: [],
    log: [],
    alerts: [],
    modelCalls: [],
  };
  for (const t of seed.tasks || []) {
    const id = String(t.id);
    state.tasks.set(id, { id, properties: { hs_object_id: id, ...t.properties }, createdAt: iso(), updatedAt: iso() });
    if (t.contactId) { const cid = String(t.contactId); if (!state.assoc.has(cid)) state.assoc.set(cid, new Set()); state.assoc.get(cid).add(id); }
  }
  for (const c of seed.contacts || []) {
    const id = String(c.id || state.nextId++);
    const now = new Date().toISOString();
    state.contacts.set(id, { id, properties: { hs_object_id: id, ...c.properties }, createdAt: now, updatedAt: now });
  }
}
reset();

const iso = (d = new Date()) => new Date(d).toISOString();
const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { ok(b ? JSON.parse(b) : {}); } catch { ok({ __raw: b }); }
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pick(obj, props) {
  const out = { hs_object_id: obj.id };
  for (const p of props) out[p] = obj.properties[p] ?? null;
  return out;
}
function view(obj, props) {
  return {
    id: obj.id,
    properties: props ? pick(obj, props) : { ...obj.properties },
    createdAt: obj.createdAt,
    updatedAt: obj.updatedAt,
    archived: false,
  };
}

// A fault: {method, path (regex string), mode: "error"|"drop_after_commit"|"delay", status, times, delayMs, body}
function matchFault(method, path) {
  for (const f of state.faults) {
    if (f.times === 0) continue;
    if (f.method && f.method !== method) continue;
    if (f.path && !new RegExp(f.path).test(path)) continue;
    if (f.skip > 0) { f.skip -= 1; continue; }
    if (f.times > 0) f.times -= 1;
    f.hits = (f.hits || 0) + 1;
    return f;
  }
  return null;
}

function dateMs(v) {
  if (v == null || v === "") return null;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function searchContacts(body) {
  const props = body.properties || [];
  let rows = [...state.contacts.values()];
  const groups = body.filterGroups || [];
  if (groups.length) {
    rows = rows.filter((c) =>
      groups.some((g) =>
        (g.filters || []).every((f) => {
          const raw = c.properties[f.propertyName];
          if (f.operator === "HAS_PROPERTY") return raw != null && raw !== "";
          const a = dateMs(raw), b = dateMs(f.value);
          if (a == null) return false;
          if (f.operator === "GTE") return a >= b;
          if (f.operator === "GT") return a > b;
          if (f.operator === "LTE") return a <= b;
          if (f.operator === "EQ") return String(raw) === String(f.value);
          return false;
        })
      )
    );
  }
  for (const s of (body.sorts || []).slice().reverse()) {
    const dir = s.direction === "DESCENDING" ? -1 : 1;
    rows.sort((x, y) => dir * ((dateMs(x.properties[s.propertyName]) || 0) - (dateMs(y.properties[s.propertyName]) || 0)));
  }
  const limit = Math.min(Number(body.limit || 10), 200);
  const after = Number(body.after || 0);
  const page = rows.slice(after, after + limit);
  const out = { total: rows.length, results: page.map((c) => view(c, props)) };
  if (after + limit < rows.length) out.paging = { next: { after: String(after + limit) } };
  return out;
}

// A simulated form submission: HubSpot deduplicates by email and updates the existing
// contact, setting recent_conversion_date. The workflow's single entry mechanism relies on it.
function submitForm(body) {
  const at = body.at ? iso(body.at) : iso();
  const email = String(body.email || "").toLowerCase();
  let c = [...state.contacts.values()].find((x) => (x.properties.email || "").toLowerCase() === email);
  if (!c) {
    const id = String(state.nextId++);
    c = { id, properties: { hs_object_id: id, email, first_conversion_date: at, createdate: at }, createdAt: at, updatedAt: at };
    state.contacts.set(id, c);
  }
  for (const k of ["firstname", "lastname", "physician_credentials", "phone", "message"]) {
    if (body[k] !== undefined) c.properties[k] = body[k];
  }
  c.properties.recent_conversion_date = at;
  c.properties.recent_conversion_event_name = body.event || "Join Expedient";
  c.updatedAt = iso();
  return { id: c.id, recent_conversion_date: at };
}

async function modelReply(body, auth) {
  const input = ((body.messages || []).find((m) => m.role === "user") || {}).content || "";
  const call = { at: iso(), mode: modelMode.mode, model: body.model, fieldsSent: Object.keys(safeParse(input) || {}), bytesSent: input.length };
  state.modelCalls.push(call);
  if (modelMode.mode === "proxy") {
    const t0 = Date.now();
    const r = await fetch(UPSTREAM + "/v1/chat/completions", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = await r.json();
    call.status = r.status; call.ms = Date.now() - t0;
    if (r.ok) {
      call.content = out.choices?.[0]?.message?.content ?? null;
      call.servedModel = out.model; call.usage = out.usage;
      modelMode.replies.push({ input, content: call.content, servedModel: out.model });
    }
    return [r.status, out];
  }
  const hit = modelMode.replies.find((x) => x.input === input);
  call.status = hit ? 200 : 500; call.replayed = !!hit;
  if (!hit) return [500, { error: { message: "no recorded reply for this input" } }];
  return [200, { id: "chatcmpl-replay-" + state.modelCalls.length, object: "chat.completion", model: hit.servedModel || body.model,
    choices: [{ index: 0, message: { role: "assistant", content: hit.content }, finish_reason: "stop" }] }];
}
function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

async function handle(req, res) {
  const url = new URL(req.url, "http://sim");
  const path = url.pathname;
  const method = req.method;
  const body = method === "GET" ? {} : await readBody(req);

  // ---- control plane (tests only) ----
  if (path === "/__sim/reset") { reset(body); return json(res, 200, { ok: true }); }
  if (path === "/__sim/faults") { state.faults = (body.faults || []).map((f) => ({ times: 1, ...f })); return json(res, 200, { ok: true }); }
  if (path === "/__sim/submit") return json(res, 200, submitForm(body));
  if (path === "/__sim/state") {
    return json(res, 200, {
      contacts: [...state.contacts.values()],
      tasks: [...state.tasks.values()],
      assoc: Object.fromEntries([...state.assoc].map(([k, v]) => [k, [...v]])),
      faults: state.faults,
      alerts: state.alerts,
      modelCalls: state.modelCalls,
    });
  }
  if (path === "/__sim/log") return json(res, 200, state.log);
  if (path === "/__sim/model") { if (method === "POST") modelMode = { mode: body.mode || "replay", replies: body.replies || modelMode.replies }; return json(res, 200, { mode: modelMode.mode, replies: modelMode.replies }); }
  if (path === "/__alerts") { state.alerts.push({ at: iso(), body }); return json(res, 200, { ok: true }); }
  // Alert endpoint the workflow posts to; it goes through the fault table like any other call.
  if (path.startsWith("/hooks/")) {
    const e = { at: iso(), method, path };
    state.log.push(e);
    const f = matchFault(method, path);
    if (f && f.mode === "error") { e.status = f.status || 500; e.fault = "error"; return json(res, e.status, { ok: false }); }
    state.alerts.push({ at: iso(), body });
    e.status = 200;
    return json(res, 200, { ok: true });
  }

  const entry = { at: iso(), method, path };
  state.log.push(entry);

  // ---- auth, as the real APIs require ----
  const isModel = path.startsWith("/v1/");
  if (isModel && !/^Bearer .+/.test(req.headers.authorization || "")) return json(res, 401, { error: { message: "missing bearer token" } });
  if (!isModel && !/^Bearer .+/.test(req.headers.authorization || "")) {
    return json(res, 401, { status: "error", category: "INVALID_AUTHENTICATION", message: "Authentication credentials not found." });
  }

  const fault = matchFault(method, path);
  if (fault) entry.fault = fault.mode;
  if (fault?.mode === "delay") await sleep(fault.delayMs || 1000);
  if (fault?.mode === "error") {
    entry.status = fault.status || 500;
    return json(res, fault.status || 500, fault.body || { status: "error", category: "INTERNAL_ERROR", message: "Injected failure" });
  }

  const result = path === "/v1/chat/completions" && method === "POST"
    ? await modelReply(body, req.headers.authorization)
    : route(method, path, url, body);
  entry.status = result[0];
  if (fault?.mode === "blank_reply" && result[0] === 200) {
    // The model answered, but with no usable reply text.
    try {
      const msg = result[1].choices[0].message;
      const parsed = JSON.parse(msg.content);
      parsed.proposed_reply = "Best regards,";
      msg.content = JSON.stringify(parsed);
    } catch {}
  }
  if (fault?.mode === "drop_after_commit") {
    // The write happened; the caller never learns it.
    entry.dropped = true;
    req.socket.destroy();
    return;
  }
  return json(res, result[0], result[1]);
}

function route(method, path, url, body) {
  let m;

  if (method === "POST" && path === "/crm/v3/objects/contacts/search") return [200, searchContacts(body)];

  if ((m = path.match(/^\/crm\/v3\/objects\/contacts\/(\d+)$/))) {
    const c = state.contacts.get(m[1]);
    if (!c) return [404, { status: "error", category: "OBJECT_NOT_FOUND", message: "resource not found" }];
    if (method === "GET") {
      const props = (url.searchParams.get("properties") || "").split(",").filter(Boolean);
      return [200, view(c, props.length ? props : null)];
    }
    if (method === "PATCH") {
      for (const [k, v] of Object.entries(body.properties || {})) c.properties[k] = v;
      c.updatedAt = iso();
      return [200, view(c, Object.keys(body.properties || {}))];
    }
  }

  if ((m = path.match(/^\/crm\/v4\/objects\/contacts\/(\d+)\/associations\/tasks$/)) && method === "GET") {
    const ids = [...(state.assoc.get(m[1]) || [])];
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get("limit") || 500)));
    const after = Number(url.searchParams.get("after") || 0);
    const page = ids.slice(after, after + limit);
    const out = { results: page.map((id) => ({ toObjectId: Number(id), associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 204, label: null }] })) };
    if (after + limit < ids.length) out.paging = { next: { after: String(after + limit) } };
    return [200, out];
  }

  if (method === "POST" && path === "/crm/v3/objects/tasks/batch/read") {
    const props = body.properties || [];
    const results = (body.inputs || []).map((i) => state.tasks.get(String(i.id))).filter(Boolean).map((t) => view(t, props));
    return [200, { status: "COMPLETE", results, startedAt: iso(), completedAt: iso() }];
  }

  if (method === "POST" && path === "/crm/v3/objects/tasks") {
    const id = String(state.nextId++);
    const now = iso();
    const t = { id, properties: { hs_object_id: id, hs_createdate: now, ...body.properties }, createdAt: now, updatedAt: now };
    state.tasks.set(id, t);
    for (const a of body.associations || []) {
      const cid = String(a.to.id);
      if (!state.assoc.has(cid)) state.assoc.set(cid, new Set());
      state.assoc.get(cid).add(id);
    }
    return [201, view(t, null)];
  }

  if ((m = path.match(/^\/crm\/v3\/objects\/tasks\/(\d+)$/)) && method === "PATCH") {
    const t = state.tasks.get(m[1]);
    if (!t) return [404, { status: "error", category: "OBJECT_NOT_FOUND" }];
    for (const [k, v] of Object.entries(body.properties || {})) t.properties[k] = v;
    t.updatedAt = iso();
    return [200, view(t, null)];
  }

  return [404, { status: "error", message: `simulator: no route for ${method} ${path}` }];
}

http.createServer((req, res) => handle(req, res).catch((e) => json(res, 500, { error: String(e) }))).listen(PORT, () => {
  console.log(`simulator listening on ${PORT}`);
});
