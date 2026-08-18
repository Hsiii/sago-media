import { randomBytes } from "node:crypto";
import { config, publicOrigin, publicUrl } from "./config";
import { cleanExpired, database, deviceKey, normalizedDeviceName } from "./database";
import { authPage, digest, escapeHtml, future, html, json, now, randomToken, response, safeEqual } from "./shared";

export type Actor = { id: string; login: string };

export function authenticate(request: Request): Actor | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return;
  const tokenHash = digest(match[1]);
  const credential = database.query("SELECT id, github_login, token_hash FROM credentials WHERE token_hash = ? AND revoked_at IS NULL").get(tokenHash) as { id: string; github_login: string; token_hash: string } | null;
  if (credential && safeEqual(credential.token_hash, tokenHash)) {
    database.query("UPDATE credentials SET last_used_at = ? WHERE id = ?").run(now(), credential.id);
    return { id: credential.id, login: credential.github_login };
  }
}

export function createDeviceRequest(request: Request) {
  cleanExpired();
  if (!config.githubClientId || !config.githubClientSecret || !config.ownerGithubId || !publicUrl) return json({ error: "device authorization is not configured" }, 503);
  const pending = database.query("SELECT COUNT(*) AS count FROM auth_requests").get() as { count: number };
  if (pending.count >= 100) return json({ error: "too many access requests are pending" }, 429);
  return request.json().then((body: { deviceName?: string }) => {
    const deviceName = normalizedDeviceName((body.deviceName ?? "Unknown device").trim().slice(0, 80));
    if (!deviceName) return json({ error: "deviceName is required" }, 400);
    const id = randomToken(18);
    const secret = randomToken();
    const userCode = randomBytes(4).toString("hex").toUpperCase();
    database.query("INSERT INTO auth_requests(id, secret_hash, user_code, device_name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, digest(secret), userCode, deviceName, now(), future(15));
    const origin = publicUrl || new URL(request.url).origin;
    return json({ deviceCode: id, deviceSecret: secret, userCode, verificationUri: `${origin}/activate?code=${userCode}`, expiresIn: 900, interval: 3 }, 201);
  }).catch(() => json({ error: "invalid JSON" }, 400));
}

export function pollDevice(request: Request, id: string) {
  cleanExpired();
  const secret = /^Device (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const item = database.query("SELECT * FROM auth_requests WHERE id = ?").get(id) as Record<string, string> | null;
  if (!item || !safeEqual(item.secret_hash, digest(secret))) return json({ error: "invalid device request" }, 404);
  if (item.status === "denied") return json({ status: "denied" }, 403);
  if (item.status !== "approved") return json({ status: item.status });
  const token = randomToken(48);
  const credentialId = randomToken(12);
  const normalizedName = normalizedDeviceName(item.device_name);
  database.transaction(() => {
    database.query("UPDATE credentials SET revoked_at = ? WHERE github_id = ? AND device_key = ? AND revoked_at IS NULL").run(now(), item.github_id, deviceKey(normalizedName));
    database.query("INSERT INTO credentials(id, token_hash, github_id, github_login, device_name, device_key, scope, created_at) VALUES (?, ?, ?, ?, ?, ?, 'upload:any', ?)").run(credentialId, digest(token), item.github_id, item.github_login, normalizedName, deviceKey(normalizedName), now());
    database.query("DELETE FROM auth_requests WHERE id = ?").run(id);
  })();
  return json({ status: "approved", token });
}

export function beginGithubOAuth(purpose: "activate" | "admin", requestId?: string) {
  if (!config.githubClientId || !config.githubClientSecret || !publicUrl) return response("GitHub login is not configured.\n", 503);
  const state = randomToken();
  database.query("INSERT INTO oauth_states(state_hash, purpose, request_id, expires_at) VALUES (?, ?, ?, ?)").run(digest(state), purpose, requestId ?? null, future(10));
  const redirect = new URL("https://github.com/login/oauth/authorize");
  redirect.searchParams.set("client_id", config.githubClientId);
  redirect.searchParams.set("redirect_uri", `${publicUrl}/auth/github/callback`);
  redirect.searchParams.set("scope", "read:user");
  redirect.searchParams.set("state", state);
  return Response.redirect(redirect, 302);
}

export async function finishGithubOAuth(url: URL) {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const stored = database.query("SELECT purpose, request_id FROM oauth_states WHERE state_hash = ? AND expires_at > ?").get(digest(state), now()) as { purpose: string; request_id: string | null } | null;
  if (!stored || !code) return response("Invalid or expired login.\n", 400);
  database.query("DELETE FROM oauth_states WHERE state_hash = ?").run(digest(state));
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ client_id: config.githubClientId, client_secret: config.githubClientSecret, code, redirect_uri: `${publicUrl}/auth/github/callback` }) });
  const accessToken = (await tokenResponse.json() as { access_token?: string }).access_token;
  if (!accessToken) return response("GitHub login failed.\n", 502);
  const githubResponse = await fetch("https://api.github.com/user", { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "User-Agent": "sago-media" } });
  const user = await githubResponse.json() as { id?: number; login?: string };
  if (!user.id || !user.login) return response("Could not read GitHub identity.\n", 502);
  const githubId = String(user.id);
  if (stored.purpose === "activate" && stored.request_id) {
    database.query("UPDATE auth_requests SET github_id = ?, github_login = ?, status = ? WHERE id = ?").run(githubId, user.login, githubId === config.ownerGithubId ? "approved" : "pending_approval", stored.request_id);
    return html(authPage("Request received", `Signed in as <strong>${escapeHtml(user.login)}</strong>. ${githubId === config.ownerGithubId ? "Return to the CLI to finish." : "Hsi can now approve this device. You may close this page."}`));
  }
  if (stored.purpose === "admin" && githubId === config.ownerGithubId) {
    const session = randomToken(48);
    database.query("INSERT INTO sessions(token_hash, github_id, expires_at) VALUES (?, ?, ?)").run(digest(session), githubId, future(60 * 24 * 30));
    return new Response(null, { status: 302, headers: { Location: "/admin", "Set-Cookie": `media_session=${session}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000` } });
  }
  return response("This GitHub account is not the service owner.\n", 403);
}

export function adminAuthorized(request: Request) {
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (config.bootstrapAdminToken && bearer && safeEqual(digest(bearer), digest(config.bootstrapAdminToken))) return true;
  const cookie = /(?:^|; )media_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!cookie) return false;
  return Boolean(database.query("SELECT 1 FROM sessions WHERE token_hash = ? AND github_id = ? AND expires_at > ?").get(digest(cookie), config.ownerGithubId, now()));
}

export function adminMutationAuthorized(request: Request) {
  if (!adminAuthorized(request)) return false;
  const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
  if (config.bootstrapAdminToken && bearer && safeEqual(digest(bearer), digest(config.bootstrapAdminToken))) return true;
  return request.headers.get("origin") === publicOrigin || request.headers.get("sec-fetch-site") === "same-origin";
}
