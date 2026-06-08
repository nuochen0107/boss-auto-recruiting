#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(__dirname, "public");
const CONFIG_FILE = path.join(PROJECT_ROOT, "boss-loop/assets/default-config.yaml");
const STATE_FILE = path.join(PROJECT_ROOT, "data/briefs/boss-auto-lightweight-loop-state.json");
const RUN_LOG_FILE = path.join(PROJECT_ROOT, "data/briefs/boss-auto-lightweight-loop-run.jsonl");
const SYNC_QUEUE_FILE = path.join(PROJECT_ROOT, "data/briefs/boss-auto-lightweight-loop-sync-queue.jsonl");
const RESUME_DIR = path.join(PROJECT_ROOT, "data/resumes");
const LOCK_DIR = path.join(PROJECT_ROOT, "data/briefs/boss-auto.lockdir");
const JOB_PROFILE_DIR = path.join(PROJECT_ROOT, "data/briefs/job-profiles");
const DEFAULT_PROXY = "http://127.0.0.1:3456";
const PORT = Number(process.env.BOSS_PANEL_PORT || 8787);
const COLLECT_STATUSES = new Set([
  "attachment_requested",
  "attachment_sent_by_candidate",
  "attachment_received",
  "download_failed",
  "paused_download_failed",
]);

let currentTask = null;
let taskHistory = [];
let proxyTask = null;

function readText(filePath, fallback = "") {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return fallback;
  }
}

function readYamlScalar(filePath, key) {
  const text = readText(filePath);
  const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return fallback;
  }
}

function isPidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockInfo() {
  if (!fs.existsSync(LOCK_DIR)) return { exists: false, stale: false };
  const metaFile = path.join(LOCK_DIR, "meta.json");
  const meta = readJson(metaFile, {});
  const pid = Number(meta.pid);
  const alive = isPidAlive(pid);
  let ageSeconds = 0;
  try {
    const stat = fs.statSync(LOCK_DIR);
    ageSeconds = Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000));
  } catch {}
  return {
    exists: true,
    stale: !alive,
    alive,
    pid: Number.isInteger(pid) ? pid : null,
    mode: meta.mode || "",
    startedAt: meta.started_at || "",
    ageSeconds,
    meta,
  };
}

function clearStaleLock({ force = false } = {}) {
  const info = readLockInfo();
  if (!info.exists) return { cleared: false, reason: "no_lock", lock: info };
  if (!force && !info.stale) return { cleared: false, reason: "lock_process_alive", lock: info };
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  return { cleared: true, lock: info };
}

function getConfiguredJobName() {
  const fromConfig = readYamlScalar(CONFIG_FILE, "job_name");
  if (fromConfig) return canonicalJobName(fromConfig);
  const state = readJson(STATE_FILE, {});
  return canonicalJobName(state?.config?.job_name || "");
}

function getCandidates(state) {
  if (Array.isArray(state)) return state.filter(Boolean);
  if (state?.candidates && typeof state.candidates === "object") return Object.values(state.candidates);
  return [];
}

function normalizeJobName(value) {
  return String(value || "").replace(/\s+/g, "").trim().toLowerCase();
}

function knownJobNames() {
  const state = readJson(STATE_FILE, { version: 1, candidates: {} });
  const fromState = getCandidates(state).map((candidate) => candidate.job_name).filter(Boolean);
  let fromProfiles = [];
  try {
    fromProfiles = fs.readdirSync(JOB_PROFILE_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.basename(name, ".json"));
  } catch {}
  return Array.from(new Set([...fromState, ...fromProfiles])).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function canonicalJobName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = normalizeJobName(raw);
  return knownJobNames().find((name) => normalizeJobName(name) === normalized) || raw;
}

function invalidCandidateName(name, jobName) {
  const value = String(name || "").trim();
  if (value.length < 2 || value.length > 8) return true;
  if (/^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系/.test(value)) return true;
  if (/^(今天|昨天|前天|刚刚|\d+分钟前|\d+小时前|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/.test(value)) return true;
  if (/^\d+\s*[-~]\s*\d+K$/i.test(value)) return true;
  if (/Python|Golang|Go|Java|C\+\+|Rust|JavaScript|TypeScript|React|Vue|Node\.js|Spring|Django|Flask|FastAPI|SQL|Linux/i.test(value)) return true;
  if (/后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(value)) return true;
  if (jobName && value.includes(jobName)) return true;
  return false;
}

function candidateNameJobKey(candidate) {
  return `${normalizeJobName(candidate?.name)}__${normalizeJobName(candidate?.job_name)}`;
}

function hasCompletedResume(candidate) {
  if (!candidate) return false;
  if (["resume_downloaded", "ready_for_hire_sync", "boss_completed"].includes(candidate.status)) return true;
  return !!(
    candidate.local_resume_path &&
    candidate.resume_hash &&
    fs.existsSync(candidate.local_resume_path)
  );
}

function requestExpired(candidate, ttlDays) {
  if (candidate?.status !== "attachment_requested") return false;
  const sentAt = Date.parse(candidate.message_sent_at || "");
  if (!Number.isFinite(sentAt)) return false;
  return Date.now() - sentAt > Math.max(0, Number(ttlDays) || 0) * 86400000;
}

function shouldCollectCandidate(candidate, jobName, completedKeys, ttlDays) {
  if (!candidate || typeof candidate !== "object") return false;
  if (!candidate.candidate_id || !candidate.name) return false;
  if (invalidCandidateName(candidate.name, jobName)) return false;
  if (!candidate.message_sent_at) return false;
  if (requestExpired(candidate, ttlDays)) return false;
  if (hasCompletedResume(candidate)) return false;
  if (completedKeys.has(candidateNameJobKey(candidate))) return false;
  return COLLECT_STATUSES.has(candidate.status);
}

function stateStats(jobName = "") {
  const state = readJson(STATE_FILE, { version: 1, candidates: {} });
  const candidates = getCandidates(state);
  const jobNames = knownJobNames();
  const canonicalJob = canonicalJobName(jobName);
  const filtered = canonicalJob ? candidates.filter((c) => !c.job_name || normalizeJobName(c.job_name) === normalizeJobName(canonicalJob)) : candidates;
  const ttlDays = Number(readYamlScalar(CONFIG_FILE, "collect_request_ttl_days") || 3);
  const completedKeys = new Set(
    candidates
      .filter(hasCompletedResume)
      .map(candidateNameJobKey),
  );
  const byStatus = {};
  const byDecision = {};
  for (const candidate of filtered) {
    const status = candidate.status || "unknown";
    const decision = candidate.decision || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
    byDecision[decision] = (byDecision[decision] || 0) + 1;
  }
  const collectTargets = filtered.filter((candidate) =>
    shouldCollectCandidate(candidate, jobName, completedKeys, ttlDays),
  );
  const expiredTargets = filtered.filter((candidate) => requestExpired(candidate, ttlDays));
  return {
    total: filtered.length,
    byStatus,
    byDecision,
    collectTargets: collectTargets.length,
    expiredTargets: expiredTargets.length,
    collectPreview: collectTargets.slice(0, 20).map((candidate) => ({
      id: candidate.candidate_id,
      name: candidate.name,
      school: candidate.school || "",
      status: candidate.status || "",
      messageSentAt: candidate.message_sent_at || "",
    })),
    jobNames,
    updatedAt: state?.updated_at || "",
  };
}

function queueStats() {
  const lines = readText(SYNC_QUEUE_FILE)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let pending = 0;
  let parsed = 0;
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      parsed += 1;
      if ((record.sync_queue_status || "pending") === "pending") pending += 1;
    } catch {}
  }
  return { totalLines: lines.length, parsed, pending };
}

function resumeStats() {
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of fs.readdirSync(RESUME_DIR, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(RESUME_DIR, entry.name);
      const stat = fs.statSync(filePath);
      count += 1;
      bytes += stat.size;
    }
  } catch {}
  return { count, bytes };
}

function tailLines(filePath, maxLines = 80) {
  const text = readText(filePath);
  if (!text.trim()) return [];
  return text.trimEnd().split(/\r?\n/).slice(-maxLines);
}

function parseLogLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { raw: line };
  }
}

async function proxyHealth() {
  const proxy = (readYamlScalar(CONFIG_FILE, "proxy_url") || DEFAULT_PROXY).replace(/\/$/, "");
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`${proxy}/targets`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return { ok: false, proxy, reason: `http_${response.status}` };
    const targets = await response.json();
    const bossTargets = Array.isArray(targets) ? targets.filter((target) => /zhipin\.com/.test(target.url || "")) : [];
    return { ok: true, proxy, targetCount: Array.isArray(targets) ? targets.length : 0, bossTargetCount: bossTargets.length };
  } catch (error) {
    return { ok: false, proxy, reason: error.name === "AbortError" ? "timeout" : String(error.message || error) };
  }
}

function findProxyProcesses() {
  let output = "";
  try {
    output = execFileSync("lsof", ["-ti", "tcp:3456"], { encoding: "utf8" });
  } catch {
    return [];
  }

  return output
    .split(/\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0)
    .map((pid) => {
      let command = "";
      try {
        command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
      } catch {}
      return { pid, command };
    })
    .filter(({ command }) => command.includes("deps/web-access/scripts/cdp-proxy.mjs"));
}

async function stopStaleProxyProcesses() {
  const processes = findProxyProcesses();
  for (const item of processes) {
    try {
      process.kill(item.pid, "SIGTERM");
    } catch {}
  }
  if (processes.length) await new Promise((resolve) => setTimeout(resolve, 500));
  return processes;
}

async function health() {
  const proxy = await proxyHealth();
  const configJobName = readYamlScalar(CONFIG_FILE, "job_name");
  const stateJobName = readJson(STATE_FILE, {})?.config?.job_name || "";
  const lock = readLockInfo();
  const checks = [
    { key: "project", label: "项目目录", ok: fs.existsSync(PROJECT_ROOT), detail: PROJECT_ROOT },
    { key: "config", label: "配置文件", ok: fs.existsSync(CONFIG_FILE), detail: CONFIG_FILE },
    { key: "state", label: "状态文件", ok: fs.existsSync(STATE_FILE), detail: STATE_FILE },
    { key: "log", label: "运行日志", ok: fs.existsSync(RUN_LOG_FILE), detail: RUN_LOG_FILE },
    { key: "resumeDir", label: "简历目录", ok: fs.existsSync(RESUME_DIR), detail: RESUME_DIR },
    { key: "jobName", label: "岗位名", ok: Boolean(configJobName || stateJobName), detail: configJobName || stateJobName || "未配置" },
    { key: "proxy", label: "CDP Proxy", ok: proxy.ok, detail: proxy.ok ? `${proxy.proxy}, Boss 页面 ${proxy.bossTargetCount} 个` : `${proxy.proxy}: ${proxy.reason}` },
    {
      key: "lock",
      label: "任务锁",
      ok: !lock.exists || lock.stale,
      detail: !lock.exists
        ? "未检测到任务锁"
        : lock.stale
          ? `检测到陈旧锁：PID ${lock.pid || "unknown"} 已不存在，可清理`
          : `任务锁存在：${lock.mode || "unknown"} PID ${lock.pid}`,
    },
  ];
  return { ok: checks.every((check) => check.ok), checks, proxy, lock };
}

async function startProxy() {
  const current = await proxyHealth();
  if (current.ok) return { started: false, status: "already_running", proxy: current };

  const restartedProcesses = await stopStaleProxyProcesses();
  if (proxyTask?.process && !proxyTask.process.killed) {
    try {
      proxyTask.process.kill("SIGTERM");
    } catch {}
    proxyTask = null;
  }

  const script = path.join(PROJECT_ROOT, "deps/web-access/scripts/cdp-proxy.mjs");
  if (!fs.existsSync(script)) {
    const error = new Error(`CDP Proxy 脚本不存在：${script}`);
    error.statusCode = 404;
    throw error;
  }

  const child = spawn("node", [script], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyTask = {
    startedAt: new Date().toISOString(),
    status: "starting",
    output: [],
    process: child,
  };

  child.stdout.on("data", (data) => {
    proxyTask?.output.push(String(data));
    if (proxyTask) proxyTask.output = proxyTask.output.slice(-120);
  });
  child.stderr.on("data", (data) => {
    proxyTask?.output.push(String(data));
    if (proxyTask) proxyTask.output = proxyTask.output.slice(-120);
  });
  child.on("close", (code) => {
    if (!proxyTask) return;
    proxyTask.status = code === 0 ? "stopped" : "failed";
    proxyTask.exitCode = code;
    proxyTask.endedAt = new Date().toISOString();
  });

  let after = { ok: false, proxy: DEFAULT_PROXY, reason: "starting" };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    after = await proxyHealth();
    if (after.ok || proxyTask?.status === "failed") break;
  }
  if (after.ok && proxyTask) proxyTask.status = "running";
  if (!after.ok && proxyTask?.status === "starting") proxyTask.status = "failed";
  return {
    started: true,
    status: proxyTask?.status || "unknown",
    proxy: after,
    restartedProcesses,
    output: proxyTask?.output.slice(-80) || [],
  };
}

function commandForAction(action, { jobName, dryRun, skipRecommend }) {
  const jobArgs = jobName ? ["--job-name", jobName] : [];
  const dryArgs = dryRun ? ["--dry-run"] : [];
  if (action === "greet") {
    return [{
      label: "筛选 / 打招呼 / 求简历",
      args: ["boss-loop/boss_lite_screen_and_greet.mjs", ...jobArgs, ...(skipRecommend ? ["--skip-recommend"] : []), ...dryArgs],
    }];
  }
  if (action === "collect") {
    return [{
      label: "收取附件简历",
      args: ["boss-loop/collect_visible_resumes.js", ...jobArgs, ...dryArgs],
    }];
  }
  if (action === "sync") {
    return [{
      label: "同步飞书",
      args: ["feishu-sync/sync-to-feishu.mjs", dryRun ? "--dry-run" : "--apply"],
    }];
  }
  if (action === "auto") {
    return [
      { label: "筛选 / 打招呼 / 求简历", args: ["boss-loop/boss_lite_screen_and_greet.mjs", ...jobArgs, ...(skipRecommend ? ["--skip-recommend"] : []), ...dryArgs] },
      { label: "收取附件简历", args: ["boss-loop/collect_visible_resumes.js", ...jobArgs, ...dryArgs] },
      { label: "同步飞书", args: ["feishu-sync/sync-to-feishu.mjs", dryRun ? "--dry-run" : "--apply"] },
    ];
  }
  throw new Error(`Unknown action: ${action}`);
}

function publicTask(task) {
  if (!task) return null;
  return {
    id: task.id,
    action: task.action,
    label: task.label,
    jobName: task.jobName,
    dryRun: task.dryRun,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    status: task.status,
    exitCode: task.exitCode,
    currentStep: task.currentStep,
    steps: task.steps.map(({ label, status, exitCode }) => ({ label, status, exitCode })),
    output: task.output.slice(-300),
  };
}

function outputHasLockExists(output) {
  return output.some((chunk) => /"reason"\s*:\s*"lock_exists"|lock_exists/.test(chunk));
}

function runStep(task, index) {
  if (index >= task.steps.length) {
    task.status = "completed";
    task.endedAt = new Date().toISOString();
    taskHistory.unshift(publicTask(task));
    taskHistory = taskHistory.slice(0, 10);
    currentTask = null;
    return;
  }

  const step = task.steps[index];
  task.currentStep = index;
  step.status = "running";
  task.output.push(`\n$ node ${step.args.join(" ")}\n`);

  const child = spawn("node", step.args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  task.child = child;

  child.stdout.on("data", (data) => {
    task.output.push(String(data));
  });
  child.stderr.on("data", (data) => {
    task.output.push(String(data));
  });
  child.on("error", (error) => {
    step.status = "failed";
    step.exitCode = 1;
    task.status = "failed";
    task.exitCode = 1;
    task.endedAt = new Date().toISOString();
    task.output.push(`\nERROR ${error.message}\n`);
    taskHistory.unshift(publicTask(task));
    taskHistory = taskHistory.slice(0, 10);
    currentTask = null;
  });
  child.on("close", (code) => {
    step.exitCode = code;
    const lockBlocked = outputHasLockExists(task.output);
    step.status = code === 0 && !lockBlocked ? "completed" : "failed";
    if (code !== 0 || lockBlocked) {
      task.status = "failed";
      task.exitCode = code ?? 1;
      task.endedAt = new Date().toISOString();
      if (lockBlocked) task.output.push("\n任务被本地运行锁阻止。请确认没有任务正在运行；如果没有，请清理陈旧任务锁。\n");
      taskHistory.unshift(publicTask(task));
      taskHistory = taskHistory.slice(0, 10);
      currentTask = null;
      return;
    }
    runStep(task, index + 1);
  });
}

function startTask(action, payload = {}) {
  if (currentTask) {
    const error = new Error("已有任务正在运行，请等待结束或先暂停");
    error.statusCode = 409;
    throw error;
  }
  const jobName = canonicalJobName(payload.jobName || getConfiguredJobName() || "");
  const steps = commandForAction(action, {
    jobName,
    dryRun: Boolean(payload.dryRun),
    skipRecommend: Boolean(payload.skipRecommend),
  });
  const task = {
    id: `task-${Date.now()}`,
    action,
    label: action,
    jobName,
    dryRun: Boolean(payload.dryRun),
    startedAt: new Date().toISOString(),
    endedAt: "",
    status: "running",
    exitCode: null,
    currentStep: 0,
    steps: steps.map((step) => ({ ...step, status: "pending", exitCode: null })),
    output: [],
    child: null,
  };
  currentTask = task;
  runStep(task, 0);
  return publicTask(task);
}

function stopTask() {
  if (!currentTask) return { stopped: false, reason: "no_running_task" };
  const task = currentTask;
  task.status = "stopping";
  if (task.child && !task.child.killed) {
    try {
      process.kill(-task.child.pid, "SIGTERM");
    } catch {
      task.child.kill("SIGTERM");
    }
  }
  task.status = "stopped";
  task.endedAt = new Date().toISOString();
  task.output.push("\n任务已请求暂停。\n");
  const lockCleanup = clearStaleLock({ force: false });
  if (lockCleanup.cleared) task.output.push("已清理陈旧任务锁。\n");
  taskHistory.unshift(publicTask(task));
  taskHistory = taskHistory.slice(0, 10);
  currentTask = null;
  return { stopped: true, lockCleanup };
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, body, contentType = "text/plain; charset=utf-8", status = 200) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, await health());
  if (req.method === "GET" && url.pathname === "/api/status") {
    const jobName = canonicalJobName(url.searchParams.get("jobName") || getConfiguredJobName());
    return sendJson(res, {
      jobName,
      state: stateStats(jobName),
      queue: queueStats(),
      resumes: resumeStats(),
      lock: readLockInfo(),
      task: publicTask(currentTask),
      history: taskHistory,
    });
  }
  if (req.method === "GET" && url.pathname === "/api/logs") {
    const lines = tailLines(RUN_LOG_FILE, Number(url.searchParams.get("limit") || 80));
    return sendJson(res, { lines: lines.map(parseLogLine) });
  }
  if (req.method === "POST" && url.pathname === "/api/proxy/start") return sendJson(res, await startProxy(), 202);
  if (req.method === "POST" && url.pathname === "/api/lock/clear") {
    const payload = await readBody(req);
    return sendJson(res, clearStaleLock({ force: Boolean(payload.force) }));
  }
  if (req.method === "POST" && url.pathname.startsWith("/api/run/")) {
    const action = url.pathname.split("/").pop();
    const payload = await readBody(req);
    return sendJson(res, startTask(action, payload), 202);
  }
  if (req.method === "POST" && url.pathname === "/api/stop") return sendJson(res, stopTask());
  return sendJson(res, { error: "not_found" }, 404);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.resolve(PUBLIC_DIR, relative);
    if (!filePath.startsWith(PUBLIC_DIR)) return sendText(res, "Forbidden", "text/plain", 403);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return sendText(res, "Not found", "text/plain", 404);
    return sendText(res, fs.readFileSync(filePath), contentTypeFor(filePath));
  } catch (error) {
    const status = error.statusCode || 500;
    return sendJson(res, { error: String(error.message || error) }, status);
  }
}

http.createServer(handle).listen(PORT, "127.0.0.1", () => {
  console.log(`Boss 招聘控制面板已启动: http://127.0.0.1:${PORT}`);
});
