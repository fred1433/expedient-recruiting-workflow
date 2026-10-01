// Synthetic inquiries. Fields are those of the public "Join Expedient" form: name, credentials,
// email, phone, free-text message. Every person, address and number below is invented.
export const people = {
  raman: { email: "p.raman@example.test", firstname: "Priya", lastname: "Raman", physician_credentials: "MD", phone: "(555) 010-2231",
    message: "I'm a psychiatrist licensed in California and interested in becoming a QME. I could speak on Thursday afternoons. What does the preparation involve?" },
  raman2: { email: "p.raman@example.test", firstname: "Priya", lastname: "Raman", physician_credentials: "MD", phone: "(555) 010-2231",
    message: "Quick update to my note from this morning: I finished the QME course and I'm registered for the exam in January. Mornings work better for a call now." },
  okoye: { email: "dokoye@example.test", firstname: "Daniel", lastname: "Okoye", physician_credentials: "MD, orthopedic surgery", phone: "(555) 010-4410",
    message: "I've been a QME since 2019 and I'm licensed in California. I'm looking at groups that handle scheduling and report logistics so I can focus on the evaluations. Email is the best way to reach me." },
  bell: { email: "mbell.do@example.test", firstname: "Marcus", lastname: "Bell", physician_credentials: "DO", phone: "(555) 010-7781",
    message: "Interested." },
  park: { email: "hpark.pmr@example.test", firstname: "Helen", lastname: "Park", physician_credentials: "MD (PM&R)", phone: "(555) 010-3392",
    message: "Board certified in physical medicine and rehabilitation, licensed in Arizona and Nevada. Is QME work possible if I'm not licensed in California yet? Any weekday after 5pm works for a call." },
  ortiz: { email: "sortiz@example.test", firstname: "Samuel", lastname: "Ortiz", physician_credentials: "MD", phone: "(555) 010-5527",
    message: "Following up from last year. My QME certification lapsed and I'm retaking the exam this spring. Can I still work with your group in the meantime?" },
  liu: { email: "gliu@example.test", firstname: "Grace", lastname: "Liu", physician_credentials: "MD", phone: "(555) 010-8864",
    message: "A colleague mentioned your group. I do a lot of pain management and wanted to see what you offer." },
};

// A contact that already exists in the portal, with a status the team verified and an owner.
export const ortizExisting = {
  id: "2001",
  properties: {
    email: "sortiz@example.test", firstname: "Samuel", lastname: "Ortiz", physician_credentials: "MD",
    expedient_qme_status_verified: "certified_qme", hubspot_owner_id: "900002", lifecyclestage: "opportunity",
    createdate: "2025-03-11T17:20:00.000Z",
  },
};
