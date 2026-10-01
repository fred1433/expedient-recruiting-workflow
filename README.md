# Physician inquiry workflow (reference)

Repository: https://github.com/fred1433/expedient-recruiting-workflow

Turns a physician's inquiry from the join form into a reviewable HubSpot work item: suggested values in their
own contact properties, one open review task per physician with a proposed reply, and nothing sent to the
physician.

**Status.** Reference workflow tested on n8n 2.42.2 (Docker, Postgres 17) against a HubSpot API simulator.
No HubSpot account was used. Built without access to your portal: the first step is a run on an approved test
portal. Your properties, permissions, trigger and existing workflows must be mapped before activation. Every
inquiry in the tests is invented.

## Files

| File | What it is |
| --- | --- |
| `workflows/poll-physician-inquiries.json` | The poller, the single entry point (every 2 minutes, plus a token-protected manual webhook) |
| `workflows/process-physician-inquiry.json` | Processes one submission; called by the poller by its ID |
| `workflows/workflow-error-alert.json` | Error workflow: alerts when the poller itself fails |
| `workflows/code/*.js` | The Code nodes as plain JavaScript (inlined into the JSON by the build script) |
| `workflows/model-instructions.txt` | The full instructions sent to the model |
| `hubspot/properties.json` | The contact properties the workflow writes, and the two it reads |
| `db/init.sql` | The recovery ledger (schema `recruiting`), in a Postgres database (the one n8n uses, if it runs on Postgres) |
| `scripts/build-workflows.mjs` | Generates the three JSON files |
| `scripts/setup-hubspot-properties.mjs` | Creates the property group and properties in a portal (never overwrites one) |
| `docker-compose.yml`, `ops/up.sh`, `.env.example` | The local bench: n8n pinned to 2.42.2, Postgres, the simulator |
| `simulator/sim.mjs` | HubSpot API simulator with fault injection, model-call recorder, alert endpoint |
| `tests/run-scenarios.mjs`, `tests/unit.mjs` | The recorded scenarios and the unit checks; results in `tests/results/` |

## How it starts (one entry mechanism)

**Step 0, a prerequisite to check.** The public Join Expedient form is a WordPress form (Gravity Forms); the site
also loads HubSpot's tracking script. This workflow assumes each submission reaches HubSpot as a form conversion on
the contact (it sets `recent_conversion_date` and `recent_conversion_event_name`), with the form's Credentials and
Message fields mapped to contact properties: for example through the Gravity Forms add-on for HubSpot, or HubSpot's
collected forms. If submissions do not reach HubSpot that way, the entry point changes (for instance a Gravity Forms
webhook into n8n, which would also give a stable entry id).

The poller scans a bounded window, from its checkpoint minus `POLL_OVERLAP_MINUTES` (10) up to now, with the CRM
search API, following every page (`SEARCH_PAGE_SIZE`, at most 50 pages per poll). It keeps only conversions whose
`recent_conversion_event_name` contains `JOIN_FORM_NAME`. **`JOIN_FORM_NAME` is mandatory**: if it is empty, the
poller stops and the error workflow posts an alert, rather than treating every form as a join inquiry. Each join
submission becomes a key `contactId:conversionTimeMs`, recorded once in the ledger together with its **frozen
payload** (name, credentials, message as they were at that poll). The checkpoint moves to the end of the window only
after every page was read and recorded; if the page limit is reached it stops at the last record scanned.

- A physician who submits again gets a new key, so the new inquiry is processed and appended to their open task.
- Processing and every retry use the frozen payload, never the contact's current message.
- The workflow's own writes never change `recent_conversion_date`, so it cannot trigger itself.
- If the contact search fails, the poller logs it and still services recorded retries and pending alerts.
- It needs a private app token. It does not use HubSpot's "Send a webhook" workflow action, and it registers no
  HubSpot Trigger node, so it does not displace a HubSpot trigger you may already have in n8n.
- Limit: HubSpot keeps one value of `message`. Two submissions from the same physician inside one polling cycle
  leave only the latest text to freeze.

## What goes to the model, and what n8n handles

The workflow processes contact details in n8n (it reads the contact, the physician's name and the task bodies) and
stores the reading and the draft reply in its recovery database. The model receives: Credentials and Message (allowlist
`modelFields` in the Configuration node), `known_to_team` (true when a staff-verified QME status exists on the
contact), and `previously_stated` (specialty and license states from this physician's earlier, already validated
inquiries). It does not receive separate name, email, phone or history fields. **Free-text messages are not
automatically de-identified**: whatever a physician types in Message goes to the model. The name is put into the
greeting afterwards, in code. A message shorter than 20 characters is not sent at all.

One provider was tested: OpenAI Chat Completions, model snapshot `gpt-5.4-mini-2026-03-17` (`MODEL_BASE_URL`,
`MODEL_NAME`, credential "Model API key (Authorization: Bearer)"). No fallback to another provider.

Production prerequisites: an approved, company-owned model account and infrastructure (with the data agreement
your use requires); agreed rules on what input may be sent; retention and access rules for the n8n database and
the ledger; a route for unexpected sensitive submissions. A content filter would not guarantee that no patient
information passes.

The model proposes; plain code (`workflows/code/check-interpretation.js`) checks:

- each value needs a quote found word for word in the message, and the quote must support the value: a license
  state must be named in its quote, not negated ("not licensed in California yet" goes to `states_not_licensed`); a
  call window must contain a day or time; "exploring QME certification" needs a quote about QME work; "established
  QME" needs a stated current certification; "returning QME" needs a stated lapse;
- types are checked (text, list of US state codes, allowed enumeration values);
- a reply with no content fails the attempt (the signature is added only after that check).

Review routing is a rule:

| Situation | `ai_inquiry_review_status` |
| --- | --- |
| Message contradicts the staff-verified QME status (including a stated lapse) | `conflict_with_verified_record` (task priority High) |
| Not licensed in California, no state named by a physician without a verified record, unclear intent, or open questions | `needs_clarification` |
| Message too short to read | `needs_information` |
| Otherwise | `ready_for_review` |

## What it writes, and what it never writes

Writes: the eight `ai_inquiry_*` contact properties (values, flags and reference; the supporting quotes go into the
task body), and one open review task per physician, with subsequent inquiries appended: subject, body (reading,
quotes, proposed reply, reference), owner `RECRUITING_OWNER_ID`, due the next weekday (no holiday calendar) at 10:00
in America/Los_Angeles, associated to the contact (association type 204). The contact's task associations are read
page by page (`ASSOC_PAGE_SIZE`) and batch-read 100 at a time.

Never writes: lifecycle stage, contact owner, the staff-verified status, any email. An ordinary append sends no
priority, so a task a person raised to High stays High; a new conflict raises it to High.

The proposed reply opens with "Dear Dr. <last name>," and closes with "Best regards, [Your name], Expedient
recruiting" for whoever edits and sends it.

## Failure and recovery

The ledger (`recruiting.inquiry_ledger`) records per submission: the frozen payload, attempts, lease and lease
owner token, the validated interpretation, whether the suggestions were written, the task id, alert delivery.

- Retries reuse a saved interpretation and skip steps recorded as complete. A task that may already exist is looked
  up by this submission's reference before anything is created (the create call has no blind in-node retry).
- Each attempt takes its lease when it starts and renews it, with its owner token, before reading and before each
  write. An attempt that outlived its lease finds another owner and stops without writing; ledger updates also
  require the token.
- Claims skip a physician who already has a submission being processed.
- After `MAX_ATTEMPTS` (5 by default; 3 on the bench, see `.env.example`) the submission is marked failed and an
  alert is posted to `ALERT_WEBHOOK_URL`. `alerted_at` is set only after the endpoint acknowledged; otherwise the
  poller retries the delivery with backoff. Alerts carry the submission key, contact id, failing step and status,
  never the message or the name.
- `recruiting.event_log` keeps one line per step; failed executions also stay visible in n8n.

## Importing into your n8n

The poller calls the processing workflow by its ID, `ExpInqProcess001`, and names `ExpInqErrAlert01` as its error
workflow. Two ways to keep those links:

- import with the CLI, which keeps the IDs in the files:
  `n8n import:workflow --input=<file>.json` for the three files, then publish them;
- or import through the editor, then select the processing workflow again in the poller's "Process each submission"
  node, and the error workflow in the poller's settings.

Then relink the three credentials in the nodes that use them (or create them under these names before importing):
"HubSpot private app token" (HubSpot App Token), "Model API key (Authorization: Bearer)" (Header Auth, name
`Authorization`, value `Bearer <key>`) and "Postgres (recruiting ledger)" (the database holding the `recruiting`
schema from `db/init.sql`).

## Configuration

Portal-specific property names live in the Configuration node of the processing workflow, and the payload property
names in the poller's "Search window" node (keep both in sync). Environment variables: `HUBSPOT_BASE_URL`,
`MODEL_BASE_URL`, `MODEL_NAME`, `RECRUITING_OWNER_ID`, `ALERT_WEBHOOK_URL`, `POLL_TRIGGER_TOKEN`, `JOIN_FORM_NAME`,
`LEASE_SECONDS`, `RETRY_BASE_SECONDS`, `MAX_ATTEMPTS`, `POLL_OVERLAP_MINUTES`, `SEARCH_PAGE_SIZE`, `ASSOC_PAGE_SIZE`.
The workflows read `$env`, so `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is required (or replace those reads with values).

Before activation on your portal:

0. Check that join form submissions reach HubSpot as form conversions with Credentials and Message mapped (see
   "How it starts"). If not, the entry point changes.
1. Set `JOIN_FORM_NAME` to what your portal records for the join form.
2. Create the properties (`node scripts/setup-hubspot-properties.mjs`) or map existing ones.
3. Map the credentials field and the staff-verified status to your own property names.
4. Create a private app with contact read/write and task permissions; check scopes in your portal.
5. Choose the task owner and the alert channel.
6. Run it on an approved test portal first.

## Running the bench

```
cp .env.example .env            # replace the placeholder values
MODEL_API_KEY=sk-... ops/up.sh  # n8n + Postgres + simulator, imports credentials and the three workflows
node tests/unit.mjs             # validator and planner checks
node tests/run-scenarios.mjs    # every scenario; results in tests/results/
node scripts/build-page.mjs     # the demo page, only if every assertion passed
```

The simulator forwards model calls unchanged to the provider and records them, so every model call in the recorded
runs is a real call. HubSpot is always the simulator. The bench uses pages of 2 contacts and 1 association so every
run exercises pagination.

## Recorded scenarios

Reading and routing: `ordinary`, `established`, `sparse`, `outOfState`, `conflict`, `unclear`.
Duplicates, recovery and operations: `doubleDelivery`, `samePhysicianAgain`, `payloadFrozen`, `taskFailsAfterUpdate`,
`searchDownDuringRetry`, `responseLost`, `restartMidway`, `staleWorker`, `paging`, `taskBeyondFirstPage`, `emptyReply`,
`contactReadsFail`, `alertFails`. Each result file holds the HTTP calls, the ledger, the event log, the n8n executions
and the assertions. `tests/results/join-form-name-missing.json` records a one-off check: with `JOIN_FORM_NAME` blank,
the poller failed and the error workflow posted its alert. Model readings vary between runs.

## Not tested

A real HubSpot portal; another model provider; a backup and restore into a clean instance (a workflow export is not a
backup: the database and `N8N_ENCRYPTION_KEY` are needed too); a production VPS; two different submissions from one
physician claimed by two simultaneous polls.
