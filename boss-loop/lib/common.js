const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_ROOT = path.resolve(process.env.BOSS_DATA_ROOT || path.join(PROJECT_ROOT, "../data"));
const DEFAULT_CONFIG = path.resolve(process.env.BOSS_CONFIG_FILE || path.join(PROJECT_ROOT, "assets/default-config.yaml"));
const DEFAULT_PROXY = "http://localhost:3456";
const DEFAULT_STATE_FILE = path.join(DATA_ROOT, "briefs/boss-auto-lightweight-loop-state.json");
const DEFAULT_LOG_FILE = path.join(DATA_ROOT, "briefs/boss-auto-lightweight-loop-run.jsonl");
const DEFAULT_SYNC_QUEUE_FILE = path.join(DATA_ROOT, "briefs/boss-auto-lightweight-loop-sync-queue.jsonl");
const DEFAULT_RESUME_DOWNLOAD_DIR = path.join(DATA_ROOT, "resumes");
const DEFAULT_LOCK_DIR = path.join(DATA_ROOT, "briefs/boss-auto.lockdir");

const SENT_OR_COMPLETED_STATES = new Set([
  "first_contact_sent",
  "attachment_requested",
  "attachment_sent_by_candidate",
  "attachment_received",
  "resume_downloaded",
  "ready_for_hire_sync",
  "boss_completed",
  "download_failed",
  "paused_download_failed",
  "paused_send_failed",
  "sync_queue_failed",
]);

const COLLECT_STATUSES = new Set([
  "attachment_requested",
  "attachment_sent_by_candidate",
  "attachment_received",
  "download_failed",
  "paused_download_failed",
]);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    if (key === "self-check" || key === "dry-run") {
      out[key] = true;
    } else {
      out[key] = argv[++i];
    }
  }
  return out;
}

function readYamlScalar(file, key) {
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8");
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = text.match(re);
  if (!m) return "";
  return m[1].trim().replace(/^["']|["']$/g, "");
}

function readYamlNumber(file, key, fallback) {
  const value = readYamlScalar(file, key);
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfigOptions(args) {
  const config = args.config || DEFAULT_CONFIG;
  return {
    config,
    jobName: args["job-name"] || readYamlScalar(config, "job_name"),
    jobId: args["job-id"] || readYamlScalar(config, "job_id"),
    proxy: (args.proxy || readYamlScalar(config, "proxy_url") || DEFAULT_PROXY).replace(/\/$/, ""),
    stateFile: args["state-file"] || readYamlScalar(config, "state_file") || DEFAULT_STATE_FILE,
    logFile: args["log-file"] || readYamlScalar(config, "run_log_jsonl_file") || DEFAULT_LOG_FILE,
    syncQueueFile: args["sync-queue-file"] || readYamlScalar(config, "sync_queue_file") || DEFAULT_SYNC_QUEUE_FILE,
    archiveFile: args["archive-file"] || readYamlScalar(config, "archive_file") || "",
    resumeDownloadDir: args["resume-download-dir"] || readYamlScalar(config, "resume_download_dir") || DEFAULT_RESUME_DOWNLOAD_DIR,
    lockDir: args["lock-dir"] || readYamlScalar(config, "lock_dir") || DEFAULT_LOCK_DIR,
    lockTtlMinutes: readYamlNumber(config, "lock_ttl_minutes", 30),
    maxGreetPerRun: Number(args["max-greet-per-run"]) || readYamlNumber(config, "max_greet_per_run", 20),
    maxCollectPerRun: Number(args["max-collect-per-run"]) || readYamlNumber(config, "max_collect_per_run", 50),
    collectRequestTtlDays: readYamlNumber(config, "collect_request_ttl_days", 3),
    maxScanPerRun: readYamlNumber(config, "max_scan_per_run", 80),
    maxDetailReadsPerRun: readYamlNumber(config, "max_detail_reads_per_run", 40),
    maxListScrollRounds: readYamlNumber(config, "max_list_scroll_rounds", 4),
    recommendedGreetIntervalMin: readYamlNumber(config, "recommended_greet_interval_seconds_min", 3),
    recommendedGreetIntervalMax: readYamlNumber(config, "recommended_greet_interval_seconds_max", 8),
    sendIntervalMin: readYamlNumber(config, "send_interval_seconds_min", 0.5),
    sendIntervalMax: readYamlNumber(config, "send_interval_seconds_max", 1.5),
    inputDelayMs: readYamlNumber(config, "input_to_send_delay_ms", 200),
    confirmTimeoutMs: readYamlNumber(config, "send_confirm_timeout_ms", 800),
    downloadPollIntervalMs: readYamlNumber(config, "download_poll_interval_ms", 500),
    downloadMaxWaitSeconds: readYamlNumber(config, "download_max_wait_seconds", 30),
    healthCheckEveryCandidates: readYamlNumber(config, "health_check_every_candidates", 10),
    stateFlushBatchSize: readYamlNumber(config, "state_flush_batch_size", 5),
    autoSendThreshold: readYamlNumber(config, "auto_send_threshold", 3),
    requestResumeMessage: readYamlScalar(config, "request_resume_message") || "你好，我这边看了你的经历，和当前岗位匹配度不错。方便的话，可以发一份最新附件简历给我吗？我这边进一步评估后再和你沟通，谢谢。",
    confirmReceivedMessage: readYamlScalar(config, "confirm_received_message") || "简历已收到，我们会尽快筛选，合适的话会联系您。",
    probeReuseEnabled: readYamlScalar(config, "probe_reuse_enabled") !== "false",
    threadFastSwitchEnabled: readYamlScalar(config, "thread_fast_switch_enabled") !== "false",
    fastSendEnabled: readYamlScalar(config, "fast_send_enabled") !== "false",
    cardPrefilterEnabled: readYamlScalar(config, "card_prefilter_enabled") !== "false",
    candidateIdStrategy: readYamlScalar(config, "candidate_id_strategy") || "name_plus_school_or_name",
  };
}

function requestJson(method, url, body = null, maxBuffer = 1024 * 1024 * 8) {
  const args = ["-s", "-H", "Content-Type: text/plain"];
  if (method !== "GET") args.push("-X", method);
  args.push(url);
  if (body !== null) args.push("--data-raw", body);
  const out = execFileSync("curl", args, { encoding: "utf8", maxBuffer });
  return JSON.parse(out);
}

function findBossTarget(proxy, opts = {}) {
  const targets = requestJson("GET", `${proxy}/targets`);
  const urlRe = opts.urlRe || /zhipin\.com/;
  const boss = targets.find(t => urlRe.test(t.url || "") && !t.title?.includes("登录"));
  if (!boss) {
    const anyBoss = targets.find(t => /zhipin\.com/.test(t.url || ""));
    if (anyBoss) return anyBoss.targetId;
    throw new Error("No logged-in Boss target found.");
  }
  return boss.targetId;
}

function now() {
  return new Date().toISOString();
}

function normalize(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

function candidateId(name, school) {
  const n = normalize(name);
  const sc = normalize(school);
  return sc ? `${n}__${sc}` : n;
}

function loadState(file) {
  if (!file || !fs.existsSync(file)) return { version: 1, candidates: {} };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return { version: 1, candidates: {} };
  }
}

function getCandidates(state) {
  if (Array.isArray(state)) {
    const map = {};
    for (const c of state) if (c && c.candidate_id) map[c.candidate_id] = c;
    return map;
  }
  if (!state.candidates) state.candidates = {};
  return state.candidates;
}

function saveState(file, state, jobName) {
  if (!file) return;
  if (!Array.isArray(state)) {
    state.updated_at = now();
    state.config = { ...(state.config || {}), job_name: jobName };
  }
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function appendLog(file, runId, mode, event) {
  if (!file) return;
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify({ at: now(), run_id: runId, mode, ...event }) + "\n");
}

function randomSleepSeconds(min, max) {
  const lo = Math.max(0, Number(min) || 0);
  const hi = Math.max(lo, Number(max) || lo);
  return lo + Math.random() * (hi - lo);
}

function sleepMs(ms) {
  execFileSync("sleep", [String(Math.max(0, ms / 1000))]);
}

function makeClient(options) {
  const proxy = options.proxy || DEFAULT_PROXY;
  const target = options.target || findBossTarget(proxy);
  return {
    target,
    proxy,
    eval(js) {
      return requestJson("POST", `${proxy}/eval?target=${target}`, String(js)).value;
    },
    clickAt(selector) {
      return requestJson("POST", `${proxy}/clickAt?target=${target}`, String(selector), 1024 * 128);
    },
    info() {
      return requestJson("GET", `${proxy}/info?target=${target}`);
    },
    targets() {
      return requestJson("GET", `${proxy}/targets`);
    },
    navigate(url) {
      return requestJson("GET", `${proxy}/navigate?target=${encodeURIComponent(target)}&url=${encodeURIComponent(url)}`);
    },
    sleep: sleepMs,
  };
}

function pageHealth(cdp) {
  return cdp.eval(`(() => {
    const text = (document.body.innerText || '').trim().slice(0, 2000);
    const hasChatList = !!document.querySelector('.geek-item');
    return {
      loginExpired: /请登录|扫码登录|登录后继续|账号登录/.test(text) && !hasChatList,
      captcha: /验证码|安全验证|拖动滑块|行为验证/.test(text),
      hasChatList,
      hasEditor: !!document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]'),
      title: document.title,
      url: location.href,
      textSample: text.slice(0, 500)
    };
  })()`);
}

function acquireLock(lockDir, ttlMinutes, mode) {
  if (!lockDir) return true;
  const metaPath = path.join(lockDir, "meta.json");
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    fs.writeFileSync(metaPath, JSON.stringify({ pid: process.pid, mode, started_at: now(), host: require("os").hostname() }));
    return true;
  } catch (_) {
    try {
      const st = fs.statSync(lockDir);
      const ageMin = (Date.now() - st.mtimeMs) / 60000;
      if (ageMin >= ttlMinutes) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        fs.mkdirSync(lockDir, { recursive: false });
        fs.writeFileSync(metaPath, JSON.stringify({ pid: process.pid, mode, started_at: now(), host: require("os").hostname(), stale_lock_recovered: true }));
        return true;
      }
    } catch (_) {}
    return false;
  }
}

function releaseLock(lockDir) {
  if (!lockDir) return;
  try {
    fs.rmSync(lockDir, { recursive: true, force: true });
  } catch (_) {}
}

function ensureDir(dir) {
  if (!dir) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function fileHash(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex").slice(0, 16);
}

function safeFilename(name) {
  return String(name || "").replace(/[\\/:*?"<>|]/g, "_").trim();
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_PROXY,
  SENT_OR_COMPLETED_STATES,
  COLLECT_STATUSES,
  parseArgs,
  readYamlScalar,
  readYamlNumber,
  loadConfigOptions,
  requestJson,
  findBossTarget,
  now,
  normalize,
  candidateId,
  loadState,
  getCandidates,
  saveState,
  appendLog,
  randomSleepSeconds,
  sleepMs,
  makeClient,
  pageHealth,
  acquireLock,
  releaseLock,
  ensureDir,
  fileHash,
  safeFilename,
};
