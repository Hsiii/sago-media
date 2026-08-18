import { join } from "node:path";

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

export const config = {
  port: positiveInteger("PORT", 3000),
  mediaRoot: process.env.PR_MEDIA_ROOT ?? "/srv/pr-media",
  uploadCommand: process.env.PR_MEDIA_UPLOAD_COMMAND ?? "/usr/local/bin/pr-media-upload",
  baseUrl: (process.env.PR_MEDIA_BASE_URL ?? "").replace(/\/$/, ""),
  githubClientId: process.env.MEDIA_GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.MEDIA_GITHUB_CLIENT_SECRET ?? "",
  ownerGithubId: process.env.MEDIA_OWNER_GITHUB_ID ?? "",
  bootstrapAdminToken: process.env.MEDIA_ADMIN_TOKEN ?? "",
  dailyByteLimit: positiveInteger("PR_MEDIA_DAILY_BYTES_PER_TOKEN", 500_000_000),
  dailyUploadLimit: positiveInteger("PR_MEDIA_DAILY_UPLOADS_PER_TOKEN", 50),
  requestByteLimit: positiveInteger("PR_MEDIA_MAX_REQUEST_BYTES", 95_000_000),
  concurrentUploadLimit: positiveInteger("PR_MEDIA_MAX_CONCURRENT_UPLOADS", 2),
  uploadTimeoutMs: positiveInteger("PR_MEDIA_UPLOAD_TIMEOUT_MS", 900_000),
} as const;

export const stateDirectory = process.env.MEDIA_STATE_DIR ?? join(config.mediaRoot, ".service");
export const publicUrl = (process.env.MEDIA_PUBLIC_URL ?? config.baseUrl).replace(/\/$/, "");
export const publicOrigin = (() => {
  try { return new URL(publicUrl).origin; } catch { return ""; }
})();
export const webRoot = process.env.MEDIA_WEB_ROOT ?? join(process.cwd(), "web/dist");
