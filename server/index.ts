import { dashboardAsset, dashboardMutation, dashboardOverview, dashboardPage, legacyDashboardMutation } from "./admin";
import { beginGithubOAuth, createDeviceRequest, finishGithubOAuth, pollDevice } from "./auth";
import { config, publicOrigin } from "./config";
import { database } from "./database";
import { authPage, html, requestCode, response } from "./shared";
import { upload } from "./uploads";

Bun.serve({ port: config.port, async fetch(request) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return config.baseUrl && publicOrigin && config.githubClientId && config.githubClientSecret && config.ownerGithubId ? response("ok\n") : response("configuration incomplete\n", 503);
  }
  if (request.method === "POST" && url.pathname === "/v1/uploads") return upload(request);
  if (request.method === "POST" && url.pathname === "/v1/auth/device") return createDeviceRequest(request);
  const device = /^\/v1\/auth\/device\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && device) return pollDevice(request, device[1]);
  if (request.method === "GET" && url.pathname === "/activate") {
    const item = database.query("SELECT id, user_code FROM auth_requests WHERE user_code = ? AND expires_at > ?").get(requestCode(url), new Date().toISOString()) as { id: string; user_code: string } | null;
    if (!item) return html(authPage("Invalid or expired code", "Request a new code from Sago Drop and try again."), 404);
    return html(authPage("Connect this device", `Confirm code <code>${item.user_code}</code> to authorize this device.`, `<a href="/auth/github?request=${item.id}">Continue with GitHub</a>`));
  }
  if (request.method === "GET" && url.pathname === "/auth/github") return beginGithubOAuth("activate", url.searchParams.get("request") ?? undefined);
  if (request.method === "GET" && url.pathname === "/auth/github/callback") return finishGithubOAuth(url);
  if (request.method === "GET" && url.pathname === "/admin/login") return beginGithubOAuth("admin");
  if (request.method === "GET" && (url.pathname === "/admin" || url.pathname === "/admin/")) return dashboardPage(request);
  if (request.method === "GET" && (url.pathname.startsWith("/admin/assets/") || url.pathname === "/admin/favicon.png")) return dashboardAsset(url.pathname);
  if (request.method === "GET" && url.pathname === "/v1/admin/overview") return dashboardOverview(request);
  if (request.method === "POST" && url.pathname.startsWith("/v1/admin/")) return dashboardMutation(request, url.pathname);
  if (request.method === "POST" && url.pathname.startsWith("/admin/")) return legacyDashboardMutation(request, url.pathname);
  return response("Not found.\n", 404);
} });
