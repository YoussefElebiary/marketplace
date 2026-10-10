-- 005-discovery.sql
-- Tables for historical and live contract deployment/upgrade discovery.
-- Depends on: 004-collection-catalog.sql (PR #119 / Issue #109)
--
-- Discovery finds all deployed contracts and class replacements from chain
-- history. It records full block/tx provenance and supports resumable,
-- idempotent scanning with atomic checkpoint commits.

-- Discovery scanning checkpoint (one row per chain, resumable).
CREATE TABLE IF NOT EXISTS chain.discovery_checkpoints (
  chain_id      text      NOT NULL,
  block_number  bigint    NOT NULL,
  block_hash    text      NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id)
);

-- Discovered contract deployments with block/tx provenance.
CREATE TABLE IF NOT EXISTS chain.discovered_deployments (
  chain_id              text    NOT NULL,
  contract_address      text    NOT NULL,
  class_hash            text    NOT NULL,
  deployer_address      text,
  block_number          bigint  NOT NULL,
  block_hash            text    NOT NULL,
  transaction_hash      text    NOT NULL,
  transaction_index     integer NOT NULL,
  deploy_type           text    NOT NULL
    CHECK (deploy_type IN ('deploy_txn', 'deploy_account_txn', 'udc')),
  constructor_calldata  jsonb   DEFAULT '[]',
  discovered_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_discovered_deployments_block
  ON chain.discovered_deployments (chain_id, block_number);

-- Class hash changes (initial deploy + upgrades) with full provenance.
CREATE TABLE IF NOT EXISTS chain.class_changes (
  id                    bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id              text    NOT NULL,
  contract_address      text    NOT NULL,
  previous_class_hash   text,
  new_class_hash        text    NOT NULL,
  block_number          bigint  NOT NULL,
  block_hash            text    NOT NULL,
  transaction_hash      text    NOT NULL,
  event_index           integer,
  change_type           text    NOT NULL
    CHECK (change_type IN ('deploy', 'upgrade')),
  discovered_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_class_changes_contract
  ON chain.class_changes (chain_id, contract_address, block_number);
CREATE INDEX IF NOT EXISTS idx_class_changes_block
  ON chain.class_changes (chain_id, block_number);

-- RPC capability and historical availability probes.
-- Records what history is actually available rather than declaring completeness.
CREATE TABLE IF NOT EXISTS chain.rpc_probes (
  id                              bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id                        text    NOT NULL,
  probe_time                      timestamptz NOT NULL DEFAULT now(),
  earliest_available_block        bigint,
  latest_block                    bigint,
  supports_get_block_with_receipts boolean DEFAULT true,
  supports_get_events             boolean DEFAULT true,
  supports_get_class_hash_at      boolean DEFAULT true,
  gaps                            jsonb   DEFAULT '[]',
  errors                          jsonb   DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_rpc_probes_chain
  ON chain.rpc_probes (chain_id, probe_time DESC);

-- Event emitter candidates: unique contract addresses seen emitting events.
-- Supplements deployment discovery to find contracts deployed via
-- deploy_syscall that may not emit explicit deployment events.
CREATE TABLE IF NOT EXISTS chain.event_emitter_candidates (
  chain_id          text    NOT NULL,
  contract_address  text    NOT NULL,
  first_seen_block  bigint  NOT NULL,
  last_seen_block   bigint  NOT NULL,
  event_count       bigint  NOT NULL DEFAULT 1,
  PRIMARY KEY (chain_id, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_event_emitter_first_seen
  ON chain.event_emitter_candidates (chain_id, first_seen_block);
