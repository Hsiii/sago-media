import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { authenticate } from "./auth";
import { config } from "./config";
import { database } from "./database";
import { json, response } from "./shared";

const supportedExtensions = new Set(["gif", "jpeg", "jpg", "mp4", "png", "webp"]);
let activeUploads = 0;

export function getActiveUploads() { return activeUploads; }

function reserveQuota(actor: string, bytes: number) {
  const date = new Date().toISOString().slice(0, 10);
  const usage = database.query("SELECT bytes, uploads FROM usage WHERE date = ? AND actor = ?").get(date, actor) as { bytes: number; uploads: number } | null;
  if ((usage?.bytes ?? 0) + bytes > config.dailyByteLimit || (usage?.uploads ?? 0) + 1 > config.dailyUploadLimit) return false;
  database.query("INSERT INTO usage(date, actor, bytes, uploads) VALUES (?, ?, ?, 1) ON CONFLICT(date, actor) DO UPDATE SET bytes = bytes + excluded.bytes, uploads = uploads + 1").run(date, actor, bytes);
  return true;
}

function releaseQuota(actor: string, bytes: number) {
  const date = new Date().toISOString().slice(0, 10);
  database.query("UPDATE usage SET bytes = MAX(0, bytes - ?), uploads = MAX(0, uploads - 1) WHERE date = ? AND actor = ?").run(bytes, date, actor);
  database.query("DELETE FROM usage WHERE date = ? AND actor = ? AND bytes = 0 AND uploads = 0").run(date, actor);
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

export async function upload(request: Request) {
  const actor = authenticate(request);
  if (!actor) return response("Unauthorized.\n", 401, { "WWW-Authenticate": "Bearer" });
  const filename = basename(request.headers.get("x-media-filename") ?? "");
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  if (!supportedExtensions.has(extension)) return response("Invalid filename.\n", 400);
  const contentLength = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) return response("Content-Length is required.\n", 411);
  if (contentLength > config.requestByteLimit) return response("Upload exceeds the request size limit.\n", 413);
  if (activeUploads >= config.concurrentUploadLimit) return response("Too many uploads are active; retry shortly.\n", 429, { "Retry-After": "10" });
  const temporaryDirectory = mkdtempSync("/tmp/media-api.");
  if (!reserveQuota(actor.id, contentLength)) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    return response("Daily upload quota exceeded.\n", 429, { "Retry-After": "86400" });
  }

  activeUploads += 1;
  const sourcePath = join(temporaryDirectory, `upload.${extension}`);
  let completed = false;
  try {
    const received = await writeRequestBody(request, sourcePath);
    if (received !== contentLength) return response("Content-Length did not match the uploaded body.\n", 400);
    const child = Bun.spawn({ cmd: [config.uploadCommand, sourcePath], detached: true, env: process.env, stdout: "pipe", stderr: "pipe" });
    const stdoutPromise = new Response(child.stdout).text();
    const stderrPromise = new Response(child.stderr).text();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, config.uploadTimeoutMs);
    const status = await child.exited;
    clearTimeout(timeout);
    if (timedOut) return response("Upload processing timed out.\n", 504);
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    if (status !== 0) return response(`${stderr.trim().slice(0, 2000)}\n`, 422);
    const markdown = stdout.trim();
    const urls = [...markdown.matchAll(/https:\/\/[^)<>\s]+/g)].map((match) => match[0]);
    console.info(JSON.stringify({ actor: actor.login, bytes: received, event: "upload_completed" }));
    completed = true;
    return json({ markdown, url: urls.at(-1), previewUrl: urls.length > 1 ? urls[0] : null }, 201);
  } finally {
    activeUploads -= 1;
    if (!completed) releaseQuota(actor.id, contentLength);
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

mkdirSync(config.mediaRoot, { recursive: true });
