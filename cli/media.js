#!/usr/bin/env node

import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, hostname, platform } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const configPath = process.env.MEDIA_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sago-media", "config.json");

function usage() {
  console.error("Usage: sago-media auth login|status|logout [--url URL] | sago-media upload <path> [--repo OWNER/REPO --pr NUMBER] [--output url|markdown|json]");
  process.exit(2);
}

async function loadConfig() {
  try { return JSON.parse(await readFile(configPath, "utf8")); } catch { return {}; }
}

async function saveConfig(config) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
}

function openBrowser(url) {
  const command = platform() === "darwin" ? ["open", url] : platform() === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  spawn(command[0], command.slice(1), { detached: true, stdio: "ignore" }).unref();
}

async function login(args) {
  const existing = await loadConfig();
  let url = process.env.MEDIA_URL ?? existing.url ?? "https://media.hsichen.dev";
  if (args[0] === "--url" && args[1]) url = args[1]; else if (args.length) usage();
  url = url.replace(/\/$/, "");
  let device = existing.url === url ? existing.pending : undefined;
  if (!device) {
    const started = await fetch(`${url}/v1/auth/device`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceName: `${hostname()} (${platform()})` }) });
    if (!started.ok) throw new Error(await started.text());
    device = await started.json();
    await saveConfig({ url, pending: device });
    console.log(`Open ${device.verificationUri}`);
    console.log(`Code: ${device.userCode}`);
    openBrowser(device.verificationUri);
  } else {
    console.log(`Resuming request ${device.userCode}.`);
  }
  const deadline = Date.now() + Math.min(device.expiresIn * 1000, 120_000);
  while (Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, device.interval * 1000));
    const polled = await fetch(`${url}/v1/auth/device/${device.deviceCode}`, { headers: { Authorization: `Device ${device.deviceSecret}` } });
    const result = await polled.json();
    if (polled.status === 404) {
      await saveConfig({ url });
      throw new Error("The access request expired. Run login again to create a new request.");
    }
    if (result.status === "approved") {
      await saveConfig({ url, token: result.token, scope: result.scope });
      console.log(`Authenticated with ${result.scope} access.`);
      return;
    }
    if (result.status === "denied") {
      await saveConfig({ url });
      throw new Error("Access was denied.");
    }
  }
  console.log("Request is still pending. Run `sago-media auth login` again after approval.");
}

async function auth(command, args) {
  if (command === "login") return login(args);
  if (command === "logout") { await rm(configPath, { force: true }); console.log("Signed out."); return; }
  if (command === "status") {
    const quiet = args.length === 1 && args[0] === "--quiet";
    if (args.length && !quiet) usage();
    const config = await loadConfig();
    if (!config.url || !config.token) process.exitCode = 1;
    else if (!quiet) console.log(`Authenticated to ${config.url} with ${config.scope ?? "upload"} access.`);
    return;
  }
  usage();
}

async function upload(args) {
  const path = args.shift();
  if (!path) usage();
  let repo = "";
  let pr = "";
  let output = "url";
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (flag === "--repo" && value) repo = value;
    else if (flag === "--pr" && value) pr = value;
    else if (flag === "--output" && ["url", "markdown", "json"].includes(value)) output = value;
    else usage();
  }
  if ((repo && !pr) || (!repo && pr)) usage();
  const config = await loadConfig();
  if (!config.url || !config.token) throw new Error("Not authenticated. Run `npx sago-media auth login` first.");
  const sourcePath = resolve(path);
  const body = await readFile(sourcePath);
  const extension = extname(sourcePath).slice(1).toLowerCase();
  const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/octet-stream", "X-Media-Filename": `upload.${extension}` };
  if (repo) { headers["X-Media-Repo"] = repo; headers["X-Media-PR"] = pr; }
  let uploaded;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    uploaded = await fetch(`${config.url.replace(/\/$/, "")}/v1/uploads`, { method: "POST", headers, body });
    if (uploaded.status !== 429 || uploaded.headers.get("retry-after") === "86400" || attempt === 5) break;
    const retryAfter = Number(uploaded.headers.get("retry-after") ?? 1);
    await uploaded.arrayBuffer();
    const delay = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(retryAfter, 30) * 1000 : 1000;
    console.error(`Service busy; retrying in ${delay / 1000}s.`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
  }
  if (!uploaded.ok) throw new Error((await uploaded.text()).trim() || `Upload failed (${uploaded.status})`);
  const result = await uploaded.json();
  console.log(output === "json" ? JSON.stringify(result) : result[output]);
}

try {
  const [command, subcommand, ...args] = process.argv.slice(2);
  if (command === "auth") await auth(subcommand, args);
  else if (command === "upload") await upload([subcommand, ...args]);
  else usage();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
