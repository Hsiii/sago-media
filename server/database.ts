import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { stateDirectory } from "./config";
import { now } from "./shared";

mkdirSync(stateDirectory, { recursive: true });

export const database = new Database(join(stateDirectory, "media.sqlite"), { create: true });
database.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
database.exec(`
  CREATE TABLE IF NOT EXISTS auth_requests (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    user_code TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    github_id TEXT,
    github_login TEXT,
    status TEXT NOT NULL DEFAULT 'waiting_for_login',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS oauth_states (
    state_hash TEXT PRIMARY KEY,
    purpose TEXT NOT NULL,
    request_id TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    github_id TEXT NOT NULL,
    github_login TEXT NOT NULL,
    device_name TEXT NOT NULL,
    scope TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    github_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    date TEXT NOT NULL,
    actor TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    uploads INTEGER NOT NULL,
    PRIMARY KEY(date, actor)
  );
`);

export function cleanExpired() {
  database.query("DELETE FROM auth_requests WHERE expires_at < ?").run(now());
  database.query("DELETE FROM oauth_states WHERE expires_at < ?").run(now());
  database.query("DELETE FROM sessions WHERE expires_at < ?").run(now());
}
