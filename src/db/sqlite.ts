import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Db = Database.Database;

export interface OpenDbOptions {
  /** ':memory:' for tests. */
  path?: string;
  readonly?: boolean;
}

export function openDb(opts: OpenDbOptions = {}): Db {
  const path = opts.path ?? process.env.BILLING_HUB_DB ?? './data/billing-hub.sqlite';
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path, { readonly: opts.readonly ?? false });
  // WAL keeps the claim path readable while the agent is writing bills.
  if (path !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    db.prepare<[], { id: string }>('SELECT id FROM schema_migrations').all().map((r) => r.id),
  );
  const record = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.id, new Date().toISOString());
    })();
  }
}

/** Runs `fn` in a transaction; better-sqlite3 transactions are synchronous. */
export function tx<T>(db: Db, fn: () => T): T {
  return db.transaction(fn)();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function boolToInt(v: boolean): number {
  return v ? 1 : 0;
}

export function intToBool(v: number | null | undefined): boolean {
  return v === 1;
}
