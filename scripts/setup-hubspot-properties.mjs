// Creates the property group and the ai_inquiry_* contact properties in a HubSpot portal.
// In a TEST portal it can also create the two "assumed existing" properties (--with-assumed).
// Idempotent: an existing property is left untouched (409 is reported, not overwritten).
//   HUBSPOT_TOKEN=... node scripts/setup-hubspot-properties.mjs [--with-assumed]
import { readFileSync } from "node:fs";

const token = process.env.HUBSPOT_TOKEN;
if (!token) { console.error("HUBSPOT_TOKEN missing"); process.exit(1); }
const base = process.env.HUBSPOT_BASE_URL || "https://api.hubapi.com";
const spec = JSON.parse(readFileSync(new URL("../hubspot/properties.json", import.meta.url), "utf8"));
const H = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function post(path, body) {
  const r = await fetch(base + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  return [r.status, await r.text()];
}

let [s] = await post("/crm/v3/properties/contacts/groups", spec.group);
console.log("group", spec.group.name, s === 201 ? "created" : s === 409 ? "exists" : s);

const list = [...spec.properties, ...(process.argv.includes("--with-assumed") ? spec.assumed_existing_in_your_portal : [])];
for (const p of list) {
  const [st, txt] = await post("/crm/v3/properties/contacts", { groupName: spec.group.name, ...p });
  console.log(p.name, st === 201 ? "created" : st === 409 ? "exists (left as is)" : `${st} ${txt.slice(0, 200)}`);
}
