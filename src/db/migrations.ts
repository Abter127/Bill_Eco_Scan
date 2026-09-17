/**
 * Schema migrations, applied in order and recorded in `schema_migrations`.
 *
 * Constraints that encode PRD rules rather than mere tidiness are commented at
 * the point of declaration — most of them are the difference between a correct
 * report and a plausible one.
 */

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_initial',
    sql: `
    -- ---------------------------------------------------------------- merchants
    CREATE TABLE merchants (
      id                    TEXT PRIMARY KEY,
      gstin                 TEXT,
      legal_name            TEXT NOT NULL,
      trade_name            TEXT,
      category              TEXT NOT NULL DEFAULT 'general',
      gstin_verified        INTEGER NOT NULL DEFAULT 0,
      verified_badge        INTEGER NOT NULL DEFAULT 0,
      -- E5: re-registration keeps historical bills on their original GSTIN.
      successor_merchant_id TEXT REFERENCES merchants(id),
      state                 TEXT NOT NULL DEFAULT 'active',
      return_window_days    INTEGER,
      return_policy_source  TEXT,
      sensitivity_class     TEXT NOT NULL DEFAULT 'standard',
      created_at            TEXT NOT NULL
    );
    -- GSTIN is the merchant identity (E3); a trade-name difference must never
    -- create a second merchant.
    CREATE UNIQUE INDEX idx_merchants_gstin ON merchants(gstin) WHERE gstin IS NOT NULL;

    CREATE TABLE outlets (
      id          TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL REFERENCES merchants(id),
      name        TEXT NOT NULL,
      city        TEXT,
      -- E5: outlets close, they are never deleted.
      state       TEXT NOT NULL DEFAULT 'active',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_outlets_merchant ON outlets(merchant_id);

    CREATE TABLE terminals (
      id              TEXT PRIMARY KEY,
      outlet_id       TEXT NOT NULL REFERENCES outlets(id),
      label           TEXT NOT NULL,
      secret_hash     TEXT NOT NULL,
      secret_rotated_at TEXT,
      -- E1 "print succeeded, capture failed": heartbeat drives the capture-gap
      -- warning in the merchant console.
      last_heartbeat_at TEXT,
      last_bill_at    TEXT,
      state           TEXT NOT NULL DEFAULT 'active',
      created_at      TEXT NOT NULL
    );
    CREATE INDEX idx_terminals_outlet ON terminals(outlet_id);

    -- ----------------------------------------------------------------- people
    CREATE TABLE accounts (
      id              TEXT PRIMARY KEY,
      -- E2: phone is a lookup key, never an identity. Indian numbers get
      -- recycled, so a re-verified number never auto-binds historical bills.
      phone_e164      TEXT,
      phone_verified_at TEXT,
      display_name    TEXT,
      app_lock_enabled INTEGER NOT NULL DEFAULT 0,
      -- T-05: set once, honoured at every participating counter.
      format_preference TEXT NOT NULL DEFAULT 'paper',
      state           TEXT NOT NULL DEFAULT 'active',
      merged_into_account_id TEXT REFERENCES accounts(id),
      created_at      TEXT NOT NULL,
      deleted_at      TEXT
    );
    CREATE INDEX idx_accounts_phone ON accounts(phone_e164) WHERE phone_e164 IS NOT NULL;

    CREATE TABLE profiles (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      kind        TEXT NOT NULL,              -- personal | business
      label       TEXT NOT NULL,
      gstin       TEXT,                       -- business profiles only (C-04)
      is_default  INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_profiles_account ON profiles(account_id);

    -- ------------------------------------------------------------------ bills
    CREATE TABLE bills (
      id                        TEXT PRIMARY KEY,
      -- E4: annotations attach to the group, so they survive every amendment.
      bill_group_id             TEXT NOT NULL,
      merchant_id               TEXT NOT NULL REFERENCES merchants(id),
      outlet_id                 TEXT NOT NULL REFERENCES outlets(id),
      terminal_id               TEXT,
      document_type             TEXT NOT NULL,
      document_number           TEXT,
      financial_year            TEXT,
      document_date_key         TEXT,
      document_date_ambiguous   INTEGER NOT NULL DEFAULT 0,
      document_date_candidates  TEXT NOT NULL DEFAULT '[]',
      terminal_time             TEXT,
      server_receipt_time       TEXT NOT NULL,
      clock_skew_ms             INTEGER,
      clock_skew_flagged        INTEGER NOT NULL DEFAULT 0,
      currency                  TEXT NOT NULL DEFAULT 'INR',
      subtotal_minor            INTEGER,
      tax_total_minor           INTEGER,
      discount_total_minor      INTEGER,
      round_off_minor           INTEGER,
      grand_total_minor         INTEGER NOT NULL,
      -- E1: both figures are stored. We never reconcile one into the other.
      line_sum_minor            INTEGER,
      sum_discrepancy_minor     INTEGER,
      sum_discrepancy_flagged   INTEGER NOT NULL DEFAULT 0,
      payment_method            TEXT,
      buyer_gstin               TEXT,
      place_of_supply           TEXT,
      provenance                TEXT NOT NULL,
      content_fingerprint       TEXT NOT NULL,
      idempotency_key           TEXT,
      state                     TEXT NOT NULL,
      owner_account_id          TEXT REFERENCES accounts(id),
      owner_profile_id          TEXT REFERENCES profiles(id),
      sensitivity_class         TEXT NOT NULL DEFAULT 'standard',
      not_a_tax_invoice         INTEGER NOT NULL DEFAULT 0,
      -- E1 split payment: the shared copy cannot be double-expensed.
      expensable                INTEGER NOT NULL DEFAULT 1,
      image_ref                 TEXT,
      raw_source_ref            TEXT,
      claimed_at                TEXT,
      hold_expires_at           TEXT,
      created_at                TEXT NOT NULL
    );

    -- E7: an invoice number is unique per merchant PER FINANCIAL YEAR. Indian
    -- merchants reset their sequence every April; a global unique index here
    -- would reject a perfectly normal bill each year.
    CREATE UNIQUE INDEX idx_bills_docnum_fy
      ON bills(merchant_id, financial_year, document_number, document_type)
      WHERE document_number IS NOT NULL;

    CREATE INDEX idx_bills_owner_date ON bills(owner_account_id, document_date_key DESC);
    CREATE INDEX idx_bills_fingerprint ON bills(content_fingerprint);
    CREATE INDEX idx_bills_merchant_date ON bills(merchant_id, document_date_key DESC);
    CREATE INDEX idx_bills_state_hold ON bills(state, hold_expires_at);
    CREATE INDEX idx_bills_group ON bills(bill_group_id);
    CREATE INDEX idx_bills_terminal_date ON bills(terminal_id, document_date_key);

    CREATE TABLE bill_lines (
      bill_id             TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      line_no             INTEGER NOT NULL,
      description         TEXT NOT NULL,
      hsn_sac             TEXT,
      qty                 REAL NOT NULL DEFAULT 1,
      uom                 TEXT,
      unit_price_minor    INTEGER,
      gst_rate_bp         INTEGER,
      taxable_value_minor INTEGER,
      cgst_minor          INTEGER,
      sgst_minor          INTEGER,
      igst_minor          INTEGER,
      cess_minor          INTEGER,
      discount_minor      INTEGER,
      line_total_minor    INTEGER NOT NULL,
      serial_number       TEXT,
      warranty_months     INTEGER,
      -- E4 partial return: warranty voids only on the returned lines.
      returned_qty        REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (bill_id, line_no)
    );

    -- R-03: the original extraction is always recoverable, so corrections are
    -- appended rows, never updates.
    CREATE TABLE bill_fields (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id        TEXT NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      field_path     TEXT NOT NULL,
      source         TEXT NOT NULL,
      confidence     REAL,
      original_value TEXT,
      flagged        INTEGER NOT NULL DEFAULT 0,
      note           TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX idx_bill_fields_bill ON bill_fields(bill_id);

    -- E4: bills are immutable, so every amendment is a new linked document.
    CREATE TABLE document_links (
      id                     TEXT PRIMARY KEY,
      from_bill_id           TEXT NOT NULL REFERENCES bills(id),
      to_bill_id             TEXT REFERENCES bills(id),
      -- Set when the target has not arrived yet (credit note out of order).
      to_document_number     TEXT,
      to_merchant_id         TEXT,
      relation               TEXT NOT NULL,
      target_line_nos        TEXT NOT NULL DEFAULT '[]',
      resolved               INTEGER NOT NULL DEFAULT 1,
      created_at             TEXT NOT NULL
    );
    CREATE INDEX idx_links_from ON document_links(from_bill_id);
    CREATE INDEX idx_links_to ON document_links(to_bill_id);
    CREATE INDEX idx_links_unresolved ON document_links(to_merchant_id, to_document_number) WHERE resolved = 0;

    -- ------------------------------------------------------------ claim tokens
    CREATE TABLE claim_tokens (
      id                 TEXT PRIMARY KEY,
      bill_id            TEXT NOT NULL REFERENCES bills(id),
      -- Only the hash is stored: a database read cannot be turned into a claim.
      token_hash         TEXT NOT NULL UNIQUE,
      issued_at          TEXT NOT NULL,
      expires_at         TEXT NOT NULL,
      consumed_at        TEXT,
      consumed_by_account_id TEXT REFERENCES accounts(id),
      -- E2: locally-signed tokens must still validate after an outage.
      offline_signed     INTEGER NOT NULL DEFAULT 0,
      scan_count         INTEGER NOT NULL DEFAULT 0,
      -- Open decision §9.05: high-value bills may need a second factor.
      requires_second_factor INTEGER NOT NULL DEFAULT 0,
      second_factor_hint TEXT
    );
    CREATE INDEX idx_claim_tokens_bill ON claim_tokens(bill_id);
    CREATE INDEX idx_claim_tokens_expiry ON claim_tokens(expires_at) WHERE consumed_at IS NULL;

    -- M-03: the server-side half of idempotent replay.
    CREATE TABLE idempotency_records (
      key            TEXT PRIMARY KEY,
      bill_id        TEXT,
      outcome        TEXT NOT NULL,
      response_json  TEXT NOT NULL,
      created_at     TEXT NOT NULL
    );

    -- E1: anything unclassified goes here, never to a customer.
    CREATE TABLE quarantine (
      id             TEXT PRIMARY KEY,
      terminal_id    TEXT,
      outlet_id      TEXT,
      stream_class   TEXT NOT NULL,
      reason         TEXT NOT NULL,
      confidence     REAL,
      preview        TEXT NOT NULL,
      raw_ref        TEXT,
      resolved_as    TEXT,
      resolved_at    TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX idx_quarantine_outlet ON quarantine(outlet_id, created_at DESC);

    -- R-01: photo capture is async with instant optimistic display.
    CREATE TABLE captures (
      id            TEXT PRIMARY KEY,
      account_id    TEXT NOT NULL REFERENCES accounts(id),
      image_ref     TEXT NOT NULL,
      state         TEXT NOT NULL,          -- queued|processing|needs_review|done|rejected
      reject_reason TEXT,
      bill_id       TEXT REFERENCES bills(id),
      screen_detected INTEGER NOT NULL DEFAULT 0,
      multi_document INTEGER NOT NULL DEFAULT 0,
      attempts      INTEGER NOT NULL DEFAULT 0,
      error         TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX idx_captures_account ON captures(account_id, created_at DESC);
    CREATE INDEX idx_captures_state ON captures(state);

    -- T-02: every read by a non-owner, visible to the owner.
    CREATE TABLE access_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id      TEXT,
      account_id   TEXT,
      actor_type   TEXT NOT NULL,   -- support|admin|automated_job|merchant|grant
      actor_id     TEXT NOT NULL,
      action       TEXT NOT NULL,
      reason       TEXT NOT NULL,
      visible_to_owner INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_access_log_account ON access_log(account_id, created_at DESC);
    CREATE INDEX idx_access_log_bill ON access_log(bill_id, created_at DESC);

    -- T-01: anything beyond the default is a scoped, expiring, revocable grant.
    CREATE TABLE grants (
      id          TEXT PRIMARY KEY,
      bill_id     TEXT NOT NULL REFERENCES bills(id),
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      granted_to_merchant_id TEXT,
      scope       TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      revoked_at  TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX idx_grants_bill ON grants(bill_id);

    -- E4: annotations live on the group so amendments never orphan them.
    CREATE TABLE annotations (
      id            TEXT PRIMARY KEY,
      bill_group_id TEXT NOT NULL,
      account_id    TEXT NOT NULL REFERENCES accounts(id),
      kind          TEXT NOT NULL,   -- note|tag|category|attachment
      value         TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX idx_annotations_group ON annotations(bill_group_id);

    -- T-03: rights requests with SLA timers.
    CREATE TABLE dpdp_requests (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES accounts(id),
      kind         TEXT NOT NULL,   -- access|correction|erasure|grievance
      state        TEXT NOT NULL,   -- received|in_progress|fulfilled|rejected
      detail       TEXT,
      sla_due_at   TEXT NOT NULL,
      resolved_at  TEXT,
      resolution   TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_dpdp_account ON dpdp_requests(account_id, created_at DESC);
    CREATE INDEX idx_dpdp_open ON dpdp_requests(state, sla_due_at);

    -- E4: a return after an export must flag the export, not diverge silently.
    CREATE TABLE exports (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES accounts(id),
      profile_id   TEXT,
      format       TEXT NOT NULL,
      financial_year TEXT,
      from_date_key TEXT,
      to_date_key   TEXT,
      bill_ids     TEXT NOT NULL,
      state        TEXT NOT NULL DEFAULT 'ready',
      stale        INTEGER NOT NULL DEFAULT 0,
      stale_reason TEXT,
      file_ref     TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX idx_exports_account ON exports(account_id, created_at DESC);

    CREATE TABLE notifications (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL REFERENCES accounts(id),
      bill_id     TEXT,
      kind        TEXT NOT NULL,
      title       TEXT NOT NULL,
      body        TEXT NOT NULL,
      suppressed_preview INTEGER NOT NULL DEFAULT 0,
      sent_at     TEXT NOT NULL,
      meta        TEXT
    );
    CREATE INDEX idx_notifications_account ON notifications(account_id, sent_at DESC);

    -- R-02: three years of history, first results under 200ms.
    CREATE VIRTUAL TABLE bills_fts USING fts5(
      bill_id UNINDEXED,
      merchant_text,
      item_text,
      document_number,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    `,
  },
  {
    id: '002_merchant_metrics',
    sql: `
    -- M-04 / E5: a merchant who cannot see their claim rate in week one churns
    -- in week two, so the counters are first-class rather than derived on demand.
    CREATE TABLE issuance_stats (
      outlet_id       TEXT NOT NULL,
      date_key        TEXT NOT NULL,
      bills_issued    INTEGER NOT NULL DEFAULT 0,
      bills_claimed   INTEGER NOT NULL DEFAULT 0,
      paper_printed   INTEGER NOT NULL DEFAULT 0,
      paper_suppressed INTEGER NOT NULL DEFAULT 0,
      quarantined     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (outlet_id, date_key)
    );

    -- E5 "staff claim bills to their own account": a single account taking a
    -- high share of one terminal's bills is a flag, not a power user.
    CREATE TABLE terminal_claim_patterns (
      terminal_id  TEXT NOT NULL,
      account_id   TEXT NOT NULL,
      date_key     TEXT NOT NULL,
      claims       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (terminal_id, account_id, date_key)
    );
    `,
  },
  {
    id: '003_shared_copies',
    sql: `
    -- E1 split payment: the second payer's read-only copy repeats the original
    -- document number. It is not a second tax document, so the uniqueness rule
    -- that protects the merchant's invoice sequence must not apply to it.
    ALTER TABLE bills ADD COLUMN is_shared_copy INTEGER NOT NULL DEFAULT 0;
    DROP INDEX idx_bills_docnum_fy;
    CREATE UNIQUE INDEX idx_bills_docnum_fy
      ON bills(merchant_id, financial_year, document_number, document_type)
      WHERE document_number IS NOT NULL AND is_shared_copy = 0;
    `,
  },
];
