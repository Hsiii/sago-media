import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function now() { return new Date().toISOString(); }
export function future(minutes: number) { return new Date(Date.now() + minutes * 60_000).toISOString(); }
export function randomToken(bytes = 32) { return randomBytes(bytes).toString("base64url"); }
export function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
export function requestCode(url: URL) {
  return (url.searchParams.get("code") ?? "").toUpperCase().replace(/[^A-F0-9]/g, "");
}

export function response(body: string, status = 200, headers: HeadersInit = {}) {
  return new Response(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...headers } });
}

export function json(value: unknown, status = 200) {
  return response(`${JSON.stringify(value)}\n`, status, { "Content-Type": "application/json; charset=utf-8" });
}

export function html(body: string, status = 200) {
  return response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><link rel="icon" type="image/png" href="/admin/favicon.png"><title>Sago Media</title><style>:root{color-scheme:light dark;font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#fff;color:#1d1d1f;--button-bg:#1d1d1f;--button-text:#fff}@media(prefers-color-scheme:dark){:root{background:#000;color:#ededed;--button-bg:#ededed;--button-text:#0a0a0a}}*{box-sizing:border-box}body{margin:0}.auth{min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);padding:32px;border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:16px;text-align:center}.mark{width:32px;height:32px;margin:0 auto 16px;border-radius:50%;display:block;object-fit:cover;outline:1px solid color-mix(in srgb,currentColor 10%,transparent);outline-offset:-1px}h1{margin:0 0 8px;font-size:24px;letter-spacing:-.04em;text-wrap:balance}p{margin:0 0 20px;color:color-mix(in srgb,currentColor 64%,transparent);line-height:1.5;text-wrap:pretty}a{min-height:40px;padding:0 16px;border-radius:8px;display:inline-flex;align-items:center;background:var(--button-bg);color:var(--button-text);text-decoration:none;font-weight:500}</style></head><body>${body}</body></html>`, status, { "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", "Content-Type": "text/html; charset=utf-8" });
}

export function authPage(title: string, copy: string, action = "") {
  return `<main class="auth"><section class="card"><img class="mark" src="/admin/favicon.png" alt=""><h1>${title}</h1><p>${copy}</p>${action}</section></main>`;
}
