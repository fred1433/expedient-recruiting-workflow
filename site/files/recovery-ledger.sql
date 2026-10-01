-- Recovery ledger for the physician inquiry workflow.
-- One row per form submission (contact id + submission timestamp). The row records
-- which business effects already happened, so a retry completes the missing steps
-- instead of replaying everything.

create schema if not exists recruiting;

create table if not exists recruiting.inquiry_ledger (
  submission_key      text primary key,          -- "<contactId>:<recent_conversion_date in ms>"
  contact_id          text not null,
  conversion_at       timestamptz not null,
  status              text not null default 'pending'
                      check (status in ('pending','processing','retry','done','failed')),
  attempts            int not null default 0,
  lease_until         timestamptz,
  next_attempt_at     timestamptz not null default now(),
  model_result        jsonb,                      -- validated interpretation, stored once
  suggestions_written boolean not null default false,
  task_id             text,
  task_action         text,                       -- created | appended | reconciled
  last_step           text,
  last_error          text,                       -- step + HTTP status only, never message text
  alerted_at          timestamptz,
  first_seen_at       timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  completed_at        timestamptz
);

create index if not exists inquiry_ledger_work_idx
  on recruiting.inquiry_ledger (status, next_attempt_at);

create table if not exists recruiting.poll_state (
  id          int primary key default 1 check (id = 1),
  checkpoint  timestamptz not null
);
insert into recruiting.poll_state (id, checkpoint)
values (1, now() - interval '1 day')
on conflict (id) do nothing;

create table if not exists recruiting.event_log (
  id             bigserial primary key,
  at             timestamptz not null default clock_timestamp(),
  submission_key text,
  step           text not null,
  outcome        text not null,
  detail         text
);
