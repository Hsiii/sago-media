import { Database } from "bun:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
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
  CREATE TABLE IF NOT EXISTS usage (
    date TEXT NOT NULL,
    actor TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    uploads INTEGER NOT NULL,
    PRIMARY KEY(date, actor)
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
  return response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Sago Media</title><style>${styles}</style></head><body>${body}</body></html>`, status, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "Content-Type": "text/html; charset=utf-8" });
}

const styles = `
  :root{color-scheme:light dark;--background:#fff;--surface:#fff;--surface-raised:#fafafa;--sidebar:#fafafa;--text:#1d1d1f;--muted:#666;--subtle:#8f8f8f;--line:#eaeaea;--line-strong:#d4d4d4;--button:#1d1d1f;--button-text:#fff;--success:#46a758;--danger:#e5484d;--idle:#c7c7c7;--radius:8px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:20px;--space-6:24px;--space-8:32px;--space-10:40px;--space-12:48px}
  @media(prefers-color-scheme:dark){:root{--background:#000;--surface:#0a0a0a;--surface-raised:#111;--sidebar:#050505;--text:#ededed;--muted:#a1a1a1;--subtle:#777;--line:#1f1f1f;--line-strong:#2e2e2e;--button:#ededed;--button-text:#0a0a0a;--success:#45a557;--danger:#ff6369;--idle:#555}}
  *{box-sizing:border-box}
  html{-webkit-font-smoothing:antialiased;background:var(--background)}
  body{margin:0;color:var(--text);background:var(--background);font:14px/1.5 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  button,a{font:inherit}
  a{color:inherit}
  button,.button{min-height:40px;border:0;border-radius:8px;padding:0 var(--space-4);display:inline-flex;align-items:center;justify-content:center;gap:var(--space-2);background:var(--button);color:var(--button-text);font-weight:500;text-decoration:none;cursor:pointer;transition-property:opacity,box-shadow,transform;transition-duration:160ms;transition-timing-function:cubic-bezier(.2,0,0,1)}
  button:hover,.button:hover{opacity:.88;box-shadow:0 2px 8px rgba(0,0,0,.14)}
  button:active,.button:active{transform:scale(.96)}
  button.secondary{background:var(--surface);color:var(--text);box-shadow:inset 0 0 0 1px var(--line-strong)}
  button.secondary:hover{background:var(--surface-raised)}
  button.danger{color:var(--danger)}
  code{background:var(--surface-raised);border-radius:4px;padding:4px 8px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
  .auth-shell{min-height:100vh;display:grid;place-items:center;padding:var(--space-6)}
  .auth-card{width:min(420px,100%);padding:var(--space-8);border:1px solid var(--line-strong);border-radius:16px;background:var(--surface);box-shadow:0 8px 32px rgba(0,0,0,.08);text-align:center}
  .auth-card h1{margin:0 0 var(--space-2);font-size:24px;letter-spacing:-.04em;text-wrap:balance}
  .auth-card p{margin:0 0 var(--space-5);color:var(--muted);text-wrap:pretty}
  .shell{min-height:100vh;padding-left:256px}
  .sidebar{width:256px;position:fixed;inset:0 auto 0 0;display:flex;flex-direction:column;padding:var(--space-3) var(--space-2);background:var(--sidebar);border-right:1px solid var(--line);z-index:20}
  .sidebar-team{height:40px;display:flex;align-items:center;gap:var(--space-3);padding:0 var(--space-2);font-weight:500}
  .sidebar-nav{display:grid;gap:var(--space-1);margin-top:var(--space-5)}
  .nav-link{height:36px;display:flex;align-items:center;gap:var(--space-3);padding:0 var(--space-3);border-radius:8px;color:var(--muted);text-decoration:none;transition-property:background-color,color;transition-duration:160ms}
  .nav-link svg{width:16px;height:16px}
  .nav-link:hover{background:var(--surface-raised);color:var(--text)}
  .nav-link.active{background:var(--surface);color:var(--text);box-shadow:0 0 0 1px var(--line)}
  .sidebar-label{padding:0 var(--space-3);margin:var(--space-6) 0 var(--space-2);font-size:11px;color:var(--subtle);text-transform:uppercase;letter-spacing:.06em}
  .sidebar-foot{margin-top:auto;padding:var(--space-3);border-radius:var(--radius);background:var(--surface);box-shadow:0 0 0 1px var(--line)}
  .sidebar-foot strong{display:block;font-size:12px;font-weight:500}
  .sidebar-foot span{display:block;margin-top:var(--space-1);color:var(--muted);font-size:11px}
  .topbar{height:64px;border-bottom:1px solid var(--line);display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:0 var(--space-8);position:sticky;top:0;background:color-mix(in srgb,var(--background) 90%,transparent);backdrop-filter:blur(12px);z-index:10}
  .topbar-context{font-weight:500}
  .topbar-title{font-size:13px;color:var(--muted)}
  .mark{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--button);color:var(--button-text);font-size:12px;letter-spacing:-.06em}
  .status{margin-left:auto;display:flex;align-items:center;justify-self:end;gap:var(--space-2);color:var(--muted);font-size:13px}
  .status-dot{width:8px;height:8px;border-radius:50%;background:var(--success);box-shadow:0 0 0 3px rgba(70,167,88,.12)}
  .page{width:min(1120px,100%);margin:0 auto;padding:var(--space-10) var(--space-8) var(--space-12)}
  .page-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--space-6);margin-bottom:var(--space-8)}
  h1,h2,h3,p{margin-top:0}
  h1{margin-bottom:var(--space-1);font-size:28px;line-height:1.25;letter-spacing:-.045em;text-wrap:balance}
  h2{margin:0;font-size:16px;letter-spacing:-.02em}
  h3{font-size:13px;font-weight:500;color:var(--muted);margin:0}
  .lede{margin:0;color:var(--muted);text-wrap:pretty}
  .eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--subtle)}
  .metrics{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line-strong);border-radius:var(--radius);overflow:hidden;margin-bottom:var(--space-6)}
  .metric{min-width:0;padding:var(--space-5);border-right:1px solid var(--line);background:var(--surface)}
  .metric:last-child{border-right:0}
  .metric-top{display:flex;align-items:center;justify-content:space-between;gap:var(--space-2);margin-bottom:var(--space-4)}
  .metric-icon{width:24px;height:24px;color:var(--subtle)}
  .metric-value{font-size:24px;line-height:1.1;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums;white-space:nowrap}
  .metric-note{margin:var(--space-2) 0 0;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .meter{height:4px;background:var(--line);border-radius:2px;overflow:hidden;margin-top:var(--space-4)}
  .meter-fill{height:100%;min-width:2px;border-radius:2px;background:var(--text)}
  .dashboard-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,1fr);align-items:start;gap:var(--space-6);margin-bottom:var(--space-8)}
  .stack{display:grid;gap:var(--space-6)}
  .card{min-width:0;border:1px solid var(--line-strong);border-radius:var(--radius);background:var(--surface);overflow:hidden}
  .card-head{min-height:64px;padding:var(--space-4) var(--space-5);display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);border-bottom:1px solid var(--line)}
  .card-title p{font-size:12px;color:var(--muted);margin:var(--space-1) 0 0}
  .chart-wrap{padding:var(--space-5) var(--space-5) var(--space-3)}
  .chart-summary{display:flex;align-items:baseline;gap:var(--space-2);margin-bottom:var(--space-5)}
  .chart-total{font-size:28px;line-height:1;font-weight:600;letter-spacing:-.045em;font-variant-numeric:tabular-nums}
  .chart-label{color:var(--muted);font-size:12px}
  .chart{display:block;width:100%;height:180px;overflow:visible}
  .grid-line{stroke:var(--line);stroke-width:1}
  .area{fill:url(#area-gradient)}
  .line{fill:none;stroke:var(--text);stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .point{fill:var(--surface);stroke:var(--text);stroke-width:2}
  .axis{display:flex;justify-content:space-between;color:var(--subtle);font-size:11px;margin-top:var(--space-2);font-variant-numeric:tabular-nums}
  .bars{height:132px;display:flex;align-items:end;gap:var(--space-2);padding-top:var(--space-3)}
  .bar-wrap{height:100%;flex:1;display:flex;align-items:end;position:relative}
  .bar{width:100%;min-height:2px;border-radius:4px 4px 0 0;background:var(--line-strong);transition-property:background-color,transform;transition-duration:160ms;transform-origin:bottom}
  .bar-wrap:hover .bar{background:var(--text);transform:scaleY(1.03)}
  .legend{display:flex;align-items:center;gap:var(--space-5);font-size:12px;color:var(--muted)}
  .legend-item{display:flex;align-items:center;gap:var(--space-2)}
  .legend-dot{width:8px;height:8px;border-radius:50%;background:var(--text)}
  .capacity{padding:var(--space-5)}
  .capacity-value{font-size:28px;line-height:1;font-weight:600;letter-spacing:-.045em;font-variant-numeric:tabular-nums;margin-bottom:var(--space-2)}
  .capacity-copy{color:var(--muted);font-size:12px;margin-bottom:var(--space-6)}
  .capacity-bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;display:flex}
  .capacity-used{height:100%;background:var(--text)}
  .capacity-key{display:flex;justify-content:space-between;gap:var(--space-4);margin-top:var(--space-3);font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
  .quota-list{display:grid;gap:var(--space-4);margin-top:var(--space-6)}
  .quota-row{display:grid;grid-template-columns:1fr auto;gap:var(--space-2);font-size:12px}
  .quota-row strong{font-variant-numeric:tabular-nums;font-weight:500}
  .quota-row .meter{grid-column:1/-1;margin:0}
  .section{margin-top:var(--space-8)}
  .section-head{display:flex;align-items:center;justify-content:space-between;gap:var(--space-4);margin-bottom:var(--space-4)}
  .count{display:inline-flex;align-items:center;justify-content:center;min-width:24px;height:20px;padding:0 var(--space-2);border-radius:12px;background:var(--surface-raised);color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
  .pending{padding:var(--space-4) var(--space-5);display:flex;align-items:center;gap:var(--space-4);border-bottom:1px solid var(--line)}
  .pending:last-child{border-bottom:0}
  .pending-info{min-width:0;flex:1}
  .pending-info strong{display:block;font-weight:500}
  .pending-info span{color:var(--muted);font-size:12px}
  .actions{display:flex;gap:var(--space-2)}
  .empty{padding:var(--space-8);text-align:center;color:var(--muted)}
  .empty-icon{width:32px;height:32px;margin:0 auto var(--space-3);color:var(--subtle)}
  .table-wrap{overflow-x:auto}
  table{width:100%;border-collapse:collapse;text-align:left}
  th{height:40px;padding:0 var(--space-5);border-bottom:1px solid var(--line);color:var(--subtle);font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.06em}
  td{height:64px;padding:0 var(--space-5);border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:0}
  tbody tr{transition-property:background-color;transition-duration:160ms}
  tbody tr:hover{background:var(--surface-raised)}
  .device{display:flex;align-items:center;gap:var(--space-3);min-width:180px}
  .device-icon{width:32px;height:32px;flex:0 0 auto;border-radius:8px;display:grid;place-items:center;background:var(--surface-raised);color:var(--muted);box-shadow:inset 0 0 0 1px var(--line)}
  .device-icon svg{width:16px;height:16px}
  .device strong,.user strong{display:block;font-weight:500;white-space:nowrap}
  .device span,.user span{display:block;color:var(--muted);font-size:12px;white-space:nowrap}
  .scope{display:inline-flex;align-items:center;height:24px;padding:0 var(--space-2);border-radius:4px;background:var(--surface-raised);font:11px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap}
  .live{display:inline-flex;align-items:center;gap:var(--space-2);color:var(--muted);white-space:nowrap}
  .live-dot{width:8px;height:8px;border-radius:50%;background:var(--success)}
  .live-dot.idle{background:var(--idle)}
  .table-action button{opacity:0;transition-property:opacity,background-color,transform}
  tr:hover .table-action button,.table-action button:focus-visible{opacity:1}
  .footnote{color:var(--subtle);font-size:11px;margin:var(--space-4) 0 0;text-align:right}
  @media(max-width:1000px){.shell{padding-left:0}.sidebar{display:none}.metrics{grid-template-columns:repeat(2,1fr)}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}.dashboard-grid{grid-template-columns:1fr}.table-action button{opacity:1}}
  @media(max-width:600px){.topbar{grid-template-columns:1fr auto;padding:0 var(--space-4)}.topbar-title{display:none}.page{padding:var(--space-8) var(--space-4)}.page-heading{display:block}.page-heading .eyebrow{display:block;margin-top:var(--space-3)}.status{font-size:0}.metrics{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.metric:nth-child(2){border-right:0}.metric:last-child{border-bottom:0}.pending{align-items:flex-start;flex-wrap:wrap}.actions{width:100%}.actions form{flex:1}.actions button{width:100%}th,td{padding-left:var(--space-4);padding-right:var(--space-4)}.hide-mobile{display:none}}
  @media(prefers-reduced-motion:reduce){button,.button,.bar,tbody tr,.table-action button{transition-duration:0ms}}
`;

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
    return html(authPage("Request received", `Signed in as <strong>${escapeHtml(user.login)}</strong>. ${githubId === ownerGithubId ? "Return to the CLI to finish." : "Hsi can now approve this device. You may close this page."}`));
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

function authPage(title: string, copy: string, action = "") {
  return `<main class="auth-shell"><section class="auth-card"><div class="mark" style="margin:0 auto 16px">SM</div><h1>${title}</h1><p>${copy}</p>${action}</section></main>`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
  const value = bytes / 1000 ** unit;
  return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function relativeTime(value: string | null) {
  if (!value) return "Never";
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "Just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}

function percent(value: number, total: number) {
  return total > 0 ? Math.min(100, Math.max(0, value / total * 100)) : 0;
}

function storedMediaBytes() {
  let bytes = 0;
  try {
    for (const prefix of readdirSync(mediaRoot, { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) continue;
      for (const file of readdirSync(join(mediaRoot, prefix.name), { withFileTypes: true })) {
        if (file.isFile() && /^[0-9a-f]{64}\.(gif|jpe?g|mp4|png|webm|webp)$/.test(file.name)) bytes += statSync(join(mediaRoot, prefix.name, file.name)).size;
      }
    }
  } catch {}
  return bytes;
}

function icon(name: "activity" | "database" | "devices" | "upload" | "laptop" | "inbox") {
  const paths = {
    activity: '<path d="M3 12h4l2.5-7 5 14 2.5-7h4"/>',
    database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    devices: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    upload: '<path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14"/>',
    laptop: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M2 19h20"/>',
    inbox: '<path d="M4 5h16l2 10v4H2v-4L4 5Z"/><path d="M2 15h5l2 2h6l2-2h5"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

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

function sameOriginAdminRequest(request: Request) {
  return request.headers.get("origin") === publicOrigin || request.headers.get("sec-fetch-site") === "same-origin";
}

function adminPage(request: Request) {
  if (!adminAuthorized(request)) return html(authPage("Sago Media", "Sign in with the owner GitHub account to manage usage and devices.", '<a class="button" href="/admin/login">Continue with GitHub</a>'), 401);
  const pending = database.query("SELECT id, device_name, github_login, created_at FROM auth_requests WHERE status = 'pending_approval' ORDER BY created_at").all() as Array<Record<string, string>>;
  const credentials = database.query("SELECT id, github_login, device_name, scope, created_at, last_used_at FROM credentials WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as Array<Record<string, string | null>>;
  const historyDates = Array.from({ length: 14 }, (_, index) => new Date(Date.now() - (13 - index) * 86_400_000).toISOString().slice(0, 10));
  const usageRows = database.query("SELECT date, SUM(bytes) AS bytes, SUM(uploads) AS uploads FROM usage WHERE date >= ? GROUP BY date ORDER BY date").all(historyDates[0]) as Array<{ date: string; bytes: number; uploads: number }>;
  const usageByDate = new Map(usageRows.map((row) => [row.date, row]));
  const history = historyDates.map((date) => usageByDate.get(date) ?? { date, bytes: 0, uploads: 0 });
  const totals = database.query("SELECT COALESCE(SUM(bytes), 0) AS bytes, COALESCE(SUM(uploads), 0) AS uploads FROM usage").get() as { bytes: number; uploads: number };
  const today = history.at(-1)!;
  const legacyDeviceCount = loadLegacyTokens().length;
  const quotaDeviceCount = Math.max(1, credentials.length + legacyDeviceCount);
  const dailyBytesCapacity = dailyByteLimit * quotaDeviceCount;
  const dailyUploadsCapacity = dailyUploadLimit * quotaDeviceCount;
  const activeDevices = credentials.filter((item) => item.last_used_at && Date.now() - new Date(item.last_used_at).getTime() < 7 * 86_400_000).length;
  const recentUsage = database.query("SELECT actor, SUM(bytes) AS bytes, SUM(uploads) AS uploads FROM usage WHERE date >= ? GROUP BY actor").all(historyDates[0]) as Array<{ actor: string; bytes: number; uploads: number }>;
  const usageByActor = new Map(recentUsage.map((item) => [item.actor, item]));
  const mediaBytes = storedMediaBytes();

  const maxBytes = Math.max(...history.map((item) => item.bytes), 1);
  const points = history.map((item, index) => {
    const x = index / (history.length - 1) * 600;
    const y = 156 - item.bytes / maxBytes * 132;
    return [x, y] as const;
  });
  const linePath = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L600 156 L0 156 Z`;
  const maxUploads = Math.max(...history.map((item) => item.uploads), 1);
  const firstDate = new Date(`${historyDates[0]}T00:00:00Z`);
  const lastDate = new Date(`${historyDates.at(-1)}T00:00:00Z`);
  const formatDate = (date: Date) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(date);
  const bandwidthPercent = percent(today.bytes, dailyBytesCapacity);
  const uploadPercent = percent(today.uploads, dailyUploadsCapacity);

  const pendingMarkup = pending.length ? pending.map((item) => `<div class="pending"><div class="device-icon">${icon("laptop")}</div><div class="pending-info"><strong>${escapeHtml(item.github_login)}</strong><span>${escapeHtml(item.device_name)} · requested ${relativeTime(item.created_at)}</span></div><div class="actions"><form method="post" action="/admin/requests/${item.id}/approve"><button>Approve</button></form><form method="post" action="/admin/requests/${item.id}/deny"><button class="secondary danger">Deny</button></form></div></div>`).join("") : `<div class="empty"><div class="empty-icon">${icon("inbox")}</div><strong>No pending requests</strong><div>New device access requests will appear here.</div></div>`;
  const deviceMarkup = credentials.length ? credentials.map((item) => {
    const itemUsage = usageByActor.get(item.id) ?? { bytes: 0, uploads: 0 };
    const isActive = Boolean(item.last_used_at && Date.now() - new Date(item.last_used_at).getTime() < 7 * 86_400_000);
    return `<tr><td><div class="device"><div class="device-icon">${icon("laptop")}</div><div><strong>${escapeHtml(item.device_name)}</strong><span>Added ${relativeTime(item.created_at)}</span></div></div></td><td><div class="user"><strong>@${escapeHtml(item.github_login)}</strong><span>${item.scope === "upload:any" ? "Owner" : "Collaborator"}</span></div></td><td><span class="scope">${escapeHtml(item.scope)}</span></td><td class="hide-mobile"><strong style="font-weight:500;font-variant-numeric:tabular-nums">${itemUsage.uploads}</strong><div style="color:var(--muted);font-size:12px">${formatBytes(itemUsage.bytes)} · 14d</div></td><td><span class="live"><span class="live-dot${isActive ? "" : " idle"}"></span>${relativeTime(item.last_used_at)}</span></td><td class="table-action"><form method="post" action="/admin/credentials/${item.id}/revoke"><button class="secondary danger" aria-label="Revoke ${escapeHtml(item.device_name)}">Revoke</button></form></td></tr>`;
  }).join("") : `<tr><td colspan="6"><div class="empty"><div class="empty-icon">${icon("devices")}</div><strong>No registered devices</strong><div>Approved devices will appear here.</div></div></td></tr>`;

  return html(`<div class="shell">
    <aside class="sidebar"><div class="sidebar-team"><span class="mark">SM</span><span>Sago Media</span></div><nav class="sidebar-nav" aria-label="Dashboard"><a class="nav-link active" href="#overview">${icon("activity")} Overview</a><a class="nav-link" href="#usage">${icon("database")} Usage</a><a class="nav-link" href="#devices">${icon("devices")} Devices</a></nav><div class="sidebar-label">Service</div><nav class="sidebar-nav" style="margin-top:0"><a class="nav-link" href="/health">${icon("activity")} Health</a></nav><div class="sidebar-foot"><strong><span class="status-dot" style="display:inline-block;margin-right:8px"></span>Operational</strong><span>${concurrentUploadLimit} concurrent upload slots</span></div></aside>
    <header class="topbar"><div class="topbar-context">Sago Media</div><div class="topbar-title">Overview</div><div class="status"><span class="status-dot"></span>All systems operational</div></header>
    <main class="page">
      <div class="page-heading" id="overview"><div><h1>Usage overview</h1><p class="lede">Monitor media delivery, storage capacity, and connected devices.</p></div><span class="eyebrow">Last updated ${new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date())}</span></div>
      <section class="metrics" aria-label="Key statistics">
        <div class="metric"><div class="metric-top"><h3>Registered devices</h3><div class="metric-icon">${icon("devices")}</div></div><div class="metric-value">${credentials.length + legacyDeviceCount}</div><p class="metric-note">${activeDevices} active in the last 7 days${legacyDeviceCount ? ` · ${legacyDeviceCount} legacy` : ""}</p></div>
        <div class="metric"><div class="metric-top"><h3>Total uploads</h3><div class="metric-icon">${icon("upload")}</div></div><div class="metric-value">${totals.uploads.toLocaleString("en")}</div><p class="metric-note">${today.uploads.toLocaleString("en")} processed today</p></div>
        <div class="metric"><div class="metric-top"><h3>Today's transfer</h3><div class="metric-icon">${icon("activity")}</div></div><div class="metric-value">${formatBytes(today.bytes)}</div><p class="metric-note">of ${formatBytes(dailyBytesCapacity)} combined allowance</p><div class="meter"><div class="meter-fill" style="width:${bandwidthPercent.toFixed(1)}%"></div></div></div>
        <div class="metric"><div class="metric-top"><h3>Stored media</h3><div class="metric-icon">${icon("database")}</div></div><div class="metric-value">${formatBytes(mediaBytes)}</div><p class="metric-note">Actual files in the media store</p></div>
      </section>
      <div class="dashboard-grid" id="usage">
        <section class="card"><div class="card-head"><div class="card-title"><h2>Bandwidth</h2><p>Transferred across all devices</p></div><div class="legend"><span class="legend-item"><span class="legend-dot"></span>Transfer</span></div></div><div class="chart-wrap"><div class="chart-summary"><span class="chart-total">${formatBytes(history.reduce((sum, item) => sum + item.bytes, 0))}</span><span class="chart-label">last 14 days</span></div><svg class="chart" viewBox="0 0 600 168" preserveAspectRatio="none" role="img" aria-label="Bandwidth transfer over the last 14 days"><defs><linearGradient id="area-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".12"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><path class="grid-line" d="M0 24H600M0 68H600M0 112H600M0 156H600"/><path class="area" d="${areaPath}"/><path class="line" d="${linePath}"/>${points.map(([x, y]) => `<circle class="point" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3"/>`).join("")}</svg><div class="axis"><span>${formatDate(firstDate)}</span><span>${formatDate(new Date(`${historyDates[6]}T00:00:00Z`))}</span><span>${formatDate(lastDate)}</span></div></div></section>
        <div class="stack">
          <section class="card"><div class="card-head"><div class="card-title"><h2>Upload activity</h2><p>Requests processed each day</p></div><span class="count">14d</span></div><div class="chart-wrap"><div class="chart-summary"><span class="chart-total">${history.reduce((sum, item) => sum + item.uploads, 0).toLocaleString("en")}</span><span class="chart-label">uploads</span></div><div class="bars" aria-label="Daily uploads over the last 14 days">${history.map((item) => `<div class="bar-wrap" title="${item.date}: ${item.uploads} uploads"><div class="bar" style="height:${Math.max(2, item.uploads / maxUploads * 100).toFixed(1)}%"></div></div>`).join("")}</div><div class="axis"><span>${formatDate(firstDate)}</span><span>Today</span></div></div></section>
          <section class="card"><div class="card-head"><div class="card-title"><h2>Capacity</h2><p>Current service limits</p></div><span class="count">Live</span></div><div class="capacity"><div class="capacity-value">${formatBytes(today.bytes)}</div><div class="capacity-copy">of ${formatBytes(dailyBytesCapacity)} daily bandwidth used</div><div class="capacity-bar"><div class="capacity-used" style="width:${bandwidthPercent.toFixed(1)}%"></div></div><div class="capacity-key"><span>${bandwidthPercent.toFixed(1)}% used</span><span>${formatBytes(Math.max(0, dailyBytesCapacity - today.bytes))} remaining</span></div><div class="quota-list"><div class="quota-row"><span>Upload requests</span><strong>${today.uploads} / ${dailyUploadsCapacity}</strong><div class="meter"><div class="meter-fill" style="width:${uploadPercent.toFixed(1)}%"></div></div></div><div class="quota-row"><span>Concurrent uploads</span><strong>${activeUploads} / ${concurrentUploadLimit}</strong><div class="meter"><div class="meter-fill" style="width:${percent(activeUploads, concurrentUploadLimit).toFixed(1)}%"></div></div></div></div></div></section>
        </div>
      </div>
      <section class="section"><div class="section-head"><h2>Pending access <span class="count">${pending.length}</span></h2></div><div class="card">${pendingMarkup}</div></section>
      <section class="section" id="devices"><div class="section-head"><div><h2>Registered devices <span class="count">${credentials.length}</span></h2></div></div><div class="card table-wrap"><table><thead><tr><th>Device</th><th>Account</th><th>Scope</th><th class="hide-mobile">Usage</th><th>Last seen</th><th><span style="position:absolute;clip:rect(0 0 0 0)">Actions</span></th></tr></thead><tbody>${deviceMarkup}</tbody></table></div><p class="footnote">Usage is aggregated over the last 14 days · Quotas reset daily at 00:00 UTC</p></section>
    </main>
  </div>`);
}

function adminMutation(request: Request, pathname: string) {
  if (!adminAuthorized(request)) return response("Unauthorized.\n", 401);
  if (!bootstrapAuthorized(request) && !sameOriginAdminRequest(request)) return response("Cross-origin administration is forbidden.\n", 403);
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
    if (!item) return html(authPage("Invalid or expired code", "Request a new code from the Sago Media CLI and try again."), 404);
    return html(authPage("Connect this device", `Confirm code <code>${item.user_code}</code> to authorize this device.`, `<a class="button" href="/auth/github?request=${item.id}">Continue with GitHub</a>`));
  }
  if (request.method === "GET" && url.pathname === "/auth/github") return beginGithubOAuth("activate", url.searchParams.get("request") ?? undefined);
  if (request.method === "GET" && url.pathname === "/auth/github/callback") return finishGithubOAuth(url);
  if (request.method === "GET" && url.pathname === "/admin/login") return beginGithubOAuth("admin");
  if (request.method === "GET" && url.pathname === "/admin") return adminPage(request);
  if (request.method === "POST" && url.pathname.startsWith("/admin/")) return adminMutation(request, url.pathname);
  return response("Not found.\n", 404);
} });
