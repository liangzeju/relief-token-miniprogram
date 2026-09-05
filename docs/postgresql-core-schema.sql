-- 设计稿：PostgreSQL 核心表（不是当前小程序的运行时依赖）
-- 所有金额均为最小整数单位；生产实现需补充分区、索引、加密和迁移脚本。

create table organizations (
  id uuid primary key,
  legal_name text not null,
  org_type text not null check (org_type in ('donor','government','ngo','supplier','rescue_team','platform','auditor','payment_institution')),
  registration_no text,
  status text not null check (status in ('pending','active','suspended','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key,
  wechat_openid_hash text unique not null,
  real_name_status text not null default 'unverified',
  risk_status text not null default 'normal',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table memberships (
  user_id uuid not null references users(id),
  organization_id uuid not null references organizations(id),
  role text not null,
  scope jsonb not null default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  primary key (user_id, organization_id, role)
);

create table donations (
  id uuid primary key,
  donor_organization_id uuid references organizations(id),
  donor_user_id uuid references users(id),
  fiat_amount bigint not null check (fiat_amount > 0),
  currency char(3) not null default 'CNY',
  payment_provider text not null,
  payment_reference text unique,
  status text not null,
  compliance_case_id uuid,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

create table compliance_cases (
  id uuid primary key,
  subject_type text not null check (subject_type in ('user','organization','donation','resource')),
  subject_id uuid not null,
  status text not null check (status in ('pending','approved','rejected','manual_review','frozen')),
  risk_level text,
  decision_reason text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table donations
  add constraint donations_compliance_case_fk
  foreign key (compliance_case_id) references compliance_cases(id);

create table fund_policies (
  id uuid primary key,
  donation_id uuid not null unique references donations(id),
  allowed_task_types text[] not null default '{}',
  allowed_material_types text[] not null default '{}',
  allowed_regions text[] not null default '{}',
  expires_at timestamptz,
  policy_hash text not null,
  created_at timestamptz not null default now()
);

create table mon_acquisitions (
  id uuid primary key,
  donation_id uuid not null unique references donations(id),
  source_type text not null check (source_type in ('platform_treasury','liquidity_provider','direct_mon_donation','other_approved')),
  source_reference_hash text not null,
  amount_mon bigint not null check (amount_mon > 0),
  mon_price_cny_numerator bigint not null check (mon_price_cny_numerator > 0),
  mon_price_cny_denominator bigint not null check (mon_price_cny_denominator > 0),
  price_source text not null,
  price_valid_until timestamptz,
  acquisition_tx_id uuid,
  status text not null check (status in ('pending','confirmed','failed','reversed')),
  created_at timestamptz not null default now()
);

create table fund_accounts (
  id uuid primary key,
  donation_id uuid not null unique references donations(id),
  deposited_mon bigint not null default 0 check (deposited_mon >= 0),
  available_mon bigint not null default 0 check (available_mon >= 0),
  reserved_mon bigint not null default 0 check (reserved_mon >= 0),
  settled_mon bigint not null default 0 check (settled_mon >= 0),
  refunded_mon bigint not null default 0 check (refunded_mon >= 0),
  pending_mon bigint not null default 0 check (pending_mon >= 0),
  onchain_account text,
  updated_at timestamptz not null default now()
);

create table watermark_lots (
  id uuid primary key,
  fund_account_id uuid not null references fund_accounts(id),
  donation_id uuid not null references donations(id),
  parent_lot_id uuid references watermark_lots(id),
  public_watermark_id text not null unique,
  amount_mon bigint not null check (amount_mon > 0),
  status text not null check (status in ('available','allocated','escrowed','locked','settled','refunded','finished','frozen')),
  root_hash text not null,
  created_at timestamptz not null default now()
);

create table watermark_events (
  id uuid primary key,
  watermark_lot_id uuid not null references watermark_lots(id),
  event_type text not null,
  business_entity_type text not null,
  business_entity_id uuid not null,
  amount_mon bigint not null check (amount_mon >= 0),
  private_event_hash text,
  previous_hash text,
  chain_transaction_id uuid,
  created_at timestamptz not null default now()
);

create table private_batches (
  id uuid primary key,
  batch_type text not null check (batch_type in ('bid_commitment','bid_reveal','contract','evidence','approval')),
  merkle_root text not null,
  disclosure_hash text,
  chain_transaction_id uuid,
  status text not null check (status in ('draft','sealed','anchored','superseded')),
  created_at timestamptz not null default now()
);

create table ledger_entries (
  id uuid primary key,
  fund_account_id uuid not null references fund_accounts(id),
  contract_id uuid,
  entry_type text not null check (entry_type in ('fiat_deposit','mon_deposit','reserve','release','settle','refund','redemption_lock','adjustment')),
  amount bigint not null check (amount >= 0),
  balance_after bigint not null check (balance_after >= 0),
  chain_transaction_id uuid,
  operator_user_id uuid references users(id),
  idempotency_key text,
  created_at timestamptz not null default now()
);

create table evidence_objects (
  id uuid primary key,
  owner_organization_id uuid references organizations(id),
  object_type text not null,
  storage_key text not null unique,
  content_hash text not null,
  mime_type text,
  classification text not null default 'restricted',
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key,
  source_organization_id uuid references organizations(id),
  disaster_type text not null,
  location jsonb not null,
  task_type text not null,
  material_type text,
  required_quantity bigint,
  severity text not null,
  verification_status text not null,
  status text not null,
  temporary_approval_expires_at timestamptz,
  evidence_hash text,
  created_by uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table resource_profiles (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  resource_type text not null check (resource_type in ('material_supplier','rescue_team')),
  certification_status text not null,
  certification_hash text,
  valid_until timestamptz,
  capabilities jsonb not null default '{}'::jsonb,
  unique (organization_id, resource_type)
);

create table resource_responses (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  resource_profile_id uuid not null references resource_profiles(id),
  version integer not null check (version > 0),
  quantity bigint,
  unit_price bigint,
  eta_hours integer,
  distance_km integer,
  payload jsonb not null,
  score_snapshot jsonb,
  status text not null,
  submitted_at timestamptz not null default now(),
  unique (task_id, resource_profile_id, version)
);

create table awards (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  response_id uuid not null unique references resource_responses(id),
  decision_reason text not null,
  proposed_by uuid not null references users(id),
  approved_by uuid references users(id),
  status text not null,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);

create table contracts (
  id uuid primary key,
  task_id uuid not null references tasks(id),
  award_id uuid not null unique references awards(id),
  fund_account_id uuid not null references fund_accounts(id),
  supplier_organization_id uuid not null references organizations(id),
  contract_amount bigint not null check (contract_amount > 0),
  reserved_amount bigint not null default 0 check (reserved_amount >= 0),
  released_amount bigint not null default 0 check (released_amount >= 0),
  refunded_amount bigint not null default 0 check (refunded_amount >= 0),
  status text not null,
  contract_hash text not null,
  created_at timestamptz not null default now(),
  check (released_amount + refunded_amount <= reserved_amount)
);

create table delivery_batches (
  id uuid primary key,
  contract_id uuid not null references contracts(id),
  planned_quantity bigint not null check (planned_quantity > 0),
  delivered_quantity bigint not null default 0 check (delivered_quantity >= 0),
  accepted_quantity bigint not null default 0 check (accepted_quantity >= 0),
  rejected_quantity bigint not null default 0 check (rejected_quantity >= 0),
  status text not null,
  evidence_hash text,
  created_at timestamptz not null default now(),
  check (accepted_quantity + rejected_quantity <= delivered_quantity),
  check (delivered_quantity <= planned_quantity)
);

create table settlements (
  id uuid primary key,
  contract_id uuid not null references contracts(id),
  delivery_batch_id uuid references delivery_batches(id),
  accepted_amount bigint not null check (accepted_amount >= 0),
  payout_amount bigint not null check (payout_amount >= 0),
  payout_reference text,
  status text not null,
  reviewed_by uuid references users(id),
  paid_at timestamptz,
  settlement_tx_id uuid
);

create table exchange_rules (
  id uuid primary key,
  version integer not null unique,
  mon_to_cny_numerator bigint not null check (mon_to_cny_numerator > 0),
  mon_to_cny_denominator bigint not null check (mon_to_cny_denominator > 0),
  fee_bps integer not null default 0 check (fee_bps >= 0 and fee_bps <= 10000),
  min_mon bigint not null default 0 check (min_mon >= 0),
  max_mon bigint,
  effective_from timestamptz not null,
  effective_until timestamptz,
  status text not null check (status in ('draft','active','retired')),
  rule_hash text not null,
  created_at timestamptz not null default now(),
  check (max_mon is null or max_mon >= min_mon),
  check (effective_until is null or effective_until > effective_from)
);

create table payout_accounts (
  id uuid primary key,
  organization_id uuid not null references organizations(id),
  provider_account_ref text not null,
  account_name_hash text not null,
  verification_status text not null check (verification_status in ('pending','verified','blocked')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, provider_account_ref)
);

create table redemption_requests (
  id uuid primary key,
  contract_id uuid not null references contracts(id),
  organization_id uuid not null references organizations(id),
  payout_account_id uuid not null references payout_accounts(id),
  exchange_rule_id uuid not null references exchange_rules(id),
  mon_amount bigint not null check (mon_amount > 0),
  fiat_amount bigint not null check (fiat_amount >= 0),
  price_snapshot jsonb not null default '{}'::jsonb,
  status text not null check (status in ('requested','compliance_review','approved','mon_locked','payout_pending','paid','settlement_pending','settled','failed','cancelled')),
  payout_reference text unique,
  settlement_tx_id uuid,
  requested_at timestamptz not null default now(),
  paid_at timestamptz
);

create table chain_transactions (
  id uuid primary key,
  business_id uuid not null,
  action text not null,
  network text not null,
  chain_id integer not null,
  tx_hash text unique,
  status text not null,
  confirmations integer not null default 0,
  required_confirmations integer not null default 2,
  block_number bigint,
  nonce bigint,
  last_error text,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unique (business_id, action)
);

create table chain_outbox (
  id uuid primary key,
  chain_transaction_id uuid not null unique references chain_transactions(id),
  payload jsonb not null,
  status text not null check (status in ('READY','SUBMITTING','BROADCAST','CONFIRMED','REVERTED','TIMEOUT','MANUAL_REVIEW')),
  lease_until timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table settlements
  add constraint settlements_settlement_tx_fk
  foreign key (settlement_tx_id) references chain_transactions(id);

alter table mon_acquisitions
  add constraint mon_acquisitions_chain_tx_fk
  foreign key (acquisition_tx_id) references chain_transactions(id);

alter table watermark_events
  add constraint watermark_events_chain_tx_fk
  foreign key (chain_transaction_id) references chain_transactions(id);

alter table private_batches
  add constraint private_batches_chain_tx_fk
  foreign key (chain_transaction_id) references chain_transactions(id);

alter table ledger_entries
  add constraint ledger_entries_chain_tx_fk
  foreign key (chain_transaction_id) references chain_transactions(id);

alter table ledger_entries
  add constraint ledger_entries_contract_fk
  foreign key (contract_id) references contracts(id);

alter table redemption_requests
  add constraint redemption_requests_settlement_tx_fk
  foreign key (settlement_tx_id) references chain_transactions(id);

create table audit_events (
  id uuid primary key,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  actor_user_id uuid references users(id),
  actor_organization_id uuid references organizations(id),
  payload_hash text not null,
  previous_event_hash text,
  chain_transaction_id uuid references chain_transactions(id),
  created_at timestamptz not null default now()
);

create table idempotency_keys (
  key text not null,
  actor_user_id uuid not null references users(id),
  request_hash text not null,
  response_json jsonb,
  status_code integer,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (key, actor_user_id)
);

create index tasks_status_idx on tasks(status);
create index ledger_entries_fund_idx on ledger_entries(fund_account_id, created_at);
create index evidence_objects_hash_idx on evidence_objects(content_hash);
create index resource_responses_task_idx on resource_responses(task_id, status);
create index contracts_task_status_idx on contracts(task_id, status);
create index redemption_requests_org_status_idx on redemption_requests(organization_id, status, requested_at);
create index watermark_events_lot_idx on watermark_events(watermark_lot_id, created_at);
create index watermark_lots_donation_idx on watermark_lots(donation_id, status);
create index private_batches_status_idx on private_batches(status, created_at);
create index chain_transactions_status_idx on chain_transactions(status, created_at);
create index chain_outbox_ready_idx on chain_outbox(status, lease_until, created_at);
create index audit_events_entity_idx on audit_events(entity_type, entity_id, created_at);
