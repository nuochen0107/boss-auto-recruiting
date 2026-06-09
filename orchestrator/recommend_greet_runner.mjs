#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBatchPlan, normalizeRunOptions } from "./quota_scheduler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const RUN_DIR = path.join(DATA_DIR, "runs");
const CANDIDATE_DIR = path.join(DATA_DIR, "candidates");
const CURRENT_FILE = path.join(RUN_DIR, "current-run.json");
const RUN_LOCK_DIR = path.join(RUN_DIR, "recommend-greet.lock");
const OLD_STATE_FILE = path.join(DATA_DIR, "briefs/boss-auto-lightweight-loop-state.json");
const OLD_LOCK_DIR = path.join(DATA_DIR, "briefs/boss-auto.lockdir");
const PROXY = (process.env.CDP_PROXY_URL || "http://127.0.0.1:3456").replace(/\/$/, "");
const MAX_CONSECUTIVE_FAILURES = Math.max(1, Number(process.env.BOSS_MAX_CONSECUTIVE_FAILURES || 3));
const GREET_DELAY_MIN_MS = Math.max(1000, Number(process.env.BOSS_GREET_DELAY_MIN_MS || 3000));
const GREET_DELAY_MAX_MS = Math.max(GREET_DELAY_MIN_MS, Number(process.env.BOSS_GREET_DELAY_MAX_MS || 8000));
const JOB_NAME = "AI应用实习生";

let activeTask = null;
let pauseRequested = false;

const now = () => new Date().toISOString();
const dateKey = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: process.env.TZ || "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

function ensureDirs() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.mkdirSync(CANDIDATE_DIR, { recursive: true });
}

function writeJsonAtomic(file, value) {
  ensureDirs();
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

function appendJsonl(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function runLogFile() {
  return path.join(RUN_DIR, `run-${dateKey()}.jsonl`);
}

function candidateLogFile() {
  return path.join(CANDIDATE_DIR, `candidate-decisions-${dateKey()}.jsonl`);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function lockInfo(directory) {
  if (!fs.existsSync(directory)) return { exists: false, active: false };
  const meta = readJson(path.join(directory, "meta.json"), {});
  return { exists: true, active: pidAlive(meta.pid), pid: meta.pid || null, mode: meta.mode || "", directory };
}

function acquireRunLock() {
  ensureDirs();
  const existing = lockInfo(RUN_LOCK_DIR);
  if (existing.exists && !existing.active) fs.rmSync(RUN_LOCK_DIR, { recursive: true, force: true });
  try {
    fs.mkdirSync(RUN_LOCK_DIR);
    fs.writeFileSync(path.join(RUN_LOCK_DIR, "meta.json"), JSON.stringify({
      pid: process.pid,
      mode: "recommend-greet",
      started_at: now(),
      host: os.hostname(),
    }, null, 2));
  } catch {
    throw new Error("run_lock_exists");
  }
}

function releaseRunLock() {
  try { fs.rmSync(RUN_LOCK_DIR, { recursive: true, force: true }); } catch {}
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

function updateState(patch, event = "") {
  if (!activeTask) return;
  activeTask.state = { ...activeTask.state, ...patch, updated_at: now() };
  writeJsonAtomic(CURRENT_FILE, activeTask.state);
  if (event) appendJsonl(runLogFile(), { timestamp: now(), run_id: activeTask.state.run_id, event, ...patch });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options.timeout || 10000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`cdp_http_${response.status}:${text.slice(0, 160)}`);
  return text ? JSON.parse(text) : null;
}

async function evalTarget(targetId, expression, timeout = 10000) {
  const result = await requestJson(`${PROXY}/eval?target=${encodeURIComponent(targetId)}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: expression,
    timeout,
  });
  return result?.value;
}

async function clickSelector(targetId, selector) {
  return requestJson(`${PROXY}/clickAt?target=${encodeURIComponent(targetId)}`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: selector,
    timeout: 6000,
  });
}

async function findBossTarget() {
  const targets = await requestJson(`${PROXY}/targets`, { timeout: 2500 });
  const target = (targets || []).find((item) =>
    item.type === "page" &&
    /zhipin\.com/.test(item.url || "") &&
    !/登录/.test(item.title || ""));
  if (!target) throw new Error("paused_boss_not_logged_in");
  return target;
}

async function inspectPage(targetId) {
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => {
      try { return f.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const text = docs.map(d => d.body?.innerText || '').join('\\n').slice(0, 30000);
    return {
      title: document.title,
      url: location.href,
      captcha: /验证码|安全验证|拖动滑块|行为验证|人机验证/.test(text),
      login: /请登录|扫码登录|登录后/.test(text),
      warning: /操作频繁|存在风险|账号异常|平台警告|违规|暂时无法沟通|访问受限/.test(text),
      quota: /今日沟通额度.*(?:用完|耗尽)|沟通次数已用完|暂无沟通次数|权益.*耗尽/.test(text)
    };
  })())`);
  return JSON.parse(raw);
}

async function gotoRecommend(targetId) {
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const element = [...document.querySelectorAll('a,button,span,div')]
      .find(el => (el.innerText || el.textContent || '').trim() === '推荐牛人');
    if (!element) return { ok: false, url: location.href };
    element.setAttribute('data-recruit-dashboard-nav', 'recommend');
    return { ok: true, url: location.href };
  })())`);
  const result = JSON.parse(raw);
  if (result.ok) {
    await clickSelector(targetId, '[data-recruit-dashboard-nav="recommend"]');
    await wait(1800);
  }
  return result;
}

function cardExtractionExpression(jobName) {
  return `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const frameRect = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
    const bodyText = doc.body?.innerText || '';
    const cardSelectors = 'li.card-item,.geek-card,.candidate-card,[class*="geek-card"],[class*="candidate-card"]';
    const invalidName = value => !value || value.length < 2 || value.length > 12 ||
      /打招呼|立即沟通|继续沟通|已沟通|已联系|推荐|期望|学历|经历|掌握|选择/.test(value) ||
      /本科|硕士|博士|大专|应届|在读|岁|K|面议/.test(value) ||
      value.includes(${JSON.stringify(jobName)});
    const cards = [...doc.querySelectorAll(cardSelectors)].map((card, index) => {
      const button = [...card.querySelectorAll('button,a,div,span')]
        .find(el => /^(打招呼|立即沟通)$/.test((el.innerText || el.textContent || '').trim()));
      if (!button) return null;
      const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const name = lines.find(line => !invalidName(line)) || '';
      const text = lines.join('\\n');
      const school = (text.match(/([^\\s\\n]+(?:大学|学院|职业技术学院))/) || [])[1] || '';
      const age = (text.match(/(\\d{2})岁/) || [])[1] || '';
      const education = (text.match(/博士|硕士|本科|大专|专科/) || [])[0] || '';
      const expectedCity = (text.match(/期望\\s*\\n?([^\\s\\n]+)/) || [])[1] || '';
      const salary = (text.match(/\\d+\\s*[-~]\\s*\\d+K|\\d+\\s*[-~]\\s*\\d+元[^\\n]*/) || [])[0] || '';
      const rect = button.getBoundingClientRect();
      const marker = 'candidate_' + index;
      button.setAttribute('data-recruit-dashboard-greet', marker);
      const href = card.querySelector('a[href]')?.href || '';
      const dataId = card.getAttribute('data-geek-id') || card.getAttribute('data-id') || '';
      return {
        index, marker, name, school, age, education, expected_city: expectedCity,
        salary_expectation: salary, raw_text: text, href, data_id: dataId,
        rect: { x: frameRect.x + rect.x + rect.width / 2, y: frameRect.y + rect.y + rect.height / 2 }
      };
    }).filter(Boolean);
    return {
      cards,
      captcha: /验证码|安全验证|拖动滑块|行为验证|人机验证/.test(bodyText),
      login: /请登录|扫码登录/.test(bodyText) && cards.length === 0,
      warning: /操作频繁|存在风险|账号异常|平台警告|违规|暂时无法沟通|访问受限/.test(bodyText),
      quota: /今日沟通额度.*(?:用完|耗尽)|沟通次数已用完|暂无沟通次数|权益.*耗尽/.test(bodyText)
    };
  })())`;
}

async function readCards(targetId, jobName) {
  return JSON.parse(await evalTarget(targetId, cardExtractionExpression(jobName)));
}

async function scrollFeed(targetId) {
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const nodes = [doc.scrollingElement, doc.documentElement, doc.body,
      ...doc.querySelectorAll('[class*="list"],[class*="scroll"],[class*="recommend"],[class*="content"]')]
      .filter(Boolean);
    const target = nodes.find(el => el.scrollHeight > el.clientHeight + 20);
    if (!target) return { moved: false };
    const before = target.scrollTop;
    target.scrollBy({ top: Math.max(400, Math.floor(target.clientHeight * .8)), behavior: 'auto' });
    return { moved: target.scrollTop !== before, before, after: target.scrollTop };
  })())`);
  return JSON.parse(raw);
}

async function clickCard(targetId, card) {
  const marker = `dashboard-click-${Date.now()}`;
  await evalTarget(targetId, `JSON.stringify((() => {
    document.querySelectorAll('[data-recruit-dashboard-click]').forEach(el => el.remove());
    const el = document.createElement('i');
    el.setAttribute('data-recruit-dashboard-click', ${JSON.stringify(marker)});
    Object.assign(el.style, {
      position: 'fixed', left: '${Math.round(card.rect.x - 2)}px',
      top: '${Math.round(card.rect.y - 2)}px', width: '4px', height: '4px',
      pointerEvents: 'none', zIndex: '2147483647'
    });
    document.documentElement.appendChild(el);
    return { ok: true };
  })())`);
  await clickSelector(targetId, `[data-recruit-dashboard-click="${marker}"]`);
  await evalTarget(targetId, `document.querySelectorAll('[data-recruit-dashboard-click]').forEach(el => el.remove())`).catch(() => {});
}

async function confirmGreeting(targetId, index) {
  await wait(1000);
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const cards = doc.querySelectorAll('li.card-item,.geek-card,.candidate-card,[class*="geek-card"],[class*="candidate-card"]');
    const text = cards[${Number(index)}]?.innerText || '';
    const body = doc.body?.innerText || '';
    return {
      ok: /继续沟通|已沟通|已联系/.test(text) || !/打招呼|立即沟通/.test(text),
      quota: /沟通次数已用完|暂无沟通次数|权益.*耗尽/.test(body),
      captcha: /验证码|安全验证|拖动滑块|行为验证/.test(body),
      warning: /操作频繁|存在风险|账号异常|平台警告|暂时无法沟通/.test(body)
    };
  })())`);
  return JSON.parse(raw);
}

function candidateId(card) {
  if (card.data_id) return `boss_recommend:${card.data_id}`;
  const hrefId = String(card.href || "").match(/(?:geek|uid|id)[=/]([^?&#/]+)/i)?.[1];
  if (hrefId) return `boss_recommend:${hrefId}`;
  return `recommend:${crypto.createHash("sha256").update(`${card.name}|${card.school}|${card.raw_text}`).digest("hex").slice(0, 20)}`;
}

function oldContactedIds() {
  const state = readJson(OLD_STATE_FILE, {});
  const candidates = Array.isArray(state) ? state : Object.values(state?.candidates || {});
  return new Set(candidates.filter((item) =>
    ["first_contact_sent", "attachment_requested", "attachment_sent_by_candidate", "attachment_received", "resume_downloaded", "ready_for_hire_sync", "boss_completed"].includes(item?.status)
  ).map((item) => item.candidate_id));
}

function alreadyProcessedIds() {
  return new Set(readJsonl(candidateLogFile())
    .filter((item) => item.action_taken === "greeted")
    .map((item) => item.candidate_id));
}

function throwIfStopped() {
  if (pauseRequested) throw new Error("paused_by_user");
}

function checkSafety(data) {
  if (data.captcha) throw new Error("paused_captcha_detected");
  if (data.login) throw new Error("paused_boss_not_logged_in");
  if (data.warning) throw new Error("paused_platform_warning");
  if (data.quota) throw new Error("paused_boss_contact_quota_exhausted");
}

function wait(ms) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (pauseRequested) {
        clearInterval(timer);
        reject(new Error("paused_by_user"));
      } else if (Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, Math.min(500, Math.max(50, ms)));
  });
}

function logDecision(candidate, actionTaken, error = "", reason = "") {
  const record = {
    run_id: activeTask.state.run_id,
    timestamp: now(),
    flow_mode: "direct_greet",
    job_id: activeTask.state.options.jobId,
    candidate_id: candidate.candidate_id,
    candidate_name: candidate.name,
    raw_text: candidate.raw_text,
    decision: actionTaken === "skipped" ? "skip" : "direct_greet",
    reason,
    action_taken: actionTaken,
    error,
  };
  appendJsonl(candidateLogFile(), record);
  return record;
}

function increment(patch) {
  const current = activeTask.state;
  const counters = { ...current.counters };
  for (const [key, value] of Object.entries(patch)) counters[key] = (counters[key] || 0) + value;
  updateState({ counters });
}

async function runBatch(targetId, batch) {
  const options = activeTask.state.options;
  const attempted = activeTask.attempted;
  let batchPassed = 0;
  let scrollRounds = 0;
  let consecutiveFailures = 0;
  const maxScans = Math.max(batch.target * 10, 100);
  let scansThisBatch = 0;

  while (batchPassed < batch.target && scansThisBatch < maxScans) {
    throwIfStopped();
    const health = await inspectPage(targetId);
    checkSafety(health);
    const data = await readCards(targetId, JOB_NAME);
    checkSafety(data);

    const rawCard = (data.cards || []).find((card) => card.name && !attempted.has(candidateId(card)));
    if (!rawCard) {
      if (scrollRounds >= 20) break;
      const moved = await scrollFeed(targetId);
      scrollRounds += 1;
      if (!moved.moved && scrollRounds >= 3) break;
      await wait(900);
      continue;
    }

    const id = candidateId(rawCard);
    const legacyId = rawCard.school ? `${rawCard.name}__${rawCard.school}` : rawCard.name;
    attempted.add(id);
    scansThisBatch += 1;
    const candidate = {
      candidate_id: id,
      name: rawCard.name,
      age: rawCard.age,
      education: rawCard.education,
      school: rawCard.school,
      major: "",
      current_status: "",
      expected_job: "",
      expected_city: rawCard.expected_city,
      salary_expectation: rawCard.salary_expectation,
      experience_summary: rawCard.raw_text,
      skill_tags: [],
      raw_text: rawCard.raw_text,
    };
    increment({ scanned: 1 });

    if (activeTask.processed.has(id) || activeTask.processed.has(legacyId)) {
      increment({ skipped: 1 });
      logDecision(candidate, "skipped", "", "今日或历史记录中已触达");
      continue;
    }

    increment({ eligible: 1 });
    if (options.mode === "dry-run") {
      batchPassed += 1;
      logDecision(candidate, "dry_run_only");
      continue;
    }

    try {
      await clickCard(targetId, rawCard);
      const confirmation = await confirmGreeting(targetId, rawCard.index);
      checkSafety(confirmation);
      if (!confirmation.ok) throw new Error("greet_no_state_change");
      activeTask.processed.add(id);
      activeTask.processed.add(legacyId);
      increment({ greeted: 1 });
      batchPassed += 1;
      logDecision(candidate, "greeted");
      consecutiveFailures = 0;
      await wait(GREET_DELAY_MIN_MS + Math.random() * (GREET_DELAY_MAX_MS - GREET_DELAY_MIN_MS));
    } catch (error) {
      consecutiveFailures += 1;
      increment({ failed: 1 });
      logDecision(candidate, "failed", String(error.message || error));
      if (/^paused_/.test(String(error.message || error))) throw error;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw new Error("paused_consecutive_failures");
    }
  }
  return batchPassed;
}

async function execute(options) {
  let finalStatus = "completed";
  let errorMessage = "";
  try {
    const preflightResult = await preflight({ ignoreActiveTask: true });
    if (!preflightResult.ok) throw new Error(preflightResult.errors[0] || "preflight_failed");
    const target = await findBossTarget();
    await gotoRecommend(target.targetId);
    checkSafety(await inspectPage(target.targetId));

    for (const batch of activeTask.state.batch_plan) {
      throwIfStopped();
      updateState({
        status: "running",
        current_batch: batch.number,
        remaining_batches: activeTask.state.batch_plan.length - batch.number,
      }, "batch_start");
      await runBatch(target.targetId, batch);
      updateState({}, "batch_complete");
      const reached = options.mode === "real-run"
        ? activeTask.state.counters.greeted >= options.dailyTarget
        : activeTask.state.counters.eligible >= options.dailyTarget;
      if (reached) break;
      if (batch.number < activeTask.state.batch_plan.length) {
        const nextRunAt = new Date(Date.now() + options.batchIntervalMinutes * 60000).toISOString();
        updateState({ status: "waiting", next_batch_at: nextRunAt }, "batch_wait");
        await wait(options.batchIntervalMinutes * 60000);
      }
    }
    const reached = options.mode === "real-run"
      ? activeTask.state.counters.greeted >= options.dailyTarget
      : activeTask.state.counters.eligible >= options.dailyTarget;
    if (!reached) {
      finalStatus = "completed_partial";
      errorMessage = "target_not_reached_no_more_candidates";
    }
  } catch (error) {
    errorMessage = String(error.message || error);
    finalStatus = errorMessage === "paused_by_user" ? "paused" : "paused";
  } finally {
    const patch = {
      status: finalStatus,
      ended_at: now(),
      error: errorMessage,
      next_batch_at: "",
    };
    updateState(patch, finalStatus === "completed" ? "run_complete" : finalStatus === "completed_partial" ? "run_complete_partial" : "run_paused");
    releaseRunLock();
    activeTask = null;
    pauseRequested = false;
  }
}

export async function preflight({ ignoreActiveTask = false } = {}) {
  const checks = [];
  const errors = [];
  const add = (key, ok, detail) => {
    checks.push({ key, ok, detail });
    if (!ok) errors.push(detail);
  };
  add("no_active_run", ignoreActiveTask || !activeTask, ignoreActiveTask || !activeTask ? "当前无运行中任务" : "run_already_active");
  const runnerLock = lockInfo(RUN_LOCK_DIR);
  const legacyLock = lockInfo(OLD_LOCK_DIR);
  add("runner_lock", ignoreActiveTask || !runnerLock.active || runnerLock.pid === process.pid,
    !runnerLock.active || runnerLock.pid === process.pid ? "推荐任务锁可用" : `run_lock_exists:${runnerLock.pid}`);
  add("legacy_boss_lock", !legacyLock.active,
    !legacyLock.active ? "旧 Boss 自动化未运行" : `legacy_boss_run_active:${legacyLock.pid}`);
  try {
    const target = await findBossTarget();
    add("cdp", true, `${PROXY}, target=${target.targetId}`);
    const page = await inspectPage(target.targetId);
    add("boss_login", !page.login, page.login ? "paused_boss_not_logged_in" : "Boss 已登录");
    add("captcha", !page.captcha, page.captcha ? "paused_captcha_detected" : "未发现验证码");
    add("platform_warning", !page.warning, page.warning ? "paused_platform_warning" : "未发现平台警告");
  } catch (error) {
    add("cdp", false, String(error.message || error));
  }
  return { ok: checks.every((item) => item.ok), checks, errors };
}

export async function startRun(input = {}) {
  if (activeTask) {
    const error = new Error("run_already_active");
    error.statusCode = 409;
    throw error;
  }
  const options = normalizeRunOptions(input);
  const preflightResult = await preflight();
  if (!preflightResult.ok) {
    const error = new Error(preflightResult.errors.join(";"));
    error.statusCode = 422;
    error.preflight = preflightResult;
    throw error;
  }
  acquireRunLock();
  pauseRequested = false;
  const batchPlan = buildBatchPlan(options.dailyTarget, options.batchSize);
  const state = {
    run_id: `recommend-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`,
    status: "starting",
    options,
    started_at: now(),
    updated_at: now(),
    ended_at: "",
    pid: process.pid,
    host: os.hostname(),
    current_batch: 0,
    remaining_batches: batchPlan.length,
    batch_plan: batchPlan,
    next_batch_at: "",
    counters: { scanned: 0, eligible: 0, greeted: 0, skipped: 0, failed: 0 },
    error: "",
  };
  try {
    activeTask = {
      state,
      attempted: new Set(),
      processed: new Set([...oldContactedIds(), ...alreadyProcessedIds()]),
    };
    writeJsonAtomic(CURRENT_FILE, state);
    appendJsonl(runLogFile(), { timestamp: now(), run_id: state.run_id, event: "run_start", options });
    execute(options);
    return state;
  } catch (error) {
    releaseRunLock();
    activeTask = null;
    throw error;
  }
}

export function pauseRun() {
  if (!activeTask) return { paused: false, reason: "no_active_run", state: getCurrentRun() };
  pauseRequested = true;
  updateState({ status: "pausing" }, "pause_requested");
  return { paused: true, state: activeTask.state };
}

export function getCurrentRun() {
  return activeTask?.state || readJson(CURRENT_FILE, {
    status: "idle",
    counters: { scanned: 0, eligible: 0, greeted: 0, skipped: 0, failed: 0 },
  });
}

export function getTodayReport() {
  const decisions = readJsonl(candidateLogFile()).filter((item) => item.flow_mode === "direct_greet");
  const state = getCurrentRun();
  const runEvents = readJsonl(runLogFile()).filter((item) => item.run_id === state.run_id);
  const skipReasons = {};
  for (const item of decisions.filter((record) => record.action_taken === "skipped")) {
    const reason = item.reason || "未知原因";
    skipReasons[reason] = (skipReasons[reason] || 0) + 1;
  }
  const errors = [...new Set([
    ...decisions.map((item) => item.error).filter(Boolean),
    ...runEvents.map((item) => item.error).filter(Boolean),
    state.error,
  ].filter(Boolean))];
  return {
    date: dateKey(),
    target: state.options?.dailyTarget || 0,
    greeted: decisions.filter((item) => item.action_taken === "greeted").length,
    scanned: decisions.length,
    eligible: decisions.filter((item) => ["dry_run_only", "greeted"].includes(item.action_taken)).length,
    skipped: decisions.filter((item) => item.action_taken === "skipped").length,
    skip_reason_distribution: skipReasons,
    errors,
    current_run_complete: state.status === "completed",
    current_run: state,
  };
}

function parseCli(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    out[arg.slice(2)] = argv[index + 1];
    index += 1;
  }
  return {
    jobId: out.job || "ai_app_intern",
    dailyTarget: out.target,
    batchSize: out["batch-size"],
    batchIntervalMinutes: out["batch-interval-minutes"],
    mode: out.mode,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startRun(parseCli(process.argv.slice(2)))
    .then(() => {
      const timer = setInterval(() => {
        const state = getCurrentRun();
        console.log(JSON.stringify(state));
        if (["completed", "paused"].includes(state.status)) clearInterval(timer);
      }, 1000);
    })
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message, preflight: error.preflight || null }));
      process.exitCode = 1;
    });
}
