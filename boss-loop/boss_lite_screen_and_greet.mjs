#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { enabledJobs, findJobByKey, loadJobsConfig, matchJobFromText, normalizeJobText } = require('../config/job-router.cjs');
const DATA_ROOT = path.resolve(process.env.BOSS_DATA_ROOT || path.resolve(__dirname, '../data'));
const DEFAULT_CONFIG = path.resolve(process.env.BOSS_CONFIG_FILE || path.resolve(__dirname, '../assets/default-config.yaml'));

/* ================================================================
   Phase 1: Config + CLI
   ================================================================ */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'self-check' || key === 'dry-run' || key === 'skip-recommend' || key === 'skip-chat') {
      out[key] = true;
    } else {
      out[key] = argv[++i];
    }
  }
  return out;
}

function readYamlScalar(file, key) {
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
  const m = text.match(re);
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

function readYamlNumber(file, key, fallback) {
  const value = readYamlScalar(file, key);
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2));
  const configFile = args.config || DEFAULT_CONFIG;
  const jobsConfig = loadJobsConfig(PROJECT_ROOT, args['jobs-file'] || '');
  const selectedJobKey = args['job-key'] || '';
  const selectedJob = selectedJobKey ? findJobByKey(jobsConfig, selectedJobKey) : null;
  if (selectedJobKey && !selectedJob?.enabled) throw new Error(`invalid_job_key:${selectedJobKey}`);
  const fallbackJob = selectedJob || enabledJobs(jobsConfig)[0] || null;

  const cfg = {
    job_name: args['job-name'] || readYamlScalar(configFile, 'job_name') || fallbackJob?.display_name || '',
    job_id: args['job-id'] || readYamlScalar(configFile, 'job_id') || '',
    job_key: selectedJobKey,
    selected_job: selectedJob,
    jobs_file: jobsConfig.file,
    jobs_config: jobsConfig,
    mode: 'screen-and-greet',
    proxy: (args.proxy || readYamlScalar(configFile, 'proxy_url') || 'http://127.0.0.1:3456').replace(/\/$/, ''),
    state_file: args['state-file'] || readYamlScalar(configFile, 'state_file') || path.join(DATA_ROOT, 'briefs/boss-auto-lightweight-loop-state.json'),
    contacted_boss_ids_file: args['contacted-boss-ids-file'] || readYamlScalar(configFile, 'contacted_boss_ids_file') || path.join(DATA_ROOT, 'briefs/boss-auto-contacted-ids.jsonl'),
    direct_greet_contacted_file: args['direct-greet-contacted-file'] || path.join(DATA_ROOT, 'briefs/boss-direct-greet-contacted.jsonl'),
    run_log_jsonl_file: args['log-file'] || readYamlScalar(configFile, 'run_log_jsonl_file') || path.join(DATA_ROOT, 'briefs/boss-auto-lightweight-loop-run.jsonl'),
    lock_dir: args['lock-dir'] || readYamlScalar(configFile, 'lock_dir') || path.join(DATA_ROOT, 'briefs/boss-auto.lockdir'),
    run_dir: args['run-dir'] || readYamlScalar(configFile, 'run_log_dir') || path.join(DATA_ROOT, 'briefs'),
    resume_dir: args['resume-dir'] || readYamlScalar(configFile, 'resume_download_dir') || path.join(DATA_ROOT, 'resumes'),
    job_profile_cache_dir: readYamlScalar(configFile, 'job_profile_cache_dir') || path.join(DATA_ROOT, 'briefs/job-profiles'),
    job_profile_cache_ttl_days: readYamlNumber(configFile, 'job_profile_cache_ttl_days', 30),
    job_profile_cache_enabled: readYamlScalar(configFile, 'job_profile_cache_enabled') !== 'false',
    lock_ttl_minutes: readYamlNumber(configFile, 'lock_ttl_minutes', 30),
    state_flush_batch_size: readYamlNumber(configFile, 'state_flush_batch_size', 5),
    max_greet_per_run: Math.max(1, Number(args['max-greet-per-run'] || readYamlNumber(configFile, 'max_greet_per_run', 20))),
    max_scan_per_run: Math.max(1, Number(args['max-scan-per-run'] || readYamlNumber(configFile, 'max_scan_per_run', 80))),
    max_detail_reads_per_run: readYamlNumber(configFile, 'max_detail_reads_per_run', 40),
    fast_max_detail_reads_per_run: readYamlNumber(configFile, 'fast_max_detail_reads_per_run', 20),
    max_list_scroll_rounds: readYamlNumber(configFile, 'max_list_scroll_rounds', 4),
    health_check_every_candidates: readYamlNumber(configFile, 'health_check_every_candidates', 10),
    recommended_greet_interval_seconds_min: readYamlNumber(configFile, 'recommended_greet_interval_seconds_min', 3),
    recommended_greet_interval_seconds_max: readYamlNumber(configFile, 'recommended_greet_interval_seconds_max', 8),
    send_interval_seconds_min: readYamlNumber(configFile, 'send_interval_seconds_min', 0.5),
    send_interval_seconds_max: readYamlNumber(configFile, 'send_interval_seconds_max', 1.5),
    input_to_send_delay_ms: readYamlNumber(configFile, 'input_to_send_delay_ms', 100),
    send_confirm_timeout_ms: readYamlNumber(configFile, 'send_confirm_timeout_ms', 2500),
    greet_confirm_timeout_ms: readYamlNumber(configFile, 'greet_confirm_timeout_ms', 800),
    thread_switch_timeout_ms: readYamlNumber(configFile, 'thread_switch_timeout_ms', 500),
    resume_panel_timeout_ms: readYamlNumber(configFile, 'resume_panel_timeout_ms', 800),
    request_resume_message: readYamlScalar(configFile, 'request_resume_message') || '你好，我这边看了你的经历，和当前岗位匹配度不错。方便的话，可以发一份最新附件简历给我吗？我这边进一步评估后再和你沟通，谢谢。',
    confirm_received_message: readYamlScalar(configFile, 'confirm_received_message') || '简历已收到，我们会尽快筛选，合适的话会联系您。',
    auto_send_threshold: readYamlNumber(configFile, 'auto_send_threshold', 3),
    card_prefilter_enabled: readYamlScalar(configFile, 'card_prefilter_enabled') !== 'false',
    thread_fast_switch_enabled: readYamlScalar(configFile, 'thread_fast_switch_enabled') !== 'false',
    aggressive_prefilter_enabled: readYamlScalar(configFile, 'aggressive_prefilter_enabled') === 'true',
    stop_on_captcha: readYamlScalar(configFile, 'stop_on_captcha') !== 'false',
    stop_on_login_error: readYamlScalar(configFile, 'stop_on_login_error') !== 'false',
    dryRun: !!args['dry-run'],
    selfCheck: !!args['self-check'],
    skipRecommend: !!args['skip-recommend'],
    skipChat: !!args['skip-chat'],
    runId: args['run-id'] || `sg-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
  };

  if (!enabledJobs(jobsConfig).length) throw new Error('no_enabled_jobs');
  return cfg;
}

/* ================================================================
   Globals
   ================================================================ */

let CFG = null;
let targetId = null;
let browserContextId = null;
let stateRoot = null;
let rootWasArray = false;
let contactedBossIds = new Set();
let directGreetContactedIds = new Set();
const sendingBossIds = new Set();
let dirty = new Map();
let haveLock = false;
let pausedReason = null;
let lastJobFilterDetail = null;
let lastOpenChatDetail = null;

const sentStates = new Set([
  'first_contact_sent', 'attachment_requested', 'attachment_sent_by_candidate',
  'attachment_received', 'resume_downloaded', 'ready_for_hire_sync', 'boss_completed'
]);

const counters = {
  scanned: 0, eligible: 0, greeted: 0, sent: 0, received: 0,
  downloaded: 0, queued: 0, skipped: 0, failed: 0
};
const jobRouteCounters = { matched: {}, unknown: 0, ambiguous: 0, filtered: 0 };

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

/* ================================================================
   HTTP / CDP
   ================================================================ */

async function httpJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(options.timeout || 10000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`http_${res.status}:${text.slice(0, 180)}`);
  return text ? JSON.parse(text) : null;
}

async function evalTarget(expr, timeout = 10000) {
  return httpJson(`${CFG.proxy}/eval?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: expr,
    timeout
  });
}

async function clickSelector(selector) {
  return httpJson(`${CFG.proxy}/clickAt?target=${encodeURIComponent(targetId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: selector,
    timeout: 5000
  });
}

async function clickChatListItem(selector) {
  const result = JSON.parse((await evalTarget(`JSON.stringify((() => {
    const selector = ${JSON.stringify(selector)};
    const marked = document.querySelector(selector);
    const item = marked?.closest?.('.geek-item') || marked?.querySelector?.('.geek-item') || marked;
    if (!item) return { ok: false, reason: 'chat_item_not_found', selector };

    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden' &&
        style?.opacity !== '0';
    };
    const findList = el => {
      let node = el;
      while (node && node !== document.body) {
        if (
          node.querySelectorAll?.('.geek-item').length &&
          node.scrollHeight > node.clientHeight + 20
        ) return node;
        node = node.parentElement;
      }
      return null;
    };

    const list = findList(item);
    if (!list) return { ok: false, reason: 'chat_list_container_not_found' };
    item.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });

    const rect = item.getBoundingClientRect();
    const listRect = list.getBoundingClientRect();
    const viewportOk = rect.bottom > 0 && rect.top < window.innerHeight &&
      rect.right > 0 && rect.left < window.innerWidth;
    const insideList = rect.left >= listRect.left - 8 &&
      rect.right <= listRect.right + 8 &&
      rect.top >= listRect.top - 12 &&
      rect.bottom <= listRect.bottom + 12;
    const saneCard = rect.width >= 120 && rect.width <= 520 && rect.height >= 36 && rect.height <= 160;
    if (!visible(item) || !viewportOk || !insideList || !saneCard) {
      return {
        ok: false,
        reason: 'chat_item_not_safely_clickable',
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        listRect: { x: listRect.x, y: listRect.y, width: listRect.width, height: listRect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }
      };
    }

    const x = Math.round(Math.min(rect.right - 10, Math.max(rect.left + 10, rect.left + Math.min(90, rect.width / 2))));
    const y = Math.round(rect.top + rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(item.contains(hit) || hit.contains(item))) {
      return {
        ok: false,
        reason: 'chat_item_click_point_obscured',
        hitText: (hit?.innerText || hit?.textContent || '').trim().slice(0, 120),
        hitClass: String(hit?.className || '').slice(0, 120),
        point: { x, y },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      };
    }

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      item.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: x,
        clientY: y,
        button: 0
      }));
    }
    return {
      ok: true,
      selector,
      point: { x, y },
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      listRect: { x: listRect.x, y: listRect.y, width: listRect.width, height: listRect.height },
      text: (item.innerText || item.textContent || '').trim().slice(0, 180)
    };
  })())`)).value);
  appendLog({ action: 'click_chat_item', result: result.ok ? 'ok' : 'failed', detail: result });
  return result;
}

async function bindTarget() {
  const targets = await httpJson(`${CFG.proxy}/targets`);
  const boss = targets.find(t => t.type === 'page' && /zhipin\.com/.test(t.url) && /chat|recruiter|frame|recommend|web/.test(t.url));
  if (!boss) throw new Error('paused_login_required');
  targetId = boss.targetId;
  browserContextId = boss.browserContextId;
  const probe = JSON.parse((await evalTarget(`JSON.stringify({
    title: document.title,
    url: location.href,
    text: document.body.innerText.slice(0, 500),
    captcha: /验证码|安全验证|拖动/.test(document.body.innerText),
    login: /请登录|扫码登录/.test(document.body.innerText)
  })`)).value);
  if (probe.captcha && CFG.stop_on_captcha) throw new Error('paused_captcha_detected');
  if ((probe.login || !/zhipin\.com/.test(probe.url)) && CFG.stop_on_login_error) throw new Error('paused_login_required');
  return probe;
}

/* ================================================================
   Lock + Log + State
   ================================================================ */

function ensureDirs() {
  fs.mkdirSync(CFG.run_dir, { recursive: true });
  fs.mkdirSync(path.join(CFG.run_dir, 'logs'), { recursive: true });
  fs.mkdirSync(CFG.resume_dir, { recursive: true });
  fs.mkdirSync(path.dirname(CFG.contacted_boss_ids_file), { recursive: true });
  if (CFG.job_profile_cache_dir) fs.mkdirSync(CFG.job_profile_cache_dir, { recursive: true });
}

function acquireLock() {
  const ttl = CFG.lock_ttl_minutes * 60 * 1000;
  try {
    fs.mkdirSync(CFG.lock_dir);
    haveLock = true;
  } catch {
    let age = 0;
    try { age = Date.now() - fs.statSync(CFG.lock_dir).mtimeMs; } catch {}
    if (age < ttl) return false;
    fs.rmSync(CFG.lock_dir, { recursive: true, force: true });
    fs.mkdirSync(CFG.lock_dir);
    haveLock = true;
  }
  fs.writeFileSync(path.join(CFG.lock_dir, 'meta.json'), JSON.stringify({ pid: process.pid, mode: CFG.mode, started_at: nowIso(), host: os.hostname() }, null, 2));
  return true;
}

function releaseLock() {
  if (!haveLock) return;
  try { fs.rmSync(CFG.lock_dir, { recursive: true, force: true }); } catch {}
}

function appendLog(event) {
  fs.appendFileSync(CFG.run_log_jsonl_file, JSON.stringify({ at: nowIso(), run_id: CFG.runId, mode: CFG.mode, ...event }) + '\n');
}

function loadState() {
  if (!fs.existsSync(CFG.state_file)) {
    stateRoot = { version: 1, updated_at: nowIso(), config: { job_name: CFG.job_name }, candidates: {} };
    return;
  }
  stateRoot = JSON.parse(fs.readFileSync(CFG.state_file, 'utf8') || '{}');
  rootWasArray = Array.isArray(stateRoot);
  if (!rootWasArray && !stateRoot.candidates) stateRoot.candidates = {};
}

function normalizeBossId(value) {
  return String(value || '').trim().replace(/^_/, '');
}

function bossCandidateId(bossId) {
  return `boss_chat:${normalizeBossId(bossId)}`;
}

function bossApplicationId(bossId, jobKey) {
  const base = bossCandidateId(bossId);
  return jobKey ? `${base}:${jobKey}` : base;
}

function contactKey(bossId, jobKey) {
  return `${normalizeBossId(bossId)}:${jobKey || "legacy"}`;
}

function jobFields(route, rawText = '') {
  const job = route?.job;
  return {
    job_key: job?.job_key || '',
    job_name: job?.display_name || '',
    boss_job_name_raw: route?.matched_alias || '',
    job_match_status: route?.status || 'unknown',
    job_match_source: 'chat_card',
    job_id: job?.feishu_hire_job_id || '',
    chat_card_text: String(rawText || '').slice(0, 600),
  };
}

function loadContactedBossIds() {
  contactedBossIds = new Set();
  if (!fs.existsSync(CFG.contacted_boss_ids_file)) return;
  const lines = fs.readFileSync(CFG.contacted_boss_ids_file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const bossId = normalizeBossId(typeof record === 'string' ? record : record?.boss_id);
      if (!bossId) continue;
      const route = typeof record === 'object' ? matchJobFromText(CFG.jobs_config, record?.job_name || '') : null;
      contactedBossIds.add(contactKey(bossId, record?.job_key || route?.job?.job_key || 'legacy'));
    } catch {
      const bossId = normalizeBossId(line);
      if (bossId) contactedBossIds.add(contactKey(bossId, 'legacy'));
    }
  }
}

function loadDirectGreetContactedIds() {
  directGreetContactedIds = new Set();
  if (!fs.existsSync(CFG.direct_greet_contacted_file)) return;
  for (const line of fs.readFileSync(CFG.direct_greet_contacted_file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record?.legacy_id) directGreetContactedIds.add(String(record.legacy_id));
    } catch {}
  }
}

function hasContactedBossId(bossId, jobKey) {
  return contactedBossIds.has(contactKey(bossId, jobKey));
}

function rememberContactedBossId(candidate) {
  const bossId = normalizeBossId(candidate?.boss_id);
  const key = contactKey(bossId, candidate?.job_key);
  if (!bossId || contactedBossIds.has(key)) return;
  fs.appendFileSync(CFG.contacted_boss_ids_file, JSON.stringify({
    boss_id: bossId,
    candidate_id: candidate?.candidate_id || bossApplicationId(bossId, candidate?.job_key),
    name: candidate?.name || '',
    job_name: candidate?.job_name || CFG.job_name,
    job_key: candidate?.job_key || '',
    contacted_at: candidate?.message_sent_at || nowIso(),
    source: candidate?.source || 'inbound_chat',
    evidence: candidate?.contact_evidence || 'message_confirmed_in_thread',
  }) + '\n');
  contactedBossIds.add(key);
}

function candidatesMap() {
  if (rootWasArray) {
    const m = new Map();
    for (const c of stateRoot) if (c?.candidate_id) m.set(c.candidate_id, c);
    return m;
  }
  return new Map(Object.entries(stateRoot.candidates || {}));
}

function getCandidate(id) {
  if (!id) return null;
  if (rootWasArray) return stateRoot.find(c => c?.candidate_id === id) || null;
  return stateRoot.candidates[id] || null;
}

function isAlreadyRequested(candidate) {
  return !!candidate && (
    sentStates.has(candidate.status) ||
    candidate.skip_reason === 'already_contacted' ||
    /already_requested|message_sent|recommended_greet_sent_request_resume/.test(String(candidate.last_observation || ''))
  );
}

function hasVerifiedRequestEvidence(candidate) {
  if (!candidate) return false;
  if (candidate.last_observation === 'message_sent') return true;
  if (candidate.last_observation === 'identical_message_already_visible') return true;
  return (candidate.history || []).some(event =>
    event?.action === 'send_resume_request' &&
    (event?.result === 'ok' || event?.error_code === 'identical_message_already_visible')
  );
}

function findAlreadyRequestedInRoot(root, candidate) {
  const values = Array.isArray(root) ? root : Object.values(root?.candidates || {});
  return values.find(existing =>
    existing?.candidate_id === candidate.candidate_id &&
    isAlreadyRequested(existing)
  ) || null;
}

function readLatestStateRoot() {
  if (!fs.existsSync(CFG.state_file)) return { version: 1, candidates: {} };
  return JSON.parse(fs.readFileSync(CFG.state_file, 'utf8') || '{}');
}

function putCandidate(patch) {
  if (CFG.dryRun) return;
  const existing = getCandidate(patch.candidate_id) || {};
  const history = [...(existing.history || [])];
  if (patch.history_event) {
    history.push({ at: nowIso(), run_id: CFG.runId, source: patch.source, ...patch.history_event });
    delete patch.history_event;
  }
  const merged = { ...existing, ...patch, history: history.slice(-20) };
  if (rootWasArray) {
    const idx = stateRoot.findIndex(c => c?.candidate_id === merged.candidate_id);
    if (idx >= 0) stateRoot[idx] = merged;
    else stateRoot.push(merged);
  } else {
    stateRoot.candidates[merged.candidate_id] = merged;
    stateRoot.updated_at = nowIso();
    stateRoot.config = { ...(stateRoot.config || {}), job_name: CFG.job_name, jobs_file: CFG.jobs_file };
  }
  dirty.set(merged.candidate_id, merged);
}

function flushState(force = false) {
  if (CFG.dryRun) { dirty.clear(); return; }
  if (!force && dirty.size < CFG.state_flush_batch_size) return;
  const tmp = `${CFG.state_file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(stateRoot, null, 2));
  fs.renameSync(tmp, CFG.state_file);
  dirty.clear();
}

function candidateId(name, school, fallback) {
  const n = String(name || '').trim().replace(/\s+/g, '');
  const s = String(school || '').trim().replace(/\s+/g, '');
  return s ? `${n}__${s}` : `${n || fallback}`;
}

function invalidCandidateName(name) {
  const value = String(name || '').trim();
  if (value.length < 2 || value.length > 8) return true;
  if (/^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系/.test(value)) return true;
  if (/^(今天|昨天|前天|刚刚|\d+分钟前|\d+小时前|\d{1,2}:\d{2}|\d{1,2}月\d{1,2}日|\d{4}[./-]\d{1,2}[./-]\d{1,2})$/.test(value)) return true;
  if (/Python|Golang|Go|Java|C\+\+|Rust|JavaScript|TypeScript|React|Vue|Node\.js|Spring|Django|Flask|FastAPI|SQL|Linux/i.test(value)) return true;
  if (/后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(value)) return true;
  if (value.includes(CFG.job_name)) return true;
  return false;
}

/* ================================================================
   Dialog / Quota Helpers
   ================================================================ */

async function closeBlockingDialogs(reason = 'cleanup') {
  const expr = `(() => {
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try { if (frame.contentDocument) docs.push(frame.contentDocument); } catch {}
    }
    const quotaRe = /权益|额度|沟通次数|沟通额度|升级套餐|暂无沟通次数|次数已用完/;
    const closeRe = /关闭|取消|知道了|我知道了|稍后|暂不开通|再看看|确定/;
    for (const doc of docs) {
      const nodes = [...doc.querySelectorAll('[role="dialog"], .dialog, .modal, .popup, .boss-popup, .dialog-wrap, .toast, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="layer"]')];
      const dialog = nodes.find(el => {
        const r = el.getBoundingClientRect?.();
        const text = el.innerText || el.textContent || '';
        return text && quotaRe.test(text) && (!r || (r.width > 0 && r.height > 0));
      });
      if (!dialog) continue;
      const buttons = [...dialog.querySelectorAll('button, a, div, span, i')];
      const btn = buttons.find(el => closeRe.test((el.innerText || el.textContent || '').trim()))
        || buttons.find(el => /close|cancel|icon-close|dialog-close|modal-close/i.test([el.className, el.getAttribute('aria-label'), el.getAttribute('title')].join(' ')));
      if (btn) {
        btn.click();
        return JSON.stringify({ ok: true, method: 'dialog_button', reason: ${JSON.stringify(reason)}, text: (dialog.innerText || dialog.textContent || '').slice(0, 120) });
      }
    }
    return JSON.stringify({ ok: false, reason: ${JSON.stringify(reason)} });
  })()`;
  const result = JSON.parse((await evalTarget(expr, 5000)).value);
  appendLog({ action: 'close_blocking_dialog', result: result.ok ? 'ok' : 'not_found', close_reason: reason, detail: result });
  if (result.ok) await sleep(500);
  return result;
}

/* ================================================================
   Recommend Page Phase
   ================================================================ */

async function gotoRecommend() {
  const nav = JSON.parse((await evalTarget(`(() => {
    const links = [...document.querySelectorAll('a,button,span,div')];
    const a = links.find(x => (x.innerText || x.textContent || '').trim() === '推荐牛人');
    if (!a) return JSON.stringify({ ok: false, url: location.href });
    a.setAttribute('data-lobster-nav', 'recommend');
    return JSON.stringify({ ok: true, url: location.href });
  })()`)).value);
  if (nav.ok) {
    await clickSelector('[data-lobster-nav="recommend"]');
    await sleep(1800);
  }
}

async function readRecommendCards() {
  const expr = `(() => {
    const f = document.querySelector('iframe[name=recommendFrame]');
    const d = f?.contentDocument || document;
    const frameRect = f ? f.getBoundingClientRect() : { x: 0, y: 0 };
    const text = d.body.innerText || '';
    const invalidName = line => {
      if (!line || line.length < 2 || line.length > 8) return true;
      if (/^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系|推荐|相似|期望|学历|经历|掌握|选择/.test(line)) return true;
      if (/^(今天|昨天|前天|刚刚|\\d+分钟前|\\d+小时前|\\d{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日|\\d{4}[./-]\\d{1,2}[./-]\\d{1,2})$/.test(line)) return true;
      if (/Python|Golang|Go|Java|C\\+\\+|Rust|JavaScript|TypeScript|React|Vue|Node\\.js|Spring|Django|Flask|FastAPI|SQL|Linux/i.test(line)) return true;
      if (/后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(line)) return true;
      if (/本科|硕士|博士|大专|专科|研究生|应届|在读|岁|K|面议/.test(line)) return true;
      if (line.includes(${JSON.stringify(CFG.job_name)})) return true;
      return false;
    };
    const cards = [...d.querySelectorAll('li.card-item,.geek-card,.candidate-card,[class*="card"]')].map((card, idx) => {
      const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const btn = [...card.querySelectorAll('button,a,div,span')].find(el => /^打招呼$|^立即沟通$/.test((el.innerText || el.textContent || '').trim()));
      if (!btn) return null;
      let name = '';
      for (const line of lines) {
        if (invalidName(line)) continue;
        if (line.length >= 2 && line.length <= 8) { name = line; break; }
      }
      const school = ((card.innerText || '').match(/([^\\s\\n]+(?:大学|学院|理工大学|邮电大学|航空航天大学|科学技术大学|师范大学|农业大学|医科大学|中医药大学))/) || [])[1] || '';
      const workEl = card.querySelector('.work-exps,.timeline-wrap,[class*="work"]');
      const eduEl = card.querySelector('.edu-exp,.edu-wrap,[class*="edu"]');
      const r = btn.getBoundingClientRect();
      btn.setAttribute('data-lobster-greet-target', 'greet_' + idx);
      return { idx, name, school, text: lines.join('\\n'), card_work_experience_text: workEl?.innerText || '', card_education_experience_text: eduEl?.innerText || '', rect: { x: frameRect.x + r.x + r.width / 2, y: frameRect.y + r.y + r.height / 2 } };
    }).filter(Boolean);
    return JSON.stringify({ ok: true, captcha: /验证码|安全验证|拖动/.test(text), login: /请登录|扫码登录/.test(text) && !cards.length, quota: /今日沟通额度|权益.*耗尽|沟通次数已用完|暂无沟通次数/.test(text), cards });
  })()`;
  return JSON.parse((await evalTarget(expr)).value);
}

async function scrollRecommendFeed() {
  const expr = `(() => {
    const f = document.querySelector('iframe[name=recommendFrame]');
    const d = f?.contentDocument || document;
    const nodes = [d.scrollingElement, d.documentElement, d.body, ...d.querySelectorAll('[class*="list"], [class*="scroll"], [class*="recommend"], [class*="content"]')].filter(Boolean);
    const target = nodes.find(el => el.scrollHeight > el.clientHeight + 20);
    if (!target) return JSON.stringify({ moved: false, reason: 'no_scroll_container' });
    const beforeTop = target.scrollTop;
    const beforeHeight = target.scrollHeight;
    target.scrollBy({ top: Math.max(360, Math.floor(target.clientHeight * 0.8)), behavior: 'auto' });
    return JSON.stringify({ moved: target.scrollTop !== beforeTop || target.scrollHeight !== beforeHeight, beforeTop, afterTop: target.scrollTop, beforeHeight, afterHeight: target.scrollHeight });
  })()`;
  return JSON.parse((await evalTarget(expr)).value);
}

async function clickAtViewport(x, y, tag) {
  const marker = `lobster_click_${String(tag || `${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const prepared = JSON.parse((await evalTarget(`(() => {
    document.querySelectorAll('[data-lobster-click-marker]').forEach(el => el.remove());
    const el = document.createElement('div');
    el.setAttribute('data-lobster-click-marker', ${JSON.stringify(marker)});
    Object.assign(el.style, { position: 'fixed', left: ${Math.round(x - 2)} + 'px', top: ${Math.round(y - 2)} + 'px', width: '4px', height: '4px', pointerEvents: 'none', zIndex: '2147483647' });
    document.documentElement.appendChild(el);
    return JSON.stringify({ ok: true, selector: '[data-lobster-click-marker="${marker}"]' });
  })()`)).value);
  if (!prepared.ok) throw new Error('paused_send_failed');
  await clickSelector(prepared.selector);
  await evalTarget(`(() => { document.querySelectorAll('[data-lobster-click-marker]').forEach(el => el.remove()); return JSON.stringify({ ok: true }); })()`).catch(() => {});
}

async function confirmRecommend(idx) {
  const expr = `new Promise(r => setTimeout(() => {
    const f = document.querySelector('iframe[name=recommendFrame]');
    const d = f?.contentDocument || document;
    const card = d.querySelectorAll('li.card-item,.geek-card,.candidate-card,[class*="card"]')[${idx}];
    const text = card?.innerText || '';
    r(JSON.stringify({ ok: /继续沟通|已沟通|已联系/.test(text), still: /打招呼|立即沟通/.test(text), quota: /权益|额度|次数|升级|套餐|沟通次数/.test(d?.body?.innerText || '') }));
  }, ${CFG.greet_confirm_timeout_ms}))`;
  return JSON.parse((await evalTarget(expr, 5000)).value);
}

async function processRecommended() {
  await gotoRecommend();
  let consecutiveFailed = 0;
  const attempted = new Set();
  let scrollRounds = 0;

  while (counters.scanned < CFG.max_scan_per_run && counters.greeted < CFG.max_greet_per_run) {
    const data = await readRecommendCards();
    if (data.captcha) throw new Error('paused_captcha_detected');
    if (data.login) throw new Error('paused_login_required');
    if (data.quota) {
      appendLog({ source: 'recommended_feed', action: 'recommended_stage_end', result: 'quota', error_code: 'paused_boss_contact_quota_exhausted' });
      await closeBlockingDialogs('recommended_quota_exhausted');
      return;
    }

    const card = (data.cards || []).find(c => {
      const id = candidateId(c.name, c.school, `recommended_${c.idx}`);
      const existing = getCandidate(id);
      return c.name && !invalidCandidateName(c.name) && !attempted.has(id) &&
        !directGreetContactedIds.has(id) && !(existing && sentStates.has(existing.status));
    });

    if (!card) {
      if (scrollRounds < CFG.max_list_scroll_rounds) {
        const moved = await scrollRecommendFeed();
        scrollRounds++;
        appendLog({ source: 'recommended_feed', action: 'recommend_scroll', result: moved.moved ? 'moved' : 'not_moved', scroll_round: scrollRounds, detail: moved });
        if (moved.moved) {
          await sleep(900 + Math.floor(Math.random() * 600));
          continue;
        }
      }
      appendLog({ source: 'recommended_feed', action: 'recommend_scan', result: 'no_more_eligible', scroll_rounds: scrollRounds });
      return;
    }

    counters.scanned++;
    if (!card.name || !card.rect || invalidCandidateName(card.name)) { counters.skipped++; continue; }
    const id = candidateId(card.name, card.school, `recommended_${card.idx}`);
    attempted.add(id);
    const existing = getCandidate(id);
    const base = { candidate_id: id, name: card.name, school: card.school, job_name: CFG.job_name, source: 'recommended_feed', card_work_experience_text: card.card_work_experience_text || card.text.slice(0, 300), card_education_experience_text: card.card_education_experience_text };

    if (existing && sentStates.has(existing.status)) {
      counters.skipped++;
      putCandidate({ ...base, decision: 'skip', skip_reason: 'already_contacted', last_observation: 'recommended_duplicate_state', history_event: { action: 'screen_recommended', result: 'skip' } });
      appendLog({ candidate_id: id, source: 'recommended_feed', action: 'screen_recommended', result: 'skip', error_code: 'already_contacted' });
      flushState(true);
      continue;
    }

    counters.eligible++;
    putCandidate({ ...base, status: existing?.status || 'discovered', decision: 'auto_greet_recommended_quota_drain', last_observation: 'recommended_card_bound', history_event: { action: 'screen_recommended', result: 'eligible' } });
    appendLog({ candidate_id: id, source: 'recommended_feed', action: 'screen_recommended', result: 'eligible' });

    if (CFG.dryRun) {
      putCandidate({ ...base, status: 'attachment_requested', decision: 'auto_greet_recommended_quota_drain', last_observation: 'recommended_greet_sent_request_resume_dry_run', greeted_at: nowIso(), message_sent_at: nowIso(), history_event: { action: 'recommended_greet', result: 'dry_run', from: existing?.status || 'discovered', to: 'attachment_requested' } });
      appendLog({ candidate_id: id, source: 'recommended_feed', action: 'recommended_greet', status_to: 'attachment_requested', result: 'dry_run' });
      counters.greeted++;
      flushState(true);
      continue;
    }

    await clickAtViewport(card.rect.x, card.rect.y, `recommend_${card.idx}_${id}`);
    const conf = await confirmRecommend(card.idx);
    if (conf.ok || !conf.still) {
      consecutiveFailed = 0;
      counters.greeted++;
      putCandidate({ ...base, status: 'attachment_requested', decision: 'auto_greet_recommended_quota_drain', last_observation: 'recommended_greet_sent_request_resume', greeted_at: nowIso(), message_sent_at: nowIso(), history_event: { action: 'recommended_greet', result: 'ok', from: existing?.status || 'discovered', to: 'attachment_requested' } });
      appendLog({ candidate_id: id, source: 'recommended_feed', action: 'recommended_greet', status_to: 'attachment_requested', result: 'ok' });
      flushState(true);
      await sleep(rand(CFG.recommended_greet_interval_seconds_min, CFG.recommended_greet_interval_seconds_max) * 1000);
    } else {
      consecutiveFailed++;
      counters.failed++;
      putCandidate({ ...base, last_observation: conf.quota ? 'recommended_quota_exhausted' : 'recommended_greet_no_state_change', last_error: conf.quota ? 'paused_boss_contact_quota_exhausted' : 'greet_no_state_change', history_event: { action: 'recommended_greet', result: 'failed', error_code: conf.quota ? 'paused_boss_contact_quota_exhausted' : 'greet_no_state_change' } });
      appendLog({ candidate_id: id, source: 'recommended_feed', action: 'recommended_greet', result: 'failed', error_code: conf.quota ? 'paused_boss_contact_quota_exhausted' : 'greet_no_state_change' });
      flushState(true);
      if (conf.quota) {
        await closeBlockingDialogs('recommended_quota_exhausted');
        break;
      }
      if (consecutiveFailed >= 3) break;
    }
    if ((counters.scanned % CFG.health_check_every_candidates) === 0) await bindTarget();
  }
}

/* ================================================================
   Chat Page: Navigation + Scroll + Discovery
   ================================================================ */

async function gotoChat() {
  await closeBlockingDialogs('before_goto_chat');
  const nav = JSON.parse((await evalTarget(`(() => {
    const a = [...document.querySelectorAll('a,button,span,div')].find(x => /沟通/.test((x.innerText || x.textContent || '').trim()));
    if (!a) return JSON.stringify({ ok: false });
    a.setAttribute('data-lobster-nav', 'chat');
    return JSON.stringify({ ok: true });
  })()`)).value);
  if (nav.ok) await clickSelector('[data-lobster-nav="chat"]');
  await sleep(1500);
  let checked = JSON.parse((await evalTarget(`(() => JSON.stringify({
    items: document.querySelectorAll('.geek-item[data-id],.geek-item').length,
    url: location.href,
    captcha: /验证码|安全验证|拖动滑块|行为验证/.test(document.body.innerText || ''),
    login: /请登录|扫码登录|登录后继续|账号登录/.test(document.body.innerText || '')
  }))()`)).value);
  if (!checked.items) {
    await httpJson(`${CFG.proxy}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent('https://www.zhipin.com/web/chat/index')}`, { timeout: 8000 });
    await closeBlockingDialogs('after_goto_chat_fallback');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await sleep(1200);
      checked = JSON.parse((await evalTarget(`(() => JSON.stringify({
        items: document.querySelectorAll('.geek-item[data-id],.geek-item').length,
        url: location.href,
        captcha: /验证码|安全验证|拖动滑块|行为验证/.test(document.body.innerText || ''),
        login: /请登录|扫码登录|登录后继续|账号登录/.test(document.body.innerText || '')
      }))()`)).value);
      if (checked.items || checked.login || checked.captcha) break;
    }
  }
  return checked;
}

async function selectChatJobFilter() {
  const job = CFG.selected_job;
  if (!job) throw new Error('paused_job_filter_required');
  const aliases = job.boss_job_names;
  const normalizedAliases = aliases.map(value => normalizeJobText(value));
  const allJobAliases = enabledJobs(CFG.jobs_config)
    .flatMap(item => item.boss_job_names)
    .filter(Boolean);
  const normalizedAllJobAliases = allJobAliases.map(value => normalizeJobText(value));
  const probe = JSON.parse((await evalTarget(`(() => {
    const aliases = ${JSON.stringify(aliases)};
    const normalizedAliases = ${JSON.stringify(normalizedAliases)};
    const allJobAliases = ${JSON.stringify(allJobAliases)};
    const normalizedAllJobAliases = ${JSON.stringify(normalizedAllJobAliases)};
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[\\s·•・_\\-—–（）()【】\\[\\]]+/g, '');
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return r && r.width > 0 && r.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden';
    };
    const textOf = el => (el.innerText || el.textContent || '').trim();
    const matchesJob = text => {
      const normalized = normalize(text);
      return normalizedAliases.some(alias => alias && normalized.includes(alias));
    };
    const matchesAnyConfiguredJob = text => {
      const normalized = normalize(text);
      return normalizedAllJobAliases.some(alias => alias && normalized.includes(alias));
    };
    const controlHint = el => [
      el.className?.baseVal || el.className || '',
      el.getAttribute?.('role') || '',
      el.getAttribute?.('aria-label') || '',
      el.getAttribute?.('title') || '',
      el.parentElement?.className?.baseVal || el.parentElement?.className || ''
    ].join(' ');
    const topNodes = [...document.querySelectorAll('button,a,div,span,[role="button"],input')]
      .filter(visible)
      .filter(el => !el.closest('.geek-item,.chat-conversation,[class*="message"],[class*="editor"]'))
      .map(el => ({ el, text: textOf(el), rect: el.getBoundingClientRect(), hint: controlHint(el) }))
      .filter(item => item.rect.y >= 20 && item.rect.y < 360 && item.rect.x >= 80 && item.rect.x < 1100)
      .filter(item => item.rect.width <= 800 && item.rect.height <= 160)
      .filter(item =>
        item.text === '全部职位' ||
        matchesAnyConfiguredJob(item.text) ||
        /chat-job-search|job-select|job-filter|职位|岗位/i.test(item.hint)
      )
      .sort((a, b) => {
        const aHint = /chat-job-search|job-select|job-filter/i.test(a.hint) ? 0 : 1;
        const bHint = /chat-job-search|job-select|job-filter/i.test(b.hint) ? 0 : 1;
        if (aHint !== bHint) return aHint - bHint;
        const aLeaf = a.el.children.length ? 1 : 0;
        const bLeaf = b.el.children.length ? 1 : 0;
        if (aLeaf !== bLeaf) return aLeaf - bLeaf;
        return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
      });
    const current = topNodes.find(item => matchesJob(item.text));
    const currentLooksInteractive = current && (
      /button|combobox|listbox|menu|select|dropdown|job-search|job-select|job-filter/i.test(
        [current.el.tagName, current.hint].join(' ')
      ) ||
      !!current.el.onclick ||
      getComputedStyle(current.el).cursor === 'pointer'
    );
    if (current && currentLooksInteractive) {
      return JSON.stringify({
        ok: true,
        alreadySelected: true,
        selectedText: current.text,
        aliases,
        candidates: topNodes.slice(0, 12).map(item => ({
          text: item.text.slice(0, 120),
          tag: item.el.tagName,
          className: String(item.el.className || '').slice(0, 160),
          hint: item.hint.slice(0, 200),
          rect: { x: item.rect.x, y: item.rect.y, width: item.rect.width, height: item.rect.height }
        }))
      });
    }
    const trigger = topNodes.find(item => item.text === '全部职位')
      || topNodes.find(item => matchesAnyConfiguredJob(item.text))
      || topNodes[0];
    if (!trigger) {
      const samples = [...document.querySelectorAll('button,a,div,span,[role="button"],input')]
        .filter(visible)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return {
            text: textOf(el).slice(0, 120),
            tag: el.tagName,
            className: String(el.className || '').slice(0, 160),
            hint: controlHint(el).slice(0, 200),
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        })
        .filter(item => item.rect.y >= 20 && item.rect.y < 360 && item.rect.x >= 80 && item.rect.x < 1100)
        .slice(0, 40);
      return JSON.stringify({ ok: false, reason: 'job_filter_trigger_not_found', aliases, allJobAliases, samples });
    }
    const marker = 'job-filter-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-job-filter]').forEach(el => el.removeAttribute('data-boss-auto-job-filter'));
    trigger.el.setAttribute('data-boss-auto-job-filter', marker);
    return JSON.stringify({
      ok: true,
      alreadySelected: false,
      selector: '[data-boss-auto-job-filter="' + marker + '"]',
      triggerText: trigger.text,
      triggerHint: trigger.hint,
      aliases
    });
  })()`)).value);
  appendLog({ action: 'job_filter_probe', result: probe.ok ? 'ok' : 'failed', job_key: job.job_key, detail: probe });
  lastJobFilterDetail = { step: 'probe', ...probe };
  if (!probe.ok) throw new Error(`paused_${probe.reason || 'job_filter_unavailable'}`);
  if (probe.alreadySelected) return probe;

  await clickSelector(probe.selector);
  await sleep(500);
  const option = JSON.parse((await evalTarget(`(() => {
    const normalizedAliases = ${JSON.stringify(normalizedAliases)};
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[\\s·•・_\\-—–（）()【】\\[\\]]+/g, '');
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return r && r.width > 0 && r.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden';
    };
    const candidates = [...document.querySelectorAll('li,button,a,div,span,[role="option"],[role="menuitem"]')]
      .filter(visible)
      .filter(el => !el.closest('.geek-item,.chat-conversation,[class*="message"]'))
      .map(el => ({ el, text: (el.innerText || el.textContent || '').trim(), rect: el.getBoundingClientRect() }))
      .filter(item => item.rect.width <= 600 && item.rect.height <= 120)
      .filter(item => {
        const normalized = normalize(item.text);
        return normalizedAliases.some(alias => alias && normalized.includes(alias));
      })
      .sort((a, b) => {
        const aLeaf = a.el.children.length ? 1 : 0;
        const bLeaf = b.el.children.length ? 1 : 0;
        if (aLeaf !== bLeaf) return aLeaf - bLeaf;
        return (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height);
      });
    const target = candidates[0];
    if (!target) return JSON.stringify({ ok: false, reason: 'job_filter_option_not_found' });
    const marker = 'job-option-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-job-option]').forEach(el => el.removeAttribute('data-boss-auto-job-option'));
    target.el.setAttribute('data-boss-auto-job-option', marker);
    return JSON.stringify({ ok: true, selector: '[data-boss-auto-job-option="' + marker + '"]', text: target.text });
  })()`)).value);
  appendLog({ action: 'job_filter_option', result: option.ok ? 'found' : 'failed', job_key: job.job_key, detail: option });
  lastJobFilterDetail = { step: 'option', ...option };
  if (!option.ok) throw new Error(`paused_${option.reason || 'job_filter_option_not_found'}`);

  await clickSelector(option.selector);
  await sleep(1200);
  const verified = JSON.parse((await evalTarget(`(() => {
    const normalizedAliases = ${JSON.stringify(normalizedAliases)};
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[\\s·•・_\\-—–（）()【】\\[\\]]+/g, '');
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return r && r.width > 0 && r.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden';
    };
    const controls = [...document.querySelectorAll('button,a,div,span,[role="button"],input')]
      .filter(visible)
      .filter(el => !el.closest('.geek-item,.chat-conversation,[class*="message"],[class*="editor"]'))
      .map(el => ({ text: (el.innerText || el.textContent || '').trim(), rect: el.getBoundingClientRect() }))
      .filter(item => item.rect.y >= 50 && item.rect.y < 280 && item.rect.x >= 120 && item.rect.x < 850)
      .filter(item => item.rect.width <= 600 && item.rect.height <= 120);
    const selected = controls.find(item => {
      const normalized = normalize(item.text);
      return normalizedAliases.some(alias => alias && normalized.includes(alias));
    });
    return JSON.stringify({
      ok: !!selected,
      selectedText: selected?.text || '',
      itemCount: document.querySelectorAll('.geek-item[data-id],.geek-item').length
    });
  })()`)).value);
  appendLog({ action: 'job_filter_verify', result: verified.ok ? 'ok' : 'failed', job_key: job.job_key, detail: verified });
  lastJobFilterDetail = { step: 'verify', ...verified };
  if (!verified.ok) throw new Error('paused_job_filter_verification_failed');
  return verified;
}

async function resetChatListToTop() {
  const expr = `(() => {
    const el = document.querySelector('.geek-item');
    let list = el;
    while (list && list !== document.body) {
      if (list.scrollHeight > list.clientHeight + 20) break;
      list = list.parentElement;
    }
    if (!list) list = document.scrollingElement;
    if (!list) return JSON.stringify({ ok: false, reason: 'list_not_found' });
    const beforeTop = list.scrollTop;
    list.scrollTop = 0;
    return JSON.stringify({ ok: true, beforeTop, afterTop: list.scrollTop });
  })()`;
  return JSON.parse((await evalTarget(expr)).value);
}

async function scrollChatList(deltaOverride = null) {
  const expr = `(() => {
    const el = document.querySelector('.geek-item');
    let list = el;
    while (list && list !== document.body) {
      if (list.scrollHeight > list.clientHeight + 20) break;
      list = list.parentElement;
    }
    if (!list) list = document.scrollingElement;
    if (!list) return JSON.stringify({ moved: false, reason: 'list_not_found' });
    const beforeTop = list.scrollTop;
    const beforeHeight = list.scrollHeight;
    const clientH = list.clientHeight || 500;
    const delta = ${deltaOverride === null ? 'Math.max(2000, Math.floor(clientH * 5))' : String(deltaOverride)};
    list.scrollBy({ top: delta, behavior: 'auto' });
    return JSON.stringify({
      moved: list.scrollTop !== beforeTop || list.scrollHeight !== beforeHeight,
      beforeTop, afterTop: list.scrollTop, beforeHeight, afterHeight: list.scrollHeight,
      delta, clientHeight: clientH, itemCount: list.querySelectorAll ? list.querySelectorAll('.geek-item').length : 0
    });
  })()`;
  return JSON.parse((await evalTarget(expr)).value);
}

async function readChatCardsOnePage() {
  const expr = `(() => {
    const text = document.body.innerText || '';
    const items = [...document.querySelectorAll('.geek-item[data-id],.geek-item')].slice(0, ${CFG.max_scan_per_run}).map((el, idx) => {
      const lines = (el.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const id = el.getAttribute('data-id') || el.id || ('chat_' + idx);
      const marker = 'chat-card-' + Date.now() + '-' + idx + '-' + Math.floor(Math.random() * 1000000);
      el.setAttribute('data-lobster-chat-card', marker);
      const invalidName = x => !x || x.length < 2 || x.length > 8 || /^[+＋]/.test(x) || /更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系/.test(x) || /^(今天|昨天|前天|刚刚|\\d+分钟前|\\d+小时前|\\d{1,2}:\\d{2}|\\d{1,2}月\\d{1,2}日|\\d{4}[./-]\\d{1,2}[./-]\\d{1,2})$/.test(x) || /Python|Golang|Go|Java|C\\+\\+|Rust|JavaScript|TypeScript|React|Vue|Node\\.js|Spring|Django|Flask|FastAPI|SQL|Linux/i.test(x) || /后端|前端|测试|算法|运维|产品|运营|开发|架构|数据|人工智能|实习|项目|工程师|经理|主管|专员|顾问|助理/.test(x) || x.includes(${JSON.stringify(CFG.job_name)});
      const name = lines.find(x => !invalidName(x)) || '';
      const unread = /^\\d+$/.test(lines[0] || '');
      const timeText = lines.find(x => /^(今天|昨天|前天|刚刚|\\d+分钟前|\\d+小时前|\\d{1,2}:\\d{2})$/.test(x)) || '';
      const latestFromSelfHint = /\\[(?:送达|已读|未读)\\]/.test(lines.join('\\n'));
      return { idx, boss_id: id, dom_marker: marker, name, text: lines.join('\\n'), unread, timeText, latestFromSelfHint };
    });
    return JSON.stringify({ captcha: /验证码|安全验证|拖动/.test(text), login: /请登录|扫码登录/.test(text) && !items.length, items });
  })()`;
  return JSON.parse((await evalTarget(expr)).value);
}

async function readChatCardsWithScroll() {
  const allItems = new Map();
  const reset = await resetChatListToTop();
  appendLog({ action: 'chat_list_reset', result: reset.ok ? 'ok' : 'failed', detail: reset });
  await sleep(400);

  for (let round = 0; round <= CFG.max_list_scroll_rounds; round++) {
    const data = await readChatCardsOnePage();
    if (data.captcha) throw new Error('paused_captcha_detected');
    if (data.login) throw new Error('paused_login_required');

    let newCount = 0;
    for (const item of data.items || []) {
      if (!allItems.has(item.boss_id)) {
        allItems.set(item.boss_id, item);
        newCount++;
      }
    }
    appendLog({ action: 'chat_cards_read', result: 'ok', round, new_count: newCount, total: allItems.size });

    if (newCount === 0 && round > 0) break;
    if (round >= CFG.max_list_scroll_rounds) break;

    const moved = await scrollChatList();
    appendLog({ action: 'chat_scroll', result: moved.moved ? 'moved' : 'not_moved', round: round + 1, detail: moved });
    if (!moved.moved) break;
    await sleep(1500 + Math.floor(Math.random() * 500));

    // If no new items after scroll, try a larger jump once
    if (newCount === 0 && round > 0 && moved.moved) {
      const bigJump = await scrollChatList(Math.max(4000, moved.clientHeight * 10));
      appendLog({ action: 'chat_scroll_bigjump', result: bigJump.moved ? 'moved' : 'not_moved', detail: bigJump });
      if (bigJump.moved) await sleep(1800 + Math.floor(Math.random() * 400));
    }
  }

  return Array.from(allItems.values());
}

/* ================================================================
   Chat Page: Detail Read (Right Panel)
   ================================================================ */

async function openChatAndReadDetail(item) {
  const prepared = JSON.parse((await evalTarget(`(() => {
    const bossId = ${JSON.stringify(item.boss_id || '')};
    const domMarker = ${JSON.stringify(item.dom_marker || '')};
    const name = ${JSON.stringify(item.name || '')};
    const jobName = ${JSON.stringify(item.job_name_raw || '')};
    const idx = ${JSON.stringify(item.idx || 0)};
    const normalizeId = value => String(value || '').trim().replace(/^_/, '');
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden' &&
        style?.opacity !== '0';
    };
    const items = [...document.querySelectorAll('.geek-item[data-id],.geek-item')].filter(visible);
    document.querySelectorAll('[data-lobster-chat-open]').forEach(el => el.removeAttribute('data-lobster-chat-open'));
    const matchesJob = el => !jobName || (el.innerText || el.textContent || '').includes(jobName);
    const markedRaw = domMarker ? document.querySelector('[data-lobster-chat-card="' + domMarker.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"]') : null;
    const marked = markedRaw?.closest?.('.geek-item') || markedRaw;
    const exact = items.find(el => bossId && (
      normalizeId(el.getAttribute('data-id')) === normalizeId(bossId) ||
      normalizeId(el.id) === normalizeId(bossId) ||
      normalizeId(el.querySelector?.('.geek-item[data-id]')?.getAttribute('data-id')) === normalizeId(bossId)
    ) && matchesJob(el));
    const byName = items
      .filter(el => name && (el.innerText || el.textContent || '').includes(name) && matchesJob(el))
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      })[0];
    const found = marked || exact || byName || null;
    if (!found) {
      return JSON.stringify({
        ok: false,
        reason: 'chat_target_not_found',
        bossId,
        domMarker,
        name,
        visible: items.slice(0, 12).map(el => ({
          id: el.getAttribute?.('data-id') || el.id || '',
          text: (el.innerText || el.textContent || '').trim().slice(0, 160),
          className: String(el.className || '').slice(0, 120)
        }))
      });
    }
    const el = found.closest?.('.geek-item') || found;
    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.width > 520 || rect.height < 36 || rect.height > 160) {
      return JSON.stringify({
        ok: false,
        reason: 'chat_target_rect_unsafe',
        bossId,
        domMarker,
        name,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        source: marked ? 'scan_marker' : exact ? 'normalized_id' : 'name_job'
      });
    }
    const stable = bossId || found.getAttribute?.('data-id') || found.id || ('chat_' + idx);
    const marker = 'open_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
    el.setAttribute('data-lobster-chat-open', marker);
    return JSON.stringify({
      ok: true,
      selector: '[data-lobster-chat-open="' + marker + '"]',
      bossId: stable,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      source: marked ? 'scan_marker' : exact ? 'normalized_id' : 'name_job'
    });
  })()`)).value);

  if (!prepared.ok) {
    return {
      ok: false,
      stale: true,
      reason: prepared.reason,
      detail: prepared,
    };
  }

  if (!CFG.dryRun) {
    const clicked = await clickChatListItem(prepared.selector);
    if (!clicked.ok) {
      return {
        ok: false,
        stale: true,
        reason: clicked.reason || 'chat_item_click_failed',
        detail: { prepared, clicked },
      };
    }
    await sleep(1200);
  }

  const expr = `(() => {
    const name = ${JSON.stringify(item.name)};
    const text = document.body.innerText || '';
    const input = !!document.querySelector('.chat-container-private [contenteditable], [contenteditable]');
    const selected = [...document.querySelectorAll('.geek-item.selected,.geek-item.active,.geek-item.cur')].map(e => e.innerText).join('\\n');
    const rightPanel = document.querySelector('.chat-container-private');
    const rightText = (rightPanel?.innerText || text).slice(0, 3500);

    // Try to extract school from education section
    let school = '';
    const eduMatch = rightText.match(/([^\\s\\n]+(?:大学|学院|理工大学|邮电大学|航空航天大学|科学技术大学|师范大学|农业大学|医科大学|中医药大学))/);
    if (eduMatch) school = eduMatch[1];

    // Try to extract work experience
    let workText = '';
    const workEl = document.querySelector('[class*="work"], [class*="experience"], [class*="timeline"]');
    if (workEl) workText = (workEl.innerText || '').slice(0, 600);

    // Try to extract education experience
    let eduText = '';
    const eduEl2 = document.querySelector('[class*="edu"], [class*="education"]');
    if (eduEl2) eduText = (eduEl2.innerText || '').slice(0, 400);

    // Classify the latest turn. An attachment followed by "请查收" is still
    // an incoming resume as long as both messages arrived after our last reply.
    const conv = document.querySelector('.chat-conversation, [class*="conversation"]');
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden';
    };
    const explicitRows = conv ? [...conv.querySelectorAll(
      '.item-myself,.item-friend,.chat-message,.message-row,.message-item,[class*="message-item"],[class*="message-row"]'
    )].filter(visible) : [];
    const fallbackRows = !explicitRows.length && conv
      ? [...conv.querySelectorAll('.message-bubble,[class*="message"]')].filter(visible).filter(el => {
          const value = (el.innerText || el.textContent || '').trim();
          if (!value) return false;
          return ![...el.children].some(child => (child.innerText || child.textContent || '').trim() === value);
        })
      : [];
    const messageRows = (explicitRows.length ? explicitRows : fallbackRows).filter((el, index, rows) =>
      !rows.some((other, otherIndex) => otherIndex !== index && other.contains(el))
    );
    const convRect = conv?.getBoundingClientRect?.();
    const messages = messageRows.map(row => {
      const rowText = (row.innerText || row.textContent || '').trim();
      const owner = row.closest(
        '.item-myself,.item-friend,.message-self,.message-right,.is-me,.my-message,.from-me,[class*="myself"],[class*="self"],[class*="mine"],[class*="right"]'
      ) || row;
      const signature = [
        owner.className?.baseVal || owner.className || '',
        owner.getAttribute?.('data-from') || '',
        owner.getAttribute?.('data-owner') || ''
      ].join(' ');
      const rect = row.getBoundingClientRect?.();
      const textSaysSelf = (
        /(?:^|\\n)(?:已读|送达|未读)(?:\\n|$)/.test(rowText) &&
        (
          rowText.includes(${JSON.stringify(CFG.request_resume_message)}) ||
          rowText.includes(${JSON.stringify(CFG.confirm_received_message)})
        )
      );
      const classSaysSelf = textSaysSelf ||
        /myself|message-self|is-me|my-message|from-me|mine|message-right|item-my|\\bright\\b/i.test(signature);
      const classSaysCandidate = /item-friend|message-left|from-candidate|from-geek|\\bleft\\b/i.test(signature);
      const positionSaysSelf = !!(!classSaysCandidate && convRect && rect && rect.width > 0 &&
        (rect.left + rect.width / 2) > (convRect.left + convRect.width * 0.58));
      const attachmentControl = [...row.querySelectorAll('button,a,div,span,[role="button"]')]
        .filter(visible)
        .some(el => /^(同意|接收)$|点击预览附件简历|^.{1,120}\\.(?:pdf|doc|docx)$/i.test(
          (el.innerText || el.textContent || '').trim()
        ));
      const attachmentText = /对方想发送附件简历给您，您是否同意|点击预览附件简历|^.{1,120}\\.(?:pdf|doc|docx)$/im.test(rowText);
      return {
        text: rowText.slice(0, 500),
        fromSelf: classSaysSelf || positionSaysSelf,
        fromCandidate: classSaysCandidate || !(classSaysSelf || positionSaysSelf),
        hasAttachment: attachmentControl || attachmentText,
        owner: signature.slice(0, 200)
      };
    }).filter(message => message.text);
    const lastMessage = messages.at(-1) || null;
    const lastSelfIndex = messages.findLastIndex(message => message.fromSelf);
    const incomingTail = messages.slice(lastSelfIndex + 1).filter(message => message.fromCandidate);
    const incomingTailHasAttachment = incomingTail.some(message => message.hasAttachment);
    const listSaysSelf = ${JSON.stringify(!!item.latestFromSelfHint)};
    const conversationState = listSaysSelf
      ? 'outgoing_waiting'
      : lastMessage
        ? lastMessage.fromSelf
        ? 'outgoing_waiting'
        : incomingTailHasAttachment
          ? 'incoming_resume'
          : 'incoming_message'
        : 'unknown';

    const identity = name ? rightText.includes(name) || selected.includes(name) : true;
    const hasResumeAnchor = /在线简历|附件简历|简历/.test(rightText);

    return JSON.stringify({
      input,
      selected: selected.slice(0, 300),
      rightText: rightText.slice(0, 1200),
      identity,
      school,
      workText: workText.slice(0, 600),
      eduText: eduText.slice(0, 400),
      messages: messages.slice(-6).map(message => message.text),
      lastMessageText: lastMessage?.text || '',
      lastMessageFromSelf: conversationState === 'outgoing_waiting',
      lastMessageOwner: lastMessage?.owner || '',
      conversationState,
      latestMessageHasAttachment: conversationState === 'incoming_resume',
      incomingTailHasAttachment,
      incomingTailTexts: incomingTail.slice(-6).map(message => message.text),
      hasResumeAnchor,
      captcha: /验证码|安全验证|拖动/.test(text)
    });
  })()`;

  const detail = JSON.parse((await evalTarget(expr)).value);
  return { ok: true, stale: false, source: prepared.source || '', detail };
}

/* ================================================================
   Job Profile + LLM Scoring
   ================================================================ */

async function loadJobProfile() {
  const cachePath = CFG.job_profile_cache_dir ? path.join(CFG.job_profile_cache_dir, `${CFG.job_name}.json`) : null;

  // Try cache first
  if (CFG.job_profile_cache_enabled && cachePath && fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const ageDays = (Date.now() - new Date(cached.updated_at || 0).getTime()) / (86400000);
      if (ageDays < CFG.job_profile_cache_ttl_days) {
        appendLog({ action: 'load_job_profile', result: 'cache_hit', path: cachePath, age_days: Math.round(ageDays) });
        return cached;
      }
    } catch {}
  }

  // Try to read from Boss page
  const jdProbe = JSON.parse((await evalTarget(`(() => {
    const text = document.body.innerText || '';
    const jdMatch = text.match(/(岗位职责|岗位描述|职位描述|工作职责|工作内容)[\\s\\S]{0,1200}/);
    const reqMatch = text.match(/(任职要求|岗位要求|任职资格)[\\s\\S]{0,1200}/);
    return JSON.stringify({ jd: (jdMatch?.[0] || '').slice(0, 800), req: (reqMatch?.[0] || '').slice(0, 800), text: text.slice(0, 2000) });
  })()`)).value);

  // Build a simple profile from JD text
  const jdText = `${jdProbe.jd}\n${jdProbe.req}`;
  const positive = [];
  const negative = [];
  const hard = [];

  // Very simple keyword extraction heuristics
  const techStack = jdText.match(/Python|Golang|Go|Java|C\+\+|Rust|JavaScript|TypeScript|React|Vue|Node\.js|Spring|Django|Flask|FastAPI|SQL|MySQL|Redis|MongoDB|Docker|Kubernetes|Linux/gi) || [];
  for (const t of [...new Set(techStack.map(s => s.toLowerCase()))]) positive.push(t);

  const degreeReq = /本科|硕士|博士|大专/.exec(jdText);
  if (degreeReq) hard.push(`学历要求：${degreeReq[0]}`);

  const expReq = /(\d+)[\-\+]?年/.exec(jdText);
  if (expReq) hard.push(`经验要求：${expReq[0]}`);

  const cityReq = /(北京|上海|广州|深圳|杭州|成都|南京|武汉|西安|苏州)/.exec(jdText);
  if (cityReq) positive.push(cityReq[0]);

  const internReq = /实习| interns?/i.exec(jdText);
  if (internReq) positive.push('实习');

  const profile = {
    job_id: CFG.job_id || CFG.job_name,
    job_name: CFG.job_name,
    positive_keywords: positive.length ? positive : [CFG.job_name.toLowerCase()],
    negative_keywords: negative,
    hard_filters: hard,
    auto_send_threshold: CFG.auto_send_threshold,
    jd_summary: jdText.slice(0, 400),
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  if (cachePath) {
    try { fs.writeFileSync(cachePath, JSON.stringify(profile, null, 2)); } catch {}
  }
  appendLog({ action: 'load_job_profile', result: 'extracted_from_page', path: cachePath, positive_count: positive.length });
  return profile;
}

async function callAnthropic(messages, maxTokens = 512) {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

  if (!apiKey) throw new Error('no_api_key');

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`llm_${res.status}:${text.slice(0, 200)}`);
  const data = JSON.parse(text);
  return data.content?.[0]?.text || '';
}

function scoreCandidateFallback(detail, jobProfile) {
  const text = `${detail.text || ''} ${detail.workText || ''} ${detail.eduText || ''} ${detail.messages?.join(' ') || ''}`.toLowerCase();
  const positives = (jobProfile.positive_keywords || []).filter(kw => text.includes(kw.toLowerCase()));
  const negatives = (jobProfile.negative_keywords || []).filter(kw => text.includes(kw.toLowerCase()));

  let rating = 3;
  if (positives.length >= 3) rating = 5;
  else if (positives.length >= 2) rating = 4;
  else if (positives.length >= 1) rating = 3;
  else rating = 2;

  if (negatives.length > 0) rating = Math.max(1, rating - 1);
  if (/不考虑|不方便|已找到|不想|拒绝/.test(text)) rating = 1;

  return {
    rating,
    hard_filters_passed: rating >= 2,
    match_reasons: positives.length ? `命中关键词：${positives.join('、')}` : '无明确匹配关键词',
    risk_points: negatives.length ? `负面信号：${negatives.join('、')}` : '',
    skip_reason: rating < CFG.auto_send_threshold ? (rating === 1 ? 'rejected_or_negative' : 'not_matched') : null,
    recommended_action: rating >= CFG.auto_send_threshold ? 'auto_contact' : 'skip',
    llm_fallback: true,
  };
}

function directContactDecision() {
  return {
    rating: 5,
    hard_filters_passed: true,
    match_reasons: '当前流程不启用候选人评分',
    risk_points: '',
    skip_reason: null,
    recommended_action: 'auto_contact',
    scoring_disabled: true,
  };
}

async function scoreCandidateWithLLM(detail, jobProfile) {
  const text = `${detail.text || ''}\n工作经历：${detail.workText || ''}\n教育经历：${detail.eduText || ''}\n最近消息：${(detail.messages || []).join(' | ')}`;

  const prompt = `你是一位招聘筛选助手。请根据以下岗位画像和候选人信息，给出结构化评分。

## 岗位画像
- 岗位：${jobProfile.job_name}
- 加分关键词：${(jobProfile.positive_keywords || []).join('、') || '无'}
- 减分关键词：${(jobProfile.negative_keywords || []).join('、') || '无'}
- 硬性条件：${(jobProfile.hard_filters || []).join('、') || '无'}
- 自动触达阈值：${jobProfile.auto_send_threshold}星及以上

## 候选人信息
${text.slice(0, 1500)}

## 输出要求（只输出 JSON，不要其他内容）
{
  "rating": 1-5 的整数,
  "hard_filters_passed": true/false,
  "match_reasons": "匹配原因简述",
  "risk_points": "风险点简述，无则留空",
  "skip_reason": "如果不达标说明原因，否则 null",
  "recommended_action": "auto_contact 或 skip"
}`;

  const startedAt = Date.now();
  try {
    const raw = await callAnthropic([{ role: 'user', content: prompt }]);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const rating = Math.max(1, Math.min(5, Number(parsed.rating) || 3));
    const result = {
      rating,
      hard_filters_passed: !!parsed.hard_filters_passed,
      match_reasons: String(parsed.match_reasons || '').slice(0, 200),
      risk_points: String(parsed.risk_points || '').slice(0, 200),
      skip_reason: parsed.skip_reason || (rating < CFG.auto_send_threshold ? 'below_threshold' : null),
      recommended_action: parsed.recommended_action || (rating >= CFG.auto_send_threshold ? 'auto_contact' : 'skip'),
      llm_fallback: false,
      llm_latency_ms: Date.now() - startedAt,
    };
    appendLog({ action: 'llm_score', result: 'ok', rating, latency_ms: result.llm_latency_ms });
    return result;
  } catch (e) {
    appendLog({ action: 'llm_score', result: 'failed', error: String(e.message || e).slice(0, 200) });
    return scoreCandidateFallback(detail, jobProfile);
  }
}

/* ================================================================
   Send Resume Request
   ================================================================ */

async function sendResumeRequest() {
  const msg = CFG.request_resume_message;

  // 1. The caller has already classified the latest message. Keep only the
  // exact-message idempotency check here.
  const before = JSON.parse((await evalTarget(`(() => {
    const normalize = value => String(value || '').replace(/\\s+/g, '').trim();
    const expected = normalize(${JSON.stringify(msg)});
    const conv = document.querySelector('.chat-conversation, [class*="conversation"]');
    if (!conv) return JSON.stringify({ ok: false, reason: 'conversation_not_found', exactCount: 0 });
    const conversationText = normalize(conv.innerText || conv.textContent || '');
    const nodes = [...conv.querySelectorAll('.chat-message, .message-bubble, [class*="message"]')];
    const exactNodes = nodes.filter(el => {
      const text = normalize(el.innerText || el.textContent || '');
      if (text !== expected) return false;
      return ![...el.children].some(child => normalize(child.innerText || child.textContent || '') === expected);
    });
    return JSON.stringify({
      ok: true,
      exactCount: exactNodes.length,
      conversationContains: conversationText.includes(expected)
    });
  })()`)).value);
  if (!before.ok) throw new Error('paused_send_failed');
  if (before.exactCount > 0 || before.conversationContains) {
    return {
      alreadySent: true,
      reason: 'identical_message_already_visible',
      cleared: true,
      exactCountBefore: before.exactCount,
      exactCountAfter: before.exactCount
    };
  }

  // 2. Fill message
  const wrote = JSON.parse((await evalTarget(`(() => {
    const input = document.querySelector('.chat-container-private [contenteditable], [contenteditable]');
    if (!input) return JSON.stringify({ ok: false, reason: 'editor_not_found' });
    input.focus();
    input.innerText = ${JSON.stringify(msg)};
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(msg)} }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(msg)} }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ ok: (input.innerText || input.textContent || '').includes(${JSON.stringify(msg.slice(0, 12))}) });
  })()`)).value);
  if (!wrote.ok) throw new Error('paused_send_failed');

  // 3. Small delay then locate and click send button exactly once.
  await sleep(CFG.input_to_send_delay_ms);

  const sendProbe = JSON.parse((await evalTarget(`(() => {
    const actionId = 'boss-auto-send-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-send-id]').forEach(el => el.removeAttribute('data-boss-auto-send-id'));
    const btns = [...document.querySelectorAll('.chat-container-private .submit, .chat-input .submit, .submit, button, [role="button"]')]
      .filter(el => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
        const t = (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim();
        return /发送/.test(t) || String(el.className || '').includes('submit');
      })
      .sort((a, b) => {
        const as = String(a.className || '').includes('submit') ? 0 : 10;
        const bs = String(b.className || '').includes('submit') ? 0 : 10;
        if (as !== bs) return as - bs;
        return b.getBoundingClientRect().x - a.getBoundingClientRect().x;
      });
    const btn = btns[0];
    if (!btn) return JSON.stringify({ ok: false, reason: 'send_button_not_found' });
    btn.setAttribute('data-boss-auto-send-id', actionId);
    const r = btn.getBoundingClientRect();
    return JSON.stringify({ ok: true, selector: '[data-boss-auto-send-id="' + actionId + '"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  })()`)).value);

  if (!sendProbe.ok) throw new Error('paused_send_failed');

  await clickSelector(sendProbe.selector);

  // 4. Confirm that this click created a new exact message node.
  const confirmExpr = `new Promise(r => setTimeout(() => {
    const msg = ${JSON.stringify(msg)};
    const exactCountBefore = ${before.exactCount};
    const normalize = value => String(value || '').replace(/\\s+/g, '').trim();
    const expected = normalize(msg);
    const input = document.querySelector('.chat-container-private [contenteditable], [contenteditable]');
    const editorText = (input?.innerText || input?.textContent || '').trim();
    const conv = document.querySelector('.chat-conversation, [class*="conversation"]');
    const conversationText = normalize(conv?.innerText || conv?.textContent || '');
    const nodes = conv ? [...conv.querySelectorAll('.chat-message, .message-bubble, [class*="message"]')] : [];
    const exactNodes = nodes.filter(el => {
      const text = normalize(el.innerText || el.textContent || '');
      if (text !== expected) return false;
      return ![...el.children].some(child => normalize(child.innerText || child.textContent || '') === expected);
    });
    const createdCount = exactNodes.length - exactCountBefore;
    const conversationContains = conversationText.includes(expected);
    r(JSON.stringify({
      cleared: !editorText || !editorText.includes(msg.slice(0, 20)),
      created: createdCount === 1 || conversationContains,
      duplicateCreated: createdCount > 1,
      createdCount,
      exactCountBefore,
      exactCountAfter: exactNodes.length,
      conversationContains,
      editorText: editorText.slice(0, 120),
    }));
  }, ${CFG.send_confirm_timeout_ms}))`;

  return JSON.parse((await evalTarget(confirmExpr, 3000)).value);
}

/* ================================================================
   Chat Page Phase: Two-Stage (Screen then Send)
   ================================================================ */

async function processInbound() {
  const chatPage = await gotoChat();
  if (chatPage.captcha) throw new Error('paused_captcha_detected');
  if (chatPage.login) throw new Error('paused_login_required');
  if (!chatPage.items) {
    appendLog({
      action: 'chat_page_ready',
      result: 'failed',
      error_code: 'paused_chat_page_unavailable',
      url: chatPage.url || '',
    });
    throw new Error('paused_chat_page_unavailable');
  }
  await selectChatJobFilter();

  // Interleaved scroll + process: process candidates while they're still in the DOM
  const allItems = new Map();
  const scored = [];
  let detailReads = 0;
  let failures = 0;
  let consecutiveOpenFailures = 0;

  const reset = await resetChatListToTop();
  appendLog({ action: 'chat_list_reset', result: reset.ok ? 'ok' : 'failed', detail: reset });
  await sleep(400);

  scanRounds:
  for (let round = 0; round <= CFG.max_list_scroll_rounds; round++) {
    const data = await readChatCardsOnePage();
    if (data.captcha) throw new Error('paused_captcha_detected');
    if (data.login) throw new Error('paused_login_required');

    let newCount = 0;
    const newItems = [];
    for (const item of data.items || []) {
      const route = matchJobFromText(CFG.jobs_config, item.text);
      const itemKey = `${item.boss_id}:${route.job?.job_key || route.status}:${route.matched_alias || ""}`;
      if (!allItems.has(itemKey)) {
        item.jobRoute = route;
        item.job_name_raw = route.matched_alias || "";
        allItems.set(itemKey, item);
        newCount++;
        newItems.push(item);
      }
    }
    appendLog({ action: 'chat_cards_read', result: 'ok', round, new_count: newCount, total: allItems.size });

    // Process newly discovered items immediately while they're in the DOM
    for (const item of newItems) {
      if (detailReads >= (CFG.aggressive_prefilter_enabled ? CFG.fast_max_detail_reads_per_run : CFG.max_detail_reads_per_run)) {
        appendLog({ action: 'detail_read_limit', result: 'reached', limit: CFG.max_detail_reads_per_run });
        break;
      }
      if (!item.name || invalidCandidateName(item.name)) continue;

      const observedRoute = item.jobRoute || matchJobFromText(CFG.jobs_config, item.text);
      const selectedRoute = { status: 'matched', job: CFG.selected_job, matched_alias: CFG.selected_job.display_name };
      if (observedRoute.status === 'matched' && observedRoute.job.job_key !== CFG.job_key) {
        jobRouteCounters.filtered += 1;
        counters.skipped++;
        appendLog({
          source: 'inbound_chat',
          action: 'identify_job',
          result: 'skip',
          error_code: 'job_filter_card_mismatch',
          name: item.name,
          boss_id: item.boss_id || '',
          selected_job_key: CFG.job_key,
          observed_job_key: observedRoute.job.job_key,
          card_text: String(item.text || '').slice(0, 600),
        });
        continue;
      }
      const route = selectedRoute;
      jobRouteCounters.matched[route.job.job_key] = (jobRouteCounters.matched[route.job.job_key] || 0) + 1;

      const bossId = normalizeBossId(item.boss_id);
      if (!bossId) {
        counters.skipped++;
        appendLog({ source: 'inbound_chat', action: 'screen_inbound', result: 'skip', error_code: 'missing_boss_id', name: item.name });
        continue;
      }
      const id = bossApplicationId(bossId, route.job.job_key);
      const legacyCandidate = getCandidate(bossCandidateId(bossId));
      const existing = getCandidate(id) || (
        legacyCandidate && (!legacyCandidate.job_name || legacyCandidate.job_name === route.job.display_name)
          ? legacyCandidate
          : null
      );
      const baseCandidate = {
        candidate_id: id,
        person_id: bossCandidateId(bossId),
        application_id: id,
        boss_id: bossId,
        name: item.name,
        school: '',
        source: 'inbound_chat',
        ...jobFields(route, item.text),
        boss_job_name_raw: observedRoute.matched_alias || CFG.selected_job.display_name,
        job_match_status: observedRoute.status === 'matched' ? 'verified' : 'selected_filter',
        job_match_source: 'selected_job_filter',
      };

      counters.scanned++;
      detailReads++;
      appendLog({
        candidate_id: id,
        person_id: baseCandidate.person_id,
        boss_id: bossId,
        source: 'inbound_chat',
        action: 'identify_job',
        result: 'matched',
        job_key: route.job.job_key,
        job_name: route.job.display_name,
        matched_alias: route.matched_alias,
      });

      if (CFG.dryRun) {
        const score = directContactDecision();
        scored.push({ item, id, score, detail: { text: item.text } });
        counters.eligible++;
        putCandidate({
          ...baseCandidate,
          status: score.rating >= CFG.auto_send_threshold && score.hard_filters_passed ? 'eligible' : 'screened',
          rating: score.rating, hard_filters_passed: score.hard_filters_passed,
          decision: score.rating >= CFG.auto_send_threshold && score.hard_filters_passed ? 'auto_contact' : 'skip',
          skip_reason: score.skip_reason, match_reasons: score.match_reasons, risk_points: score.risk_points,
          last_observation: 'dry_run_screened',
          history_event: { action: 'screen_inbound', result: score.rating >= CFG.auto_send_threshold && score.hard_filters_passed ? 'eligible' : 'skip', error_code: score.skip_reason }
        });
        appendLog({ candidate_id: id, boss_id: bossId, source: 'inbound_chat', action: 'screen_inbound', result: score.rating >= CFG.auto_send_threshold && score.hard_filters_passed ? 'eligible' : 'skip', rating: score.rating });
        if (counters.eligible >= CFG.max_greet_per_run) break scanRounds;
        continue;
      }

      // Real run: open chat and read detail (item is still in DOM from readChatCardsOnePage)
      const opened = await openChatAndReadDetail(item);
      if (opened.detail?.captcha) throw new Error('paused_captcha_detected');
      if (opened.stale) {
        lastOpenChatDetail = {
          at: nowIso(),
          boss_id: bossId,
          candidate_name: item.name,
          job_key: route.job.job_key,
          reason: opened.reason || 'chat_target_not_found',
          detail: opened.detail || null,
        };
        consecutiveOpenFailures++;
        counters.skipped++;
        putCandidate({
          ...baseCandidate,
          last_error: opened.reason || 'chat_target_not_found', last_observation: 'chat_target_stale',
          history_event: { action: 'open_chat', result: 'skipped', error_code: opened.reason || 'chat_target_not_found' }
        });
        appendLog({ candidate_id: id, boss_id: bossId, source: 'inbound_chat', action: 'open_chat', result: 'skipped', error_code: opened.reason || 'chat_target_not_found' });
        if (consecutiveOpenFailures >= 3) throw new Error('paused_chat_targets_unavailable');
        continue;
      }
      lastOpenChatDetail = {
        at: nowIso(),
        boss_id: bossId,
        candidate_name: item.name,
        job_key: route.job.job_key,
        source: opened.source || '',
        ok: true,
      };
      consecutiveOpenFailures = 0;

      if (!opened.detail.input) {
        throw new Error('paused_resume_panel_not_found');
      }
      if (!opened.detail.identity) {
        throw new Error('paused_candidate_identity_mismatch');
      }

      const schoolFromDetail = opened.detail.school || '';
      const stableId = id;

      const score = directContactDecision();
      scored.push({ item, id: stableId, score, detail: opened.detail });

      const status = score.rating >= CFG.auto_send_threshold && score.hard_filters_passed ? 'eligible' : 'screened';
      appendLog({ candidate_id: stableId, boss_id: bossId, source: 'inbound_chat', action: 'screen_inbound', result: status, rating: score.rating, hard_filters_passed: score.hard_filters_passed });

      // Send immediately to eligible candidates while chat is open
      if (status === 'eligible' && counters.sent < CFG.max_greet_per_run) {
        if (opened.detail.conversationState === 'incoming_resume') {
          counters.skipped++;
          const completedStatus = existing?.boss_completed_at
            ? 'boss_completed'
            : existing?.local_resume_path && existing?.resume_hash
              ? 'ready_for_hire_sync'
              : '';
          if (completedStatus) {
            appendLog({
              candidate_id: stableId, boss_id: bossId, source: 'inbound_chat',
              action: 'send_resume_request', result: 'skipped',
              error_code: 'resume_already_collected',
              preserved_status: completedStatus,
              last_message_text: opened.detail.lastMessageText || ''
            });
            continue;
          }
          const attachmentCandidate = {
            ...baseCandidate, candidate_id: stableId, application_id: stableId, school: schoolFromDetail,
            status: 'attachment_sent_by_candidate',
            rating: score.rating, hard_filters_passed: true,
            decision: 'collect_resume', skip_reason: 'candidate_already_sent_resume',
            message_sent_at: existing?.message_sent_at || nowIso(),
            last_observation: 'incoming_turn_contains_resume',
            history_event: {
              action: 'send_resume_request',
              result: 'skipped',
              error_code: 'candidate_already_sent_resume',
              from: 'eligible',
              to: 'attachment_sent_by_candidate'
            }
          };
          putCandidate(attachmentCandidate);
          appendLog({
            candidate_id: stableId, boss_id: bossId, source: 'inbound_chat',
            action: 'send_resume_request', result: 'skipped',
            error_code: 'candidate_already_sent_resume',
            conversation_state: opened.detail.conversationState,
            last_message_text: opened.detail.lastMessageText || '',
            incoming_tail_texts: opened.detail.incomingTailTexts || []
          });
          continue;
        }
        if (opened.detail.conversationState === 'outgoing_waiting') {
          counters.skipped++;
          appendLog({
            candidate_id: stableId, boss_id: bossId, source: 'inbound_chat',
            action: 'send_resume_request',
            result: 'skipped', error_code: 'latest_message_from_self',
            contacted_boss_id_recorded: hasContactedBossId(bossId, route.job.job_key),
            last_message_text: opened.detail.lastMessageText || '',
            last_message_owner: opened.detail.lastMessageOwner || ''
          });
          continue;
        }
        if (opened.detail.conversationState !== 'incoming_message') {
          counters.skipped++;
          appendLog({
            candidate_id: stableId, boss_id: bossId, source: 'inbound_chat',
            action: 'send_resume_request', result: 'skipped',
            error_code: 'conversation_state_unknown'
          });
          continue;
        }
        const latestRoot = readLatestStateRoot();
        const alreadyRequested = findAlreadyRequestedInRoot(latestRoot, { candidate_id: stableId, name: item.name, school: schoolFromDetail, job_name: route.job.display_name });
        const verifiedRequest = hasContactedBossId(bossId, route.job.job_key) || hasVerifiedRequestEvidence(alreadyRequested || existing);
        if (verifiedRequest) {
          counters.skipped++;
          appendLog({
            candidate_id: stableId, boss_id: bossId, source: 'inbound_chat',
            action: 'send_resume_request', result: 'deduplicated',
            error_code: 'verified_request_already_sent',
            contacted_boss_id_recorded: hasContactedBossId(bossId, route.job.job_key),
            last_message_text: opened.detail.lastMessageText || ''
          });
          continue;
        }
        if (!sendingBossIds.has(bossId)) {
          sendingBossIds.add(bossId);
          let sent;
          try {
            sent = await sendResumeRequest();
          } finally {
            sendingBossIds.delete(bossId);
          }
          if (sent.alreadySent) {
            const contactedAt = nowIso();
            const contactedCandidate = {
              ...baseCandidate, candidate_id: stableId, application_id: stableId, school: schoolFromDetail,
              status: 'attachment_requested', rating: score.rating, hard_filters_passed: true,
              decision: 'auto_contact', message_sent_at: contactedAt,
              skip_reason: sent.reason || 'already_contacted',
              last_observation: sent.reason || 'identical_message_already_visible',
              contact_evidence: 'identical_message_visible_in_thread',
              history_event: { action: 'send_resume_request', result: 'deduplicated', error_code: sent.reason || 'already_contacted', from: 'eligible', to: 'attachment_requested' }
            };
            rememberContactedBossId(contactedCandidate);
            putCandidate(contactedCandidate);
            appendLog({ candidate_id: stableId, boss_id: bossId, source: 'inbound_chat', action: 'send_resume_request', status_to: 'attachment_requested', result: 'deduplicated', detail: sent });
          } else if (sent.duplicateCreated) {
            appendLog({ candidate_id: stableId, boss_id: bossId, source: 'inbound_chat', action: 'send_resume_request', result: 'paused', error_code: 'duplicate_send_detected', detail: sent });
            throw new Error('paused_duplicate_send_detected');
          } else if (sent.cleared && sent.created) {
            failures = 0;
            counters.sent++;
            const contactedAt = nowIso();
            const contactedCandidate = {
              ...baseCandidate, candidate_id: stableId, application_id: stableId, school: schoolFromDetail,
              status: 'attachment_requested', rating: score.rating, hard_filters_passed: true,
              decision: 'auto_contact', skip_reason: null, message_sent_at: contactedAt,
              last_observation: 'message_sent',
              contact_evidence: 'message_confirmed_in_thread',
              history_event: { action: 'send_resume_request', result: 'ok', from: 'eligible', to: 'attachment_requested' }
            };
            rememberContactedBossId(contactedCandidate);
            putCandidate(contactedCandidate);
            appendLog({ candidate_id: stableId, boss_id: bossId, source: 'inbound_chat', action: 'send_resume_request', status_to: 'attachment_requested', result: 'ok' });
            if (counters.sent >= CFG.max_greet_per_run) break scanRounds;
            await sleep(rand(CFG.send_interval_seconds_min, CFG.send_interval_seconds_max) * 1000);
          } else {
            failures++;
            counters.failed++;
            putCandidate({
              ...baseCandidate, candidate_id: stableId, application_id: stableId, school: schoolFromDetail,
              last_error: 'send_confirm_failed', last_observation: 'send_confirm_failed',
              history_event: { action: 'send_resume_request', result: 'failed', error_code: 'send_confirm_failed' }
            });
            appendLog({ candidate_id: stableId, boss_id: bossId, source: 'inbound_chat', action: 'send_resume_request', result: 'failed', error_code: 'send_confirm_failed', detail: sent });
            if (failures >= 3) throw new Error('paused_send_failed');
          }
        }
      }

      if ((counters.scanned % CFG.health_check_every_candidates) === 0) {
        await bindTarget();
        flushState(true);
      }
    }

    if (detailReads >= (CFG.aggressive_prefilter_enabled ? CFG.fast_max_detail_reads_per_run : CFG.max_detail_reads_per_run)) {
      appendLog({ action: 'detail_read_limit', result: 'reached', limit: CFG.max_detail_reads_per_run });
      break;
    }
    if (round >= CFG.max_list_scroll_rounds) break;

    const moved = await scrollChatList();
    appendLog({ action: 'chat_scroll', result: moved.moved ? 'moved' : 'not_moved', round: round + 1, detail: moved });
    if (!moved.moved) break;
    await sleep(1500 + Math.floor(Math.random() * 500));

    // If no new items after scroll, try a larger jump once
    if (newCount === 0 && round > 0 && moved.moved) {
      const bigJump = await scrollChatList(Math.max(4000, moved.clientHeight * 10));
      appendLog({ action: 'chat_scroll_bigjump', result: bigJump.moved ? 'moved' : 'not_moved', detail: bigJump });
      if (bigJump.moved) await sleep(1800 + Math.floor(Math.random() * 400));
    }
  }

  flushState(true);
  appendLog({ action: 'chat_phase_end', result: 'ok', candidate_count: allItems.size, scored: scored.length, sent: counters.sent });
}

/* ================================================================
   Main
   ================================================================ */

async function main() {
  CFG = loadConfig();
  ensureDirs();

  if (CFG.selfCheck) {
    console.log(JSON.stringify({
      status: 'ok',
      script: 'boss_lite_screen_and_greet',
      job_name: CFG.job_name,
      mode: CFG.mode,
      dry_run: CFG.dryRun,
      skip_recommend: CFG.skipRecommend,
      skip_chat: CFG.skipChat,
      max_greet_per_run: CFG.max_greet_per_run,
      proxy: CFG.proxy,
      jobs_file: CFG.jobs_file,
      jobs: enabledJobs(CFG.jobs_config).map(job => ({
        job_key: job.job_key,
        display_name: job.display_name,
        feishu_configured: /^\d+$/.test(job.feishu_hire_job_id),
      })),
    }));
    return;
  }

  if (!acquireLock()) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'lock_exists', mode: CFG.mode }));
    return;
  }

  loadState();
  loadContactedBossIds();
  loadDirectGreetContactedIds();

  try {
    await bindTarget();
    appendLog({ action: 'run_start', result: 'ok', targetId, browserContextId, job_name: CFG.job_name });

    if (!CFG.skipRecommend) {
      await processRecommended();
    } else {
      appendLog({ source: 'recommended_feed', action: 'recommended_stage_skip', result: 'user_requested_chat_only' });
    }

    if (!CFG.skipChat) {
      await bindTarget();
      await processInbound();
    } else {
      appendLog({ source: 'inbound_chat', action: 'chat_stage_skip', result: 'user_requested_recommend_only' });
    }
    flushState(true);
    appendLog({ action: 'run_end', result: 'ok' });
  } catch (e) {
    const msg = String(e?.message || e);
    pausedReason = msg.startsWith('paused_') ? msg : 'paused_send_failed';
    counters.failed++;
    appendLog({ action: 'run_pause', result: 'failed', error_code: pausedReason, error_message: msg.slice(0, 240) });
    flushState(true);
  } finally {
    releaseLock();
  }

  console.log(JSON.stringify({
    status: pausedReason ? 'paused' : 'ok',
    mode: CFG.mode,
    ...counters,
    job_routes: jobRouteCounters,
    job_filter: lastJobFilterDetail,
    open_chat: lastOpenChatDetail,
    paused_reason: pausedReason,
    next: pausedReason ? 'screen-and-greet' : (CFG.skipChat ? 'done' : 'collect-resumes'),
    run_id: CFG.runId,
  }));
}

await main();
