import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { adminAuthorized, adminMutationAuthorized, loadLegacyTokens } from "./auth";
import { config, webRoot } from "./config";
import { database } from "./database";
import { authPage, html, json, now, response } from "./shared";
import { getActiveUploads } from "./uploads";

const dashboardHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
};

function storedMediaBytes() {
  let bytes = 0;
  try {
    for (const prefix of readdirSync(config.mediaRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      for (const file of readdirSync(join(config.mediaRoot, prefix.name), { withFileTypes: true })) {
        if (file.isFile() && /^[0-9a-f]{64}\.(gif|jpe?g|mp4|png|webm|webp)$/.test(file.name)) bytes += statSync(join(config.mediaRoot, prefix.name, file.name)).size;
      }
    }
  } catch {}
  return bytes;
}

export async function dashboardPage(request: Request) {
  if (!adminAuthorized(request)) return html(authPage("Sago Media", "Sign in with the owner GitHub account to manage usage and devices.", '<a href="/admin/login">Continue with GitHub</a>'), 401);
  const file = Bun.file(join(webRoot, "index.html"));
  if (!await file.exists()) return response("Dashboard assets are not built. Run bun run build:web.\n", 503);
  return new Response(file, { headers: dashboardHeaders });
}

export async function dashboardAsset(pathname: string) {
  const filename = basename(pathname);
  if (!/^[A-Za-z0-9._-]+$/.test(filename)) return response("Not found.\n", 404);
  const directory = pathname.startsWith("/admin/assets/") ? join(webRoot, "assets") : webRoot;
  const file = Bun.file(join(directory, filename));
  if (!await file.exists()) return response("Not found.\n", 404);
  return new Response(file, { headers: { "Cache-Control": pathname.startsWith("/admin/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
}

export function dashboardOverview(request: Request) {
  if (!adminAuthorized(request)) return json({ error: "unauthorized" }, 401);
  const pending = database.query("SELECT id, device_name, github_login, created_at FROM auth_requests WHERE status = 'pending_approval' ORDER BY created_at").all() as Array<{ id: string; device_name: string; github_login: string; created_at: string }>;
  const credentials = database.query("SELECT id, github_login, device_name, scope, created_at, last_used_at FROM credentials WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as Array<{ id: string; github_login: string; device_name: string; scope: "upload:pr" | "upload:any"; created_at: string; last_used_at: string | null }>;
  const historyDates = Array.from({ length: 14 }, (_, index) => new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(0, 10));
  const usageRows = database.query("SELECT date, SUM(bytes) AS bytes, SUM(uploads) AS uploads FROM usage WHERE date >= ? GROUP BY date ORDER BY date").all(historyDates[0]) as Array<{ date: string; bytes: number; uploads: number }>;
  const usageByDate = new Map(usageRows.map((row) => [row.date, row]));
  const history = historyDates.map((date) => usageByDate.get(date) ?? { date, bytes: 0, uploads: 0 });
  const totals = database.query("SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(uploads), 0) AS uploads FROM usage").get() as { bytes: number; uploads: number };
  const recentUsage = database.query("SELECT actor, SUM(bytes) AS bytes, SUM(uploads) AS uploads FROM usage WHERE date >= ? GROUP BY actor").all(historyDates[0]) as Array<{ actor: string; bytes: number; uploads: number }>;
  const usageByActor = new Map(recentUsage.map((item) => [item.actor, item]));
  const legacyDevices = loadLegacyTokens().length;
  const quotaDevices = Math.max(1, credentials.length + legacyDevices);
  const today = history.at(-1)!;

  return json({
    generatedAt: now(),
    status: { activeUploads: getActiveUploads(), concurrentUploadLimit: config.concurrentUploadLimit },
    stats: {
      registeredDevices: credentials.length + legacyDevices,
      activeDevices: credentials.filter((item) => item.last_used_at && Date.now() - new Date(item.last_used_at).getTime() < 7 * 86_400_000).length,
      legacyDevices,
      totalUploads: totals.uploads,
      totalBytes: totals.bytes,
      todayUploads: today.uploads,
      todayBytes: today.bytes,
      dailyByteCapacity: config.dailyByteLimit * quotaDevices,
      dailyUploadCapacity: config.dailyUploadLimit * quotaDevices,
      storedMediaBytes: storedMediaBytes(),
    },
    history,
    pending: pending.map((item) => ({ id: item.id, deviceName: item.device_name, githubLogin: item.github_login, createdAt: item.created_at })),
    devices: credentials.map((item) => {
      const usage = usageByActor.get(item.id) ?? { bytes: 0, uploads: 0 };
      return { id: item.id, deviceName: item.device_name, githubLogin: item.github_login, scope: item.scope, createdAt: item.created_at, lastUsedAt: item.last_used_at ?? undefined, bytes: usage.bytes, uploads: usage.uploads };
    }),
  });
}

export function dashboardMutation(request: Request, pathname: string) {
  if (!adminAuthorized(request)) return json({ error: "unauthorized" }, 401);
  if (!adminMutationAuthorized(request)) return json({ error: "cross-origin administration is forbidden" }, 403);
  const approval = /^\/v1\/admin\/requests\/([^/]+)\/(approve|deny)$/.exec(pathname);
  if (approval) {
    database.query("UPDATE auth_requests SET status = ? WHERE id = ? AND status = 'pending_approval'").run(approval[2] === "approve" ? "approved" : "denied", approval[1]);
    return new Response(null, { status: 204 });
  }
  const revocation = /^\/v1\/admin\/credentials\/([^/]+)\/revoke$/.exec(pathname);
  if (revocation) {
    database.query("UPDATE credentials SET revoked_at = ? WHERE id = ?").run(now(), revocation[1]);
    return new Response(null, { status: 204 });
  }
  return json({ error: "not found" }, 404);
}

export function legacyDashboardMutation(request: Request, pathname: string) {
  if (!adminAuthorized(request)) return response("Unauthorized.\n", 401);
  if (!adminMutationAuthorized(request)) return response("Cross-origin administration is forbidden.\n", 403);
  const approval = /^\/admin\/requests\/([^/]+)\/(approve|deny)$/.exec(pathname);
  if (approval) {
    database.query("UPDATE auth_requests SET status = ? WHERE id = ? AND status = 'pending_approval'").run(approval[2] === "approve" ? "approved" : "denied", approval[1]);
    return new Response(null, { status: 303, headers: { Location: "/admin" } });
  }
  const revocation = /^\/admin\/credentials\/([^/]+)\/revoke$/.exec(pathname);
  if (revocation) {
    database.query("UPDATE credentials SET revoked_at = ? WHERE id = ?").run(now(), revocation[1]);
    return new Response(null, { status: 303, headers: { Location: "/admin" } });
  }
  return response("Not found.\n", 404);
}
