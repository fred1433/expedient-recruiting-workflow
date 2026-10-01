# Physician inquiry workflow (reference)

Turns a physician's inquiry from the join form into a reviewable HubSpot work item: suggestions in their own
contact properties, one review task with a proposed reply, and nothing sent to the physician.

**Status.** Reference workflow tested on n8n 2.42.2 (Docker, Postgres 17) against a HubSpot API simulator.
No HubSpot account was used. Your properties, permissions, trigger and existing workflows must be mapped
before activation. Every inquiry in the tests is invented.

## Files

| File | What it is |
| --- | --- |
| `workflows/poll-physician-inquiries.json` | The poller, the single entry point (schedule every 2 minutes, plus a token-protected manual webhook) |
| `workflows/process-physician-inquiry.json` | Processes one submission; called by the poller |
| `workflows/model-instructions.txt` | The full instructions sent to the model (embedded in the workflow at build time) |
| `hubspot/properties.json` | The contact properties the workflow writes, and the two it reads |
| `db/init.sql` | The recovery ledger (schema `recruiting`), created in the Postgres n8n already uses |
| `scripts/build-workflows.mjs` | Generates the two JSON files from readable code |
| `scripts/setup-hubspot-properties.mjs` | Creates the property group and properties in a portal (never overwrites one) |
| `docker-compose.yml`, `ops/up.sh` | The local bench: n8n pinned to 2.42.2, Postgres, the simulator |
| `simulator/sim.mjs` | HubSpot API simulator with fault injection, model-call recorder, alert sink |
| `tests/` | The scenarios and their recorded results |

## How it starts (one entry mechanism)

The poller asks the CRM search API for contacts whose `recent_conversion_date` is later than its checkpoint
minus `POLL_OVERLAP_MINUTES` (10). Each result becomes a submission key `contactId:conversionTimeMs`, recorded once
in the ledger (`on conflict do nothing`). Consequences:

- A physician who submits again gets a new key, so the new inquiry is processed (and added to their open task).
- The workflow's own writes never change `recent_conversion_date`, so it cannot trigger itself.
- Two polls running at the same time cannot both process a submission: claims use `for update skip locked`.
- `JOIN_FORM_NAME`, if set, keeps only contacts whose `recent_conversion_event_name` contains it. Check what
  that property holds in your portal for the join form before relying on it; set it empty to disable.
- It needs a private app token. It does not use HubSpot's "Send a webhook" workflow action, and it registers no
  HubSpot Trigger node, so it does not displace a HubSpot trigger you may already have in n8n.
- Limit: HubSpot keeps one value of the `message` property. Two submissions from the same physician inside one
  polling cycle leave only the latest text to read. The search reads at most 100 contacts per poll.

## What goes to the model

Only `credentials` and `message` (allowlist `modelFields` in the Configuration node). Name, email, phone, owner,
notes, history and attachments are never sent. The name is put into the reply's greeting afterwards, in code.
A message shorter than 20 characters is not sent at all: plain code marks it "needs information".

One provider was tested: OpenAI Chat Completions, model snapshot `gpt-5.4-mini-2026-03-17`
(`MODEL_BASE_URL`, `MODEL_NAME`, credential "Model API key (Authorization: Bearer)"). There is no fallback to
another provider; a failed model call is retried by the ledger like any other step. Using another provider means
changing the "Ask the model" node and the line that reads its answer; that was not tested.

Every suggested value must come with a quote. Code checks that the quote appears word for word in what the
physician wrote; if not, the value is dropped and flagged `unsupported:<field>`. Review routing is a rule:

| Situation | `ai_inquiry_review_status` |
| --- | --- |
| Message contradicts the staff-verified QME status | `conflict_with_verified_record` (task priority High) |
| Licensed states without California, unclear intent, or open questions | `needs_clarification` |
| Message too short to read | `needs_information` |
| Otherwise | `ready_for_review` |

## What it writes, and what it never writes

Writes: the eight `ai_inquiry_*` contact properties (see `hubspot/properties.json`), and one task per open
inquiry: subject, body (reading, quotes, proposed reply, reference), owner `RECRUITING_OWNER_ID`, due the next
business day at 10:00 Pacific, associated to the contact (association type 204). If the physician already has an
open task from this workflow, a new inquiry is appended to it instead of opening a second one.

Never writes: lifecycle stage, contact owner, the staff-verified status (`expedient_qme_status_verified` in the
mapping), any email. The proposed reply sits in the task body until someone sends it.

## Failure and recovery

The ledger (`recruiting.inquiry_ledger`) records per submission: attempts, lease, the validated interpretation,
whether the suggestions were written, the task id. A retry completes the missing steps only:

- the interpretation is reused, the model is not called again;
- the contact is not rewritten if the suggestions are already there;
- before creating a task, the contact's tasks are read and searched for this submission's reference, so a task
  created by an attempt that never got its answer is found, not duplicated (the create call itself has no blind
  in-node retry for that reason);
- an attempt interrupted by a crash or restart is taken again once its lease (`LEASE_SECONDS`) expires;
- after `MAX_ATTEMPTS` the submission is marked failed and an alert is posted to `ALERT_WEBHOOK_URL`. The alert
  carries the submission key, the contact id, the failing step and HTTP status, never the message or the name.
- `recruiting.event_log` keeps one line per step; failed executions also stay visible in n8n.

## Configuration

Everything portal-specific is in the Configuration node of the processing workflow (property names) and in
environment variables: `HUBSPOT_BASE_URL`, `MODEL_BASE_URL`, `MODEL_NAME`, `RECRUITING_OWNER_ID`,
`ALERT_WEBHOOK_URL`, `POLL_TRIGGER_TOKEN`, `LEASE_SECONDS`, `RETRY_BASE_SECONDS`, `MAX_ATTEMPTS`,
`POLL_OVERLAP_MINUTES`, `JOIN_FORM_NAME`. The workflows read `$env`, so `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` is
required (or replace those reads with fixed values).

Before activation on your portal:

1. Create the properties (`node scripts/setup-hubspot-properties.mjs`) or map existing ones in the Configuration node.
2. Map the credentials field and the staff-verified status to your own property names.
3. Create a private app with contact read/write and task permissions; check scopes in your portal.
4. Choose the task owner and the alert channel.
5. Set `JOIN_FORM_NAME` to what your portal records for the join form.
6. Run it against a sandbox or test portal first.

## Running the bench

```
cp .env.example .env            # set N8N_ENCRYPTION_KEY, POSTGRES_PASSWORD, POLL_TRIGGER_TOKEN
MODEL_API_KEY=sk-... ops/up.sh  # n8n + Postgres + simulator, imports credentials and both workflows
node tests/run-scenarios.mjs    # every scenario; results in tests/results/
```

The simulator forwards model calls unchanged to the provider and records them, so every model call in the
recorded runs is a real call. HubSpot is always the simulator.

## Recorded scenarios

`ordinary`, `established`, `sparse`, `outOfState`, `conflict`, `unclear` (reading and routing);
`doubleDelivery`, `samePhysicianAgain`, `taskFailsAfterUpdate`, `responseLost`, `restartMidway`, `givesUp`
(duplicates and recovery). Each result file holds the HTTP calls, the ledger, the event log, the n8n executions
and the checks. Model readings vary slightly between runs.

## Not tested

A real HubSpot portal; another model provider; a backup and restore into a clean instance (a workflow export is
not a backup: the database and `N8N_ENCRYPTION_KEY` are needed too); a production VPS.
