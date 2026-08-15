import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { authenticate } from "./auth";
import { config } from "./config";
import { database } from "./database";
import { json, response } from "./shared";

const supportedExtensions = new Set(["gif", "jpeg", "jpg", "mp4", "png", "webm", "webp"]);
let activeUploads = 0;

export function getActiveUploads() { return activeUploads; }

function reserveQuota(actor: string, bytes: number) {
  const date = new Date().toISOString().slice(0, 10);
  const usage = database.query("SELECT bytes, uploads FROM usage WHERE date = ? AND actor = ?").get(date, actor) as { bytes: number; uploads: number } | null;
  if ((usage?.bytes ?? 0) + bytes > config.dailyByteLimit || (usage?.uploads ?? 0) + 1 > config.dailyUploadLimit) return false;
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
      if (received > config.requestByteLimit) throw new Error("Request body exceeds the upload limit");
      writer.write(value);
    }
  } finally { await writer.end(); }
  return received;
}

export async function upload(request: Request, legacyResponse: boolean) {
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
  if (contentLength > config.requestByteLimit) return response("Upload exceeds the request size limit.\n", 413);
  if (activeUploads >= config.concurrentUploadLimit) return response("Too many uploads are active; retry shortly.\n", 429, { "Retry-After": "10" });
  if (!reserveQuota(actor.id, contentLength)) return response("Daily upload quota exceeded.\n", 429, { "Retry-After": "86400" });

  activeUploads += 1;
  const temporaryDirectory = mkdtempSync("/tmp/media-api.");
  const sourcePath = join(temporaryDirectory, `upload.${extension}`);
  try {
    const received = await writeRequestBody(request, sourcePath);
    if (received !== contentLength) return response("Content-Length did not match the uploaded body.\n", 400);
    const args = hasContext ? [config.uploadCommand, "--repo", repo, "--pr", pr, sourcePath] : [config.uploadCommand, sourcePath];
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

mkdirSync(config.mediaRoot, { recursive: true });
