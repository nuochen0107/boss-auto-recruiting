import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const DATA_ROOT = path.resolve(process.env.BOSS_DATA_ROOT || path.join(ROOT, "data"));
const RUN_DIR = path.join(DATA_ROOT, "runs");
const CURRENT_FILE = path.join(RUN_DIR, "current-pipeline.json");
const PIPELINE_LOCK_DIR = path.join(RUN_DIR, "legacy-pipeline.lock");
const RECOMMEND_LOCK_DIR = path.join(RUN_DIR, "recommend-greet.lock");
const LEGACY_BOSS_LOCK_DIR = path.join(DATA_ROOT, "briefs/boss-auto.lockdir");
const JOB_NAME = "AI应用实习生";
const MAX_OUTPUT_LINES = 120;

const SCRIPTS = {
  boss: path.join(ROOT, "boss-loop/boss_lite_screen_and_greet.mjs"),
  collect: path.join(ROOT, "boss-loop/collect_visible_resumes.js"),
  sync: path.join(ROOT, "feishu-sync/sync-to-feishu.mjs"),
};

let activeRun = null;
let activeChild = null;
let pauseRequested = false;

const now = () => new Date().toISOString();

function ensureDirs() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeState() {
  if (!activeRun) return;
  activeRun.updated_at = now();
  const tmp = `${CURRENT_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(activeRun, null, 2));
  fs.renameSync(tmp, CURRENT_FILE);
}

function updateState(patch) {
  if (!activeRun) return;
  Object.assign(activeRun, patch);
  writeState();
}

function activeLock(directory) {
  if (!fs.existsSync(directory)) return false;
  const meta = readJson(path.join(directory, "meta.json"), {});
  if (!meta.pid) return true;
  try {
    process.kill(Number(meta.pid), 0);
    return true;
  } catch {
    return false;
  }
}

function acquirePipelineLock() {
  ensureDirs();
  if (activeLock(RECOMMEND_LOCK_DIR)) throw new Error("recommend_run_already_active");
  if (activeLock(LEGACY_BOSS_LOCK_DIR)) throw new Error("legacy_boss_run_already_active");
  if (fs.existsSync(PIPELINE_LOCK_DIR) && !activeLock(PIPELINE_LOCK_DIR)) {
    fs.rmSync(PIPELINE_LOCK_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(PIPELINE_LOCK_DIR);
  fs.writeFileSync(path.join(PIPELINE_LOCK_DIR, "meta.json"), JSON.stringify({
    pid: process.pid,
    mode: "dashboard-legacy-pipeline",
    started_at: now(),
    host: os.hostname(),
  }, null, 2));
}

function releasePipelineLock() {
  const meta = readJson(path.join(PIPELINE_LOCK_DIR, "meta.json"), {});
  if (Number(meta.pid) === process.pid) {
    fs.rmSync(PIPELINE_LOCK_DIR, { recursive: true, force: true });
  }
}

function cleanupChildBossLock(childPid) {
  const meta = readJson(path.join(LEGACY_BOSS_LOCK_DIR, "meta.json"), {});
  if (Number(meta.pid) === Number(childPid)) {
    fs.rmSync(LEGACY_BOSS_LOCK_DIR, { recursive: true, force: true });
  }
}

function normalizeOptions(input = {}) {
  const type = ["chat", "collect", "sync", "full"].includes(input.type) ? input.type : "chat";
  const mode = input.mode === "real-run" ? "real-run" : "dry-run";
  const dailyTarget = Math.max(1, Math.min(200, Number(input.dailyTarget) || 20));
  const chatLimit = Math.max(1, Math.min(200, Number(input.chatLimit) || 20));
  const collectLimit = Math.max(1, Math.min(200, Number(input.collectLimit) || 50));
  const feishuJobId = String(input.feishuJobId || "").trim();
  const syncLimit = Math.max(1, Math.min(50, Number(input.syncLimit) || 1));
  if (["sync", "full"].includes(type) && !/^\d+$/.test(feishuJobId)) {
    const error = new Error("invalid_feishu_job_id");
    error.statusCode = 422;
    throw error;
  }
  return { type, mode, dailyTarget, chatLimit, collectLimit, jobName: JOB_NAME, feishuJobId, syncLimit };
}

function stagesFor(options) {
  const dry = options.mode === "dry-run";
  const bossArgs = [
    "--job-name", options.jobName,
    "--max-greet-per-run", String(options.chatLimit),
  ];
  const collectArgs = [
    "--job-name", options.jobName,
    "--max-collect-per-run", String(options.collectLimit),
  ];
  if (dry) {
    bossArgs.push("--dry-run");
    collectArgs.push("--dry-run");
  }
  const syncArgs = [dry ? "--dry-run" : "--apply", "--limit", String(options.syncLimit)];
  const syncEnv = {
    FEISHU_HIRE_UPLOAD_MODE: "talent_application",
    FEISHU_HIRE_JOB_ID: options.feishuJobId,
    FEISHU_HIRE_UPLOAD_STATE: path.join(RUN_DIR, `feishu-hire-job-${options.feishuJobId}-state.json`),
  };

  if (options.type === "chat") {
    return [{ key: "chat", label: "沟通页求简历", script: SCRIPTS.boss, args: [...bossArgs, "--skip-recommend"] }];
  }
  if (options.type === "collect") {
    return [{ key: "collect", label: "收取简历附件", script: SCRIPTS.collect, args: collectArgs }];
  }
  if (options.type === "sync") {
    return [{ key: "sync", label: "同步飞书招聘岗位", script: SCRIPTS.sync, args: syncArgs, env: syncEnv }];
  }
  return [
    {
      key: "chat",
      label: "处理沟通页并索要简历",
      script: SCRIPTS.boss,
      args: [...bossArgs, "--skip-recommend"],
    },
    { key: "collect", label: "收取简历附件", script: SCRIPTS.collect, args: collectArgs },
    { key: "sync", label: "同步飞书招聘岗位", script: SCRIPTS.sync, args: syncArgs, env: syncEnv },
  ];
}

function appendOutput(stage, stream, text) {
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    stage.output.push({ at: now(), stream, line });
    stage.output = stage.output.slice(-MAX_OUTPUT_LINES);
    try {
      stage.result = JSON.parse(line);
    } catch {}
  }
  writeState();
}

function runStage(stage) {
  return new Promise((resolve) => {
    stage.status = "running";
    stage.started_at = now();
    activeRun.current_stage = stage.key;
    activeRun.current_stage_label = stage.label;
    writeState();

    const child = spawn(process.execPath, [stage.script, ...stage.args], {
      cwd: ROOT,
      env: { ...process.env, ...(stage.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    stage.pid = child.pid;
    child.stdout.on("data", (chunk) => appendOutput(stage, "stdout", chunk));
    child.stderr.on("data", (chunk) => appendOutput(stage, "stderr", chunk));
    child.on("error", (error) => {
      stage.error = String(error.message || error);
    });
    child.on("close", (code, signal) => {
      cleanupChildBossLock(child.pid);
      activeChild = null;
      stage.exit_code = code;
      stage.signal = signal || "";
      stage.ended_at = now();
      const reportedPause = stage.result?.status === "paused";
      const reportedSkip = stage.result?.status === "skipped";
      if (pauseRequested || signal) stage.status = "paused";
      else if (code === 0 && stage.result?.status === "completed_partial") {
        stage.status = "completed_partial";
      }
      else if (code !== 0 || reportedPause || reportedSkip || stage.error) {
        stage.status = reportedPause ? "paused" : "failed";
        if (!stage.error && code !== 0) {
          const failureLine = [...stage.output].reverse().find((item) =>
            /^(FAIL|FATAL)\b/.test(item.line) || /Access denied|Missing required|permission/i.test(item.line)
          );
          stage.error = failureLine?.line || `process_exit_${code}`;
        }
      } else {
        stage.status = "completed";
      }
      writeState();
      resolve(stage);
    });
  });
}

async function execute() {
  try {
    updateState({ status: "running" });
    for (let index = 0; index < activeRun.stages.length; index += 1) {
      if (pauseRequested) break;
      activeRun.current_stage_index = index + 1;
      const stage = await runStage(activeRun.stages[index]);
      if (!["completed", "completed_partial"].includes(stage.status)) break;
    }
    const stoppedStage = activeRun.stages.find((stage) => ["failed", "paused"].includes(stage.status));
    const completedCount = activeRun.stages.filter((stage) => stage.status === "completed").length;
    const partialCount = activeRun.stages.filter((stage) => stage.status === "completed_partial").length;
    const status = pauseRequested || stoppedStage?.status === "paused"
      ? "paused"
      : stoppedStage
        ? "failed"
        : partialCount > 0
          ? "completed_partial"
          : completedCount === activeRun.stages.length
          ? "completed"
          : "paused";
    updateState({
      status,
      ended_at: now(),
      error: stoppedStage?.error || stoppedStage?.result?.paused_reason || stoppedStage?.result?.reason || "",
    });
  } catch (error) {
    updateState({ status: "failed", ended_at: now(), error: String(error.message || error) });
  } finally {
    activeChild = null;
    pauseRequested = false;
    releasePipelineLock();
    activeRun = null;
  }
}

export function startLegacyRun(input = {}) {
  if (activeRun) {
    const error = new Error("pipeline_already_active");
    error.statusCode = 409;
    error.currentRun = activeRun;
    throw error;
  }
  const options = normalizeOptions(input);
  acquirePipelineLock();
  pauseRequested = false;
  activeRun = {
    run_id: `pipeline-${Date.now()}`,
    kind: "legacy-pipeline",
    status: "starting",
    options,
    started_at: now(),
    updated_at: now(),
    ended_at: "",
    current_stage: "",
    current_stage_label: "",
    current_stage_index: 0,
    error: "",
    stages: stagesFor(options).map((stage) => ({
      ...stage,
      env: stage.env ? {
        FEISHU_HIRE_UPLOAD_MODE: stage.env.FEISHU_HIRE_UPLOAD_MODE,
        FEISHU_HIRE_JOB_ID: stage.env.FEISHU_HIRE_JOB_ID,
        FEISHU_HIRE_UPLOAD_STATE: stage.env.FEISHU_HIRE_UPLOAD_STATE,
      } : undefined,
      status: "pending",
      started_at: "",
      ended_at: "",
      exit_code: null,
      signal: "",
      pid: null,
      result: null,
      error: "",
      output: [],
    })),
  };
  writeState();
  execute();
  return activeRun;
}

export function pauseLegacyRun() {
  if (!activeRun) return { paused: false, reason: "no_active_pipeline", state: getLegacyRun() };
  pauseRequested = true;
  updateState({ status: "pausing" });
  if (activeChild && !activeChild.killed) activeChild.kill("SIGTERM");
  return { paused: true, state: activeRun };
}

export function getLegacyRun() {
  return activeRun || readJson(CURRENT_FILE, {
    kind: "legacy-pipeline",
    status: "idle",
    stages: [],
  });
}
