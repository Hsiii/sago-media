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
    device_key TEXT,
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

export function normalizedDeviceName(deviceName: string) {
  return deviceName.trim().replace(/\s+\((?:darwin|linux|win32)\)$/i, "");
}

export function deviceKey(deviceName: string) {
  return normalizedDeviceName(deviceName).normalize("NFKC").toLowerCase();
}

function migrateCredentialDevices() {
  const columns = database.query("PRAGMA table_info(credentials)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "device_key")) database.exec("ALTER TABLE credentials ADD COLUMN device_key TEXT");

  const credentials = database.query("SELECT id, github_id, device_name, revoked_at FROM credentials ORDER BY created_at DESC, id DESC").all() as Array<{ id: string; github_id: string; device_name: string; revoked_at: string | null }>;
  const activeDevices = new Set<string>();
  database.transaction(() => {
    for (const credential of credentials) {
      const name = normalizedDeviceName(credential.device_name);
      const key = deviceKey(name);
      const identity = `${credential.github_id}\0${key}`;
      const revokedAt = credential.revoked_at ?? (activeDevices.has(identity) ? now() : null);
      if (!revokedAt) activeDevices.add(identity);
      database.query("UPDATE credentials SET device_name = ?, device_key = ?, revoked_at = ? WHERE id = ?").run(name, key, revokedAt, credential.id);
    }
  })();
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS credentials_active_device ON credentials(github_id, device_key) WHERE revoked_at IS NULL");
}

migrateCredentialDevices();
database.query("UPDATE credentials SET revoked_at = ? WHERE scope = 'upload:pr' AND revoked_at IS NULL").run(now());

export function cleanExpired() {
  database.query("DELETE FROM auth_requests WHERE expires_at < ?").run(now());
  database.query("DELETE FROM oauth_states WHERE expires_at < ?").run(now());
  database.query("DELETE FROM sessions WHERE expires_at < ?").run(now());
}
