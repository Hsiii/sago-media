import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const port = positiveInteger("PORT", 3000);
const mediaRoot = process.env.PR_MEDIA_ROOT ?? "/srv/pr-media";
const stateDirectory = process.env.MEDIA_STATE_DIR ?? join(mediaRoot, ".service");
const tokenDirectory = process.env.PR_MEDIA_TOKEN_DIR ?? "/run/secrets/pr-media-tokens";
const uploadCommand = process.env.PR_MEDIA_UPLOAD_COMMAND ?? "/usr/local/bin/pr-media-upload";
const baseUrl = (process.env.PR_MEDIA_BASE_URL ?? "").replace(/\/$/, "");
const publicUrl = (process.env.MEDIA_PUBLIC_URL ?? baseUrl).replace(/\/$/, "");
const publicOrigin = (() => { try { return new URL(publicUrl).origin; } catch { return ""; } })();
const githubClientId = process.env.MEDIA_GITHUB_CLIENT_ID ?? "";
const githubClientSecret = process.env.MEDIA_GITHUB_CLIENT_SECRET ?? "";
const ownerGithubId = process.env.MEDIA_OWNER_GITHUB_ID ?? "";
const bootstrapAdminToken = process.env.MEDIA_ADMIN_TOKEN ?? "";
const dailyByteLimit = positiveInteger("PR_MEDIA_DAILY_BYTES_PER_TOKEN", 500_000_000);
const dailyUploadLimit = positiveInteger("PR_MEDIA_DAILY_UPLOADS_PER_TOKEN", 50);
const requestByteLimit = positiveInteger("PR_MEDIA_MAX_REQUEST_BYTES", 95_000_000);
const concurrentUploadLimit = positiveInteger("PR_MEDIA_MAX_CONCURRENT_UPLOADS", 2);
const supportedExtensions = new Set(["gif", "jpeg", "jpg", "mp4", "png", "webm", "webp"]);

mkdirSync(stateDirectory, { recursive: true });
const database = new Database(join(stateDirectory, "media.sqlite"), { create: true });
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
`);

let activeUploads = 0;

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function now() { return new Date().toISOString(); }
function future(minutes: number) { return new Date(Date.now() + minutes * 60_000).toISOString(); }
function randomToken(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function response(body: string, status = 200, headers: HeadersInit = {}) {
  return new Response(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers } });
}

function json(value: unknown, status = 200) {
  return response(`${JSON.stringify(value)}\n`, status, { "Content-Type": "application/json; charset=utf-8" });
}

function html(body: string, status = 200) {
  return response(`<!doctype html><meta name="viewport" content="width=device-width"><title>Sago Media</title><style>body{font:16px system-ui;max-width:720px;margin:64px auto;padding:0 24px;color:#18181b}main{display:grid;gap:16px}article{border:1px solid #ddd;border-radius:12px;padding:16px}button,a.button{background:#18181b;color:white;border:0;border-radius:8px;padding:10px 14px;text-decoration:none}code{background:#f4f4f5;padding:2px 6px;border-radius:4px}</style><main>${body}</main>`, status, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "Content-Type": "text/html; charset=utf-8" });
}

function cleanExpired() {
  database.query("DELETE FROM auth_requests WHERE expires_at < ?").run(now());
  database.query("DELETE FROM oauth_states WHERE expires_at < ?").run(now());
  database.query("DELETE FROM sessions WHERE expires_at < ?").run(now());
}

function loadLegacyTokens() {
  const tokens: Array<{ digest: string; name: string }> = [];
  try {
    for (const entry of readdirSync(tokenDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(entry.name)) continue;
      const value = readFileSync(join(tokenDirectory, entry.name), "utf8").trim();
      if (/^[0-9a-f]{64}$/.test(value)) tokens.push({ digest: value, name: entry.name });
    }
  } catch {}
  return tokens;
}

type Actor = { id: string; login: string; scope: "upload:pr" | "upload:any" };
function authenticate(request: Request): Actor | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return;
  const tokenHash = digest(match[1]);
  const credential = database.query("SELECT id, github_login, scope, token_hash FROM credentials WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) as { id: string; github_login: string; scope: Actor["scope"]; token_hash: string } | null;
  if (credential && safeEqual(credential.token_hash, tokenHash)) {
    database.query("UPDATE credentials SET last_used_at = ? WHERE id = ?").run(now(), credential.id);
    return { id: credential.id, login: credential.github_login, scope: credential.scope };
  }
  const legacy = loadLegacyTokens().find((item) => safeEqual(item.digest, tokenHash));
  if (legacy) return { id: `legacy-${legacy.name}`, login: legacy.name, scope: "upload:pr" };
}

function reserveQuota(actor: string, bytes: number) {
  const date = new Date().toISOString().slice(0, 10);
  database.exec("CREATE TABLE IF NOT EXISTS usage (date TEXT NOT NULL, actor TEXT NOT NULL, bytes INTEGER NOT NULL, uploads INTEGER NOT NULL, PRIMARY KEY(date, actor));");
  const usage = database.query("SELECT bytes, uploads FROM usage WHERE date = ? AND actor = ?").get(date, actor) as { bytes: number; uploads: number } | null;
  if ((usage?.bytes ?? 0) + bytes > dailyByteLimit || (usage?.uploads ?? 0) + 1 > dailyUploadLimit) return false;
  database.query("INSERT INTO usage(date, actor, bytes, uploads) VALUES (?, ?, ?, 1) ON CONFLICT(date, actor) DO UPDATE SET bytes = bytes + excluded.bytes, uploads = uploads + 1").run(date, actor, bytes);
  return true;
}

async function writeRequestBody(request: Request, destination: string) {
  if (!request.body) throw new Error("Request body is required");
  const writer = Bun.file(destination).writer();
  const reader = request.body.getReader();
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > requestByteLimit) throw new Error("Request body exceeds the upload limit");
      writer.write(value);
    }
  } finally { await writer.end(); }
  return received;
}

async function upload(request: Request, legacyResponse: boolean) {
  const actor = authenticate(request);
  if (!actor) return response("Unauthorized.\n", 401, { "WWW-Authenticate": "Bearer" });
  const repo = request.headers.get("x-media-repo") ?? request.headers.get("x-pr-media-repo") ?? "";
  const pr = request.headers.get("x-media-pr") ?? request.headers.get("x-pr-media-pr") ?? "";
  const filename = basename(request.headers.get("x-media-filename") ?? request.headers.get("x-pr-media-filename") ?? "");
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const hasContext = repo !== "" || pr !== "";
  if (!supportedExtensions.has(extension) || (hasContext && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || !/^[1-9][0-9]*$/.test(pr))) || (!hasContext && (legacyResponse || actor.scope === "upload:pr"))) return response("Invalid upload context or filename.\n", 400);
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return response("Content-Length is required.\n", 411);
  if (contentLength > requestByteLimit) return response("Upload exceeds the request size limit.\n", 413);
  if (activeUploads >= concurrentUploadLimit) return response("Too many uploads are active; retry shortly.\n", 429, { "Retry-After": "10" });
  if (!reserveQuota(actor.id, contentLength)) return response("Daily upload quota exceeded.\n", 429, { "Retry-After": "86400" });

  activeUploads += 1;
  const temporaryDirectory = mkdtempSync("/tmp/media-api.");
  const sourcePath = join(temporaryDirectory, `upload.${extension}`);
  try {
    const received = await writeRequestBody(request, sourcePath);
    if (received !== contentLength) return response("Content-Length did not match the uploaded body.\n", 400);
    const args = hasContext ? [uploadCommand, "--repo", repo, "--pr", pr, sourcePath] : [uploadCommand, sourcePath];
    const child = Bun.spawn(args, { env: process.env, stdout: "pipe", stderr: "pipe" });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (status !== 0) return response(`${stderr.trim().slice(0, 2000)}\n`, 422);
    const markdown = stdout.trim();
    const urls = [...markdown.matchAll(/https:\/\/[^)<>\s]+/g)].map((match) => match[0]);
    console.info(JSON.stringify({ actor: actor.login, bytes: received, event: "upload_completed", pr: pr || undefined, repo: repo || undefined }));
    if (legacyResponse) return response(`${markdown}\n`, 201);
    return json({ markdown, url: urls.at(-1), previewUrl: urls.length > 1 ? urls[0] : null }, 201);
  } finally {
    activeUploads -= 1;
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

function createDeviceRequest(request: Request) {
  cleanExpired();
  if (!githubClientId || !githubClientSecret || !ownerGithubId || !publicUrl) return json({ error: "device authorization is not configured" }, 503);
  const pending = database.query("SELECT COUNT(*) AS count FROM auth_requests").get() as { count: number };
  if (pending.count >= 100) return json({ error: "too many access requests are pending" }, 429);
  return request.json().then((body: { deviceName?: string }) => {
    const deviceName = (body.deviceName ?? "Unknown device").trim().slice(0, 80);
    if (!deviceName) return json({ error: "deviceName is required" }, 400);
    const id = randomToken(18);
    const secret = randomToken();
    const userCode = randomBytes(4).toString("hex").toUpperCase();
    database.query("INSERT INTO auth_requests(id, secret_hash, user_code, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, digest(secret), userCode, deviceName, now(), future(15));
    const origin = publicUrl || new URL(request.url).origin;
    return json({ deviceCode: id, deviceSecret: secret, userCode, verificationUri: `${origin}/activate?code=${userCode}`, expiresIn: 900, interval: 3 }, 201);
  }).catch(() => json({ error: "invalid JSON" }, 400));
}

function pollDevice(request: Request, id: string) {
  cleanExpired();
  const secret = /^Device (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const item = database.query("SELECT * FROM auth_requests WHERE id = ?").get(id) as Record<string, string> | null;
  if (!item || !safeEqual(item.secret_hash, digest(secret))) return json({ error: "invalid device request" }, 404);
  if (item.status === "denied") return json({ status: "denied" }, 403);
  if (item.status !== "approved") return json({ status: item.status });
  const token = randomToken(48);
  const credentialId = randomToken(12);
  const scope = item.github_id === ownerGithubId ? "upload:any" : "upload:pr";
  database.transaction(() => {
    database.query("INSERT INTO credentials(id, token_hash, github_id, github_login, device_name, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(credentialId, digest(token), item.github_id, item.github_login, item.device_name, scope, now());
    database.query("DELETE FROM auth_requests WHERE id = ?").run(id);
  })();
  return json({ status: "approved", token, scope });
}

function beginGithubOAuth(purpose: "activate" | "admin", requestId?: string) {
  if (!githubClientId || !githubClientSecret) return response("GitHub login is not configured.\n", 503);
  const state = randomToken();
  database.query("INSERT INTO oauth_states(state_hash, purpose, request_id, expires_at) VALUES (?, ?, ?, ?)").run(digest(state), purpose, requestId ?? null, future(10));
  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", githubClientId);
  redirect.searchParams.set("redirect_uri", `${publicUrl}/auth/github/callback`);
  redirect.searchParams.set("scope", "read:user");
  redirect.searchParams.set("state", state);
  return Response.redirect(redirect, 302);
}

async function finishGithubOAuth(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const stored = database.query("SELECT purpose, request_id FROM oauth_states WHERE state_hash = ? AND expires_at > ?").get(digest(state), now()) as { purpose: string; request_id: string | null } | null;
  if (!stored || !code) return response("Invalid or expired login.\n", 400);
  database.query("DELETE FROM oauth_states WHERE state_hash = ?").run(digest(state));
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: githubClientId, client_secret: githubClientSecret, code }) });
  const accessToken = (await tokenResponse.json() as { access_token?: string }).access_token;
  if (!accessToken) return response("GitHub login failed.\n", 502);
  const githubResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "User-Agent": "sago-media" } });
  const user = await githubResponse.json() as { id?: number; login?: string };
  if (!user.id || !user.login) return response("Could not read GitHub identity.\n", 502);
  const githubId = String(user.id);
  if (stored.purpose === "activate" && stored.request_id) {
    database.query("UPDATE auth_requests SET github_id = ?, github_login = ?, status = ? WHERE id = ?").run(githubId, user.login, githubId === ownerGithubId ? "approved" : "pending_approval", stored.request_id);
    return html(`<h1>Request received</h1><p>Signed in as <strong>${escapeHtml(user.login)}</strong>.</p><p>${githubId === ownerGithubId ? "Return to the CLI to finish." : "Hsi can now approve this device. You may close this page."}</p>`);
  }
  if (stored.purpose === "admin" && githubId === ownerGithubId) {
    const session = randomToken(48);
    database.query("INSERT INTO sessions(token_hash, github_id, expires_at) VALUES (?, ?, ?)").run(digest(session), githubId, future(60 * 24 * 30));
    return new Response(null, { status: 302, headers: { Location: "/admin", "Set-Cookie": `media_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` } });
  }
  return response("This GitHub account is not the service owner.\n", 403);
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function requestCode(url: URL) { return (url.searchParams.get("code") ?? "").toUpperCase().replace(/[^A-F0-9]/g, ""); }

function adminAuthorized(request: Request) {
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (bootstrapAdminToken && bearer && safeEqual(digest(bearer), digest(bootstrapAdminToken))) return true;
  const cookie = /(?:^|; )media_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!cookie) return false;
  return Boolean(database.query("SELECT 1 FROM sessions WHERE token_hash = ? AND github_id = ? AND expires_at > ?").get(digest(cookie), ownerGithubId, now()));
}

function bootstrapAuthorized(request: Request) {
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  return Boolean(bootstrapAdminToken && bearer && safeEqual(digest(bearer), digest(bootstrapAdminToken)));
}

function adminPage(request: Request) {
  if (!adminAuthorized(request)) return html('<h1>Sago Media</h1><p><a class="button" href="/admin/login">Sign in with GitHub</a></p>', 401);
  const pending = database.query("SELECT id, device_name, github_login, created_at FROM auth_requests WHERE status = 'pending_approval' ORDER BY created_at").all() as Array<Record<string, string>>;
  const credentials = database.query("SELECT id, github_login, device_name, scope, last_used_at FROM credentials WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as Array<Record<string, string>>;
  return html(`<h1>Sago Media</h1><h2>Pending access</h2>${pending.length ? pending.map((item) => `<article><strong>${escapeHtml(item.github_login)}</strong> · ${escapeHtml(item.device_name)}<form method="post" action="/admin/requests/${item.id}/approve"><button>Approve PR uploads</button></form><form method="post" action="/admin/requests/${item.id}/deny"><button>Deny</button></form></article>`).join("") : "<p>No pending requests.</p>"}<h2>Devices</h2>${credentials.map((item) => `<article><strong>${escapeHtml(item.github_login)}</strong> · ${escapeHtml(item.device_name)} · <code>${item.scope}</code><form method="post" action="/admin/credentials/${item.id}/revoke"><button>Revoke</button></form></article>`).join("") || "<p>No devices.</p>"}`);
}

function adminMutation(request: Request, pathname: string) {
  if (!adminAuthorized(request)) return response("Unauthorized.\n", 401);
  if (!bootstrapAuthorized(request) && request.headers.get("origin") !== publicOrigin) return response("Cross-origin administration is forbidden.\n", 403);
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

Bun.serve({ port, async fetch(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return baseUrl && publicOrigin && githubClientId && githubClientSecret && ownerGithubId ? response("ok\n") : response("configuration incomplete\n", 503);
  }
  if (request.method === "POST" && url.pathname === "/api/upload") return upload(request, true);
  if (request.method === "POST" && url.pathname === "/v1/uploads") return upload(request, false);
  if (request.method === "POST" && url.pathname === "/v1/auth/device") return createDeviceRequest(request);
  const device = /^\/v1\/auth\/device\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && device) return pollDevice(request, device[1]);
  if (request.method === "GET" && url.pathname === "/activate") {
    const item = database.query("SELECT id, user_code FROM auth_requests WHERE user_code = ? AND expires_at > ?").get(requestCode(url), now()) as { id: string; user_code: string } | null;
    if (!item) return html("<h1>Invalid or expired code</h1>", 404);
    return html(`<h1>Connect this device</h1><p>Code <code>${item.user_code}</code></p><p><a class="button" href="/auth/github?request=${item.id}">Continue with GitHub</a></p>`);
  }
  if (request.method === "GET" && url.pathname === "/auth/github") return beginGithubOAuth("activate", url.searchParams.get("request") ?? undefined);
  if (request.method === "GET" && url.pathname === "/auth/github/callback") return finishGithubOAuth(url);
  if (request.method === "GET" && url.pathname === "/admin/login") return beginGithubOAuth("admin");
  if (request.method === "GET" && url.pathname === "/admin") return adminPage(request);
  if (request.method === "POST" && url.pathname.startsWith("/admin/")) return adminMutation(request, url.pathname);
  return response("Not found.\n", 404);
} });
