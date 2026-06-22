#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { getCurrentRun, getTodayReport, pauseRun, preflight, startRun } from "../orchestrator/recommend_greet_runner.mjs";
import { getLegacyRun, pauseLegacyRun, startLegacyRun } from "../orchestrator/legacy_pipeline_runner.mjs";
import { createShutdownHandler } from "./app-shutdown.mjs";
import { readJobsForEditor, writeJobsFromEditor } from "./job-config-editor.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(DIR, "..");
const require = createRequire(import.meta.url);
const { enabledJobs, loadJobsConfig } = require("../config/job-router.cjs");
const PUBLIC_DIR = path.join(DIR, "public");
const PORT = Number(process.env.BOSS_DASHBOARD_PORT || 8787);
const HOST = process.env.BOSS_DASHBOARD_HOST || "127.0.0.1";
const PROXY_URL = (process.env.CDP_PROXY_URL || "http://127.0.0.1:3456").replace(/\/$/, "");
const PROXY_SCRIPT = path.join(PROJECT_ROOT, "deps/web-access/scripts/cdp-proxy.mjs");
const RESUME_DIR = path.join(PROJECT_ROOT, "data/resumes");
const FEISHU_SYNC_STATES = [
  path.join(PROJECT_ROOT, "data/runs/feishu-hire-multi-job-state.json"),
  path.join(PROJECT_ROOT, "data/briefs/feishu-hire-sync-state.json"),
];
let proxyProcess = null;
const shutdownApp = createShutdownHandler({
  getProxyProcess: () => proxyProcess,
  setProxyProcess: (value) => { proxyProcess = value; },
});

function editableJobsFile() {
  return process.env.BOSS_JOBS_FILE
    ? path.resolve(process.env.BOSS_JOBS_FILE)
    : path.join(PROJECT_ROOT, "config/jobs.json");
}

function publicJobsPayload(config) {
  return {
    version: config.version,
    file: config.file,
    jobs: enabledJobs(config).map((job) => ({
      ...job,
      feishu_configured: /^\d+$/.test(job.feishu_hire_job_id),
    })),
  };
}

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}

function sendFile(res, file) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  res.end(fs.readFileSync(file));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function portOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function proxyHealth() {
  try {
    const response = await fetch(`${PROXY_URL}/targets`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, targets: [] };
    const targets = await response.json();
    if (!Array.isArray(targets)) return { ok: false, reason: "Proxy 返回格式异常", targets: [] };
    return { ok: true, reason: "", targets };
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || "";
    return {
      ok: false,
      reason: cause === "ECONNREFUSED"
        ? "浏览器连接服务尚未启动"
        : String(cause || error.message || error),
      targets: [],
    };
  }
}

async function detailedPreflight() {
  const chrome9222 = await portOpen(9222);
  const proxy = await proxyHealth();
  const checks = [{
    key: "chrome_debug",
    label: "Chrome 远程调试",
    ok: chrome9222,
    detail: chrome9222 ? "127.0.0.1:9222 正在监听" : "127.0.0.1:9222 未监听",
    guide: chrome9222
      ? ""
      : "在 Chrome 打开 chrome://inspect/#remote-debugging，开启 Allow remote debugging；若仍失败，完全退出 Chrome 后重新打开。",
  }, {
    key: "cdp_proxy",
    label: "浏览器连接服务",
    ok: proxy.ok,
    detail: proxy.ok ? `连接正常，发现 ${proxy.targets.length} 个浏览器页面` : proxy.reason,
    guide: proxy.ok ? "" : "点击环境检查右上方的“启动浏览器连接”。Chrome 远程调试和浏览器连接服务都正常后，任务才能操作 Boss 页面。",
  }];

  if (!proxy.ok) {
    return { ok: false, checks, errors: checks.filter((item) => !item.ok).map((item) => item.detail) };
  }

  const runner = await preflight();
  const labels = {
    no_active_run: "推荐任务",
    runner_lock: "推荐任务锁",
    legacy_pipeline_lock: "日常招聘流程",
    legacy_boss_lock: "Boss 页面操作",
    cdp: "Boss 页面连接",
    boss_login: "Boss 登录状态",
    captcha: "验证码",
    platform_warning: "平台警告",
  };
  const guides = {
    cdp: "请在已开启远程调试的 Chrome 中打开 Boss 直聘招聘端页面，然后重新检查。",
    boss_login: "请在该 Chrome 中登录 Boss 直聘招聘端，并停留在推荐页或沟通页。",
    captcha: "请在 Chrome 中人工完成验证码，再重新检查。",
    platform_warning: "请先在 Chrome 中人工处理平台警告，不要继续自动执行。",
    no_active_run: "先暂停或等待当前推荐任务结束。",
    runner_lock: "确认没有任务运行后再处理残留任务锁。",
    legacy_pipeline_lock: "先暂停或等待当前沟通、收简历或飞书同步任务结束。",
    legacy_boss_lock: "Boss 页面正在被另一个任务使用，请等待该任务结束。",
  };
  for (const item of runner.checks || []) {
    if (item.key === "cdp") continue;
    const friendlyDetail = item.ok && item.key === "legacy_pipeline_lock"
      ? "当前没有运行中的日常招聘流程"
      : item.ok && item.key === "legacy_boss_lock"
        ? "Boss 页面当前可操作"
        : item.detail;
    checks.push({
      ...item,
      detail: friendlyDetail,
      label: labels[item.key] || item.key,
      guide: item.ok ? "" : (guides[item.key] || "根据详情处理后重新检查。"),
    });
  }
  const bossTarget = proxy.targets.some((target) => /zhipin\.com/.test(target.url || ""));
  checks.splice(2, 0, {
    key: "boss_target",
    label: "Boss 页面",
    ok: bossTarget,
    detail: bossTarget ? "已发现 Boss 直聘页面" : "没有发现 zhipin.com 页面",
    guide: bossTarget ? "" : "请在当前 Chrome 中打开并登录 Boss 直聘招聘端页面。",
  });
  return { ok: checks.every((item) => item.ok), checks, errors: checks.filter((item) => !item.ok).map((item) => item.detail) };
}

async function startProxy() {
  const current = await proxyHealth();
  if (current.ok) return { ok: true, started: false, message: "CDP Proxy 已经在运行", proxy: current };
  if (!fs.existsSync(PROXY_SCRIPT)) throw new Error(`CDP Proxy 脚本不存在：${PROXY_SCRIPT}`);

  const output = [];
  proxyProcess = spawn(process.execPath, [PROXY_SCRIPT], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyProcess.stdout.on("data", (chunk) => output.push(String(chunk)));
  proxyProcess.stderr.on("data", (chunk) => output.push(String(chunk)));
  proxyProcess.once("close", () => { proxyProcess = null; });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const health = await proxyHealth();
    if (health.ok) return { ok: true, started: true, message: "CDP Proxy 已启动", proxy: health, output };
    if (!proxyProcess) break;
  }
  return {
    ok: false,
    started: true,
    message: "CDP Proxy 启动后仍无法连接 Chrome",
    guide: "确认 Chrome 显示 Server running at 127.0.0.1:9222；若出现调试授权弹窗，请点击允许。",
    output,
  };
}

function cleanupUploadedResumes() {
  let deleted = 0;
  let bytesFreed = 0;
  let retained = 0;
  const cleanedFiles = new Set();

  for (const stateFile of FEISHU_SYNC_STATES) {
    if (!fs.existsSync(stateFile)) continue;
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    let changed = false;
    for (const record of Object.values(state.files || {})) {
      const verified = record?.status === "success"
        && record?.talent?.talent_id
        && (record?.application?.application_id || record?.application?.duplicate);
      const file = record?.file ? path.resolve(record.file) : "";
      const insideResumeDir = file && (file === RESUME_DIR || file.startsWith(`${RESUME_DIR}${path.sep}`));
      if (!verified || !insideResumeDir || cleanedFiles.has(file)) {
        if (file && fs.existsSync(file)) retained += 1;
        continue;
      }
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        const size = fs.statSync(file).size;
        fs.unlinkSync(file);
        deleted += 1;
        bytesFreed += size;
      }
      cleanedFiles.add(file);
      record.local_file_deleted = true;
      record.local_file_deleted_at ||= new Date().toISOString();
      changed = true;
    }
    if (changed) fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
  return { ok: true, deleted, bytes_freed: bytesFreed, retained };
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, { ok: true, service: "boss-recruiting-dashboard", timestamp: new Date().toISOString(), scoringEnabled: false });
  }
  if (req.method === "GET" && url.pathname === "/api/preflight") {
    return sendJson(res, await detailedPreflight());
  }
  if (req.method === "GET" && url.pathname === "/api/jobs") {
    const config = loadJobsConfig(PROJECT_ROOT);
    return sendJson(res, publicJobsPayload(config));
  }
  if (req.method === "GET" && url.pathname === "/api/jobs/config") {
    return sendJson(res, readJobsForEditor(editableJobsFile()));
  }
  if (req.method === "POST" && url.pathname === "/api/jobs/config") {
    const config = writeJobsFromEditor(editableJobsFile(), await body(req));
    return sendJson(res, {
      ...config,
      public: publicJobsPayload(config),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/proxy/start") return sendJson(res, await startProxy(), 202);
  if (req.method === "POST" && url.pathname === "/api/runs/start") return sendJson(res, await startRun(await body(req)), 202);
  if (req.method === "POST" && url.pathname === "/api/runs/pause") return sendJson(res, pauseRun());
  if (req.method === "GET" && url.pathname === "/api/runs/current") return sendJson(res, getCurrentRun());
  if (req.method === "GET" && url.pathname === "/api/runs/report/today") return sendJson(res, getTodayReport());
  if (req.method === "POST" && url.pathname === "/api/pipeline/start") return sendJson(res, startLegacyRun(await body(req)), 202);
  if (req.method === "POST" && url.pathname === "/api/pipeline/pause") return sendJson(res, pauseLegacyRun());
  if (req.method === "POST" && url.pathname === "/api/resumes/cleanup-uploaded") {
    return sendJson(res, cleanupUploadedResumes());
  }
  if (req.method === "POST" && url.pathname === "/api/app/shutdown") {
    const result = shutdownApp();
    return sendJson(res, result, 202);
  }
  if (req.method === "GET" && url.pathname === "/api/pipeline/current") return sendJson(res, getLegacyRun());
  return sendJson(res, { error: "not_found" }, 404);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, { error: "forbidden" }, 403);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, { error: "not_found" }, 404);
    return sendFile(res, file);
  } catch (error) {
    return sendJson(res, {
      error: String(error.message || error),
      preflight: error.preflight || undefined,
      currentRun: error.currentRun || undefined,
    }, error.statusCode || 500);
  }
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`Boss 招聘控制面板已启动: http://${HOST}:${PORT}`);
});
