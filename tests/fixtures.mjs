// Synthetic inquiries. Fields are those of the public "Join Expedient" form: name, credentials
// (a select: M.D., D.O., Psy.D., Ph.D., D.P.M., D.D.S., L.A.C., Esq., N/A), email, phone, and a
// free-text message. Every person, address and number below is invented.
export const people = {
  raman: { email: "p.raman@example.test", firstname: "Priya", lastname: "Raman", physician_credentials: "M.D.", phone: "(555) 010-2231",
    message: "I'm a board-certified psychiatrist, licensed in California, and I'd like to start doing QME evaluations alongside my practice. I'm not a QME yet and haven't taken the course. I'm free for a call on Thursday afternoons. What does the preparation involve?" },
  raman2: { email: "p.raman@example.test", firstname: "Priya", lastname: "Raman", physician_credentials: "M.D.", phone: "(555) 010-2231",
    message: "Quick update to my note from this morning: I've now signed up for the QME course and booked the exam for January. Mornings work better for a call now." },
  okoye: { email: "dokoye@example.test", firstname: "Daniel", lastname: "Okoye", physician_credentials: "M.D.", phone: "(555) 010-4410",
    message: "I'm an orthopedic surgeon. I've been a QME since 2019 and I'm licensed in California. I'm looking at groups that handle scheduling and report logistics so I can focus on the evaluations. Email is the best way to reach me." },
  bell: { email: "mbell.do@example.test", firstname: "Marcus", lastname: "Bell", physician_credentials: "D.O.", phone: "(555) 010-7781",
    message: "Interested." },
  park: { email: "hpark.pmr@example.test", firstname: "Helen", lastname: "Park", physician_credentials: "M.D.", phone: "(555) 010-3392",
    message: "I'm board certified in physical medicine and rehabilitation and licensed in Arizona and Nevada. Is QME work possible if I'm not licensed in California yet? Any weekday after 5pm works for a call." },
  ortiz: { email: "sortiz@example.test", firstname: "Samuel", lastname: "Ortiz", physician_credentials: "M.D.", phone: "(555) 010-5527",
    message: "Following up from last year. My QME certification lapsed and I'm retaking the exam this spring. Can I still work with your group in the meantime?" },
  liu: { email: "gliu@example.test", firstname: "Grace", lastname: "Liu", physician_credentials: "M.D.", phone: "(555) 010-8864",
    message: "A colleague mentioned your group. I do a lot of pain management and wanted to see what you offer." },
};

// A contact that already exists in the portal, with a status the team verified and an owner.
export const ortizExisting = {
  id: "2001",
  properties: {
    email: "sortiz@example.test", firstname: "Samuel", lastname: "Ortiz", physician_credentials: "M.D.",
    expedient_qme_status_verified: "certified_qme", hubspot_owner_id: "900002", lifecyclestage: "opportunity",
    createdate: "2025-03-11T17:20:00.000Z",
  },
};

// A physician with three tasks already on the contact: two completed, then an open review task
// from this workflow, raised to High by a person. Used to test association paging and priority.
export const ramanWithTasks = {
  contacts: [{ id: "3001", properties: { email: "p.raman@example.test", firstname: "Priya", lastname: "Raman", physician_credentials: "M.D.", createdate: "2026-09-01T16:00:00.000Z" } }],
  tasks: [
    { id: "5001", contactId: "3001", properties: { hs_task_subject: "Send welcome packet", hs_task_body: "Done.", hs_task_status: "COMPLETED", hs_task_priority: "LOW" } },
    { id: "5002", contactId: "3001", properties: { hs_task_subject: "Call back", hs_task_body: "Left a voicemail.", hs_task_status: "COMPLETED", hs_task_priority: "MEDIUM" } },
    { id: "5003", contactId: "3001", properties: { hs_task_subject: "Physician inquiry: Priya Raman, M.D. (review and reply)", hs_task_body: "<p>Earlier inquiry, reviewed by the team.</p><p style=\"color:#999;font-size:11px\">expedient-inquiry-review ref:3001:1788000000000</p>", hs_task_status: "NOT_STARTED", hs_task_priority: "HIGH" } },
  ],
};
