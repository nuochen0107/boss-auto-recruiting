#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildBatchPlan, normalizeRunOptions } from "./quota_scheduler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { findJobByKey, loadJobsConfig } = require("../config/job-router.cjs");
const DATA_DIR = path.resolve(process.env.BOSS_DATA_ROOT || path.join(ROOT, "data"));
const RUN_DIR = path.join(DATA_DIR, "runs");
const CANDIDATE_DIR = path.join(DATA_DIR, "candidates");
const CURRENT_FILE = path.join(RUN_DIR, "current-run.json");
const RUN_LOCK_DIR = path.join(RUN_DIR, "recommend-greet.lock");
const PIPELINE_LOCK_DIR = path.join(RUN_DIR, "legacy-pipeline.lock");
const OLD_STATE_FILE = path.join(DATA_DIR, "briefs/boss-auto-lightweight-loop-state.json");
const OLD_LOCK_DIR = path.join(DATA_DIR, "briefs/boss-auto.lockdir");
const DIRECT_CONTACTED_FILE = path.join(DATA_DIR, "briefs/boss-direct-greet-contacted.jsonl");
const PROXY = (process.env.CDP_PROXY_URL || "http://127.0.0.1:3456").replace(/\/$/, "");
const MAX_CONSECUTIVE_FAILURES = Math.max(1, Number(process.env.BOSS_MAX_CONSECUTIVE_FAILURES || 3));
const GREET_DELAY_MIN_MS = Math.max(1000, Number(process.env.BOSS_GREET_DELAY_MIN_MS || 2000));
const GREET_DELAY_MAX_MS = Math.max(GREET_DELAY_MIN_MS, Number(process.env.BOSS_GREET_DELAY_MAX_MS || 5000));

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
  const legacy = lockInfo(OLD_LOCK_DIR);
  if (legacy.exists && !legacy.active) fs.rmSync(OLD_LOCK_DIR, { recursive: true, force: true });
  try {
    fs.mkdirSync(RUN_LOCK_DIR);
    const meta = {
      pid: process.pid,
      mode: "recommend-greet",
      started_at: now(),
      host: os.hostname(),
    };
    fs.writeFileSync(path.join(RUN_LOCK_DIR, "meta.json"), JSON.stringify(meta, null, 2));
    fs.mkdirSync(OLD_LOCK_DIR);
    fs.writeFileSync(path.join(OLD_LOCK_DIR, "meta.json"), JSON.stringify(meta, null, 2));
  } catch {
    releaseRunLock();
    throw new Error("run_lock_exists");
  }
}

function releaseRunLock() {
  for (const directory of [RUN_LOCK_DIR, OLD_LOCK_DIR]) {
    const info = lockInfo(directory);
    if (info.pid !== process.pid) continue;
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }
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

async function clickPagePoint(targetId, x, y, purpose = "point") {
  const marker = `dashboard-${purpose}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await evalTarget(targetId, `JSON.stringify((() => {
    document.querySelectorAll('[data-recruit-dashboard-point]').forEach(el => el.remove());
    const el = document.createElement('i');
    el.setAttribute('data-recruit-dashboard-point', ${JSON.stringify(marker)});
    Object.assign(el.style, {
      position: 'fixed',
      left: '${Math.round(x - 3)}px',
      top: '${Math.round(y - 3)}px',
      width: '6px',
      height: '6px',
      pointerEvents: 'none',
      zIndex: '2147483647'
    });
    document.documentElement.appendChild(el);
    return { ok: true };
  })())`);
  try {
    return await clickSelector(targetId, `[data-recruit-dashboard-point="${marker}"]`);
  } finally {
    await evalTarget(targetId, `document.querySelectorAll('[data-recruit-dashboard-point]').forEach(el => el.remove())`).catch(() => {});
  }
}

async function findBossTarget() {
  const targets = await requestJson(`${PROXY}/targets`, { timeout: 2500 });
  const candidates = (targets || []).filter((item) =>
    item.type === "page" &&
    /zhipin\.com/.test(item.url || "") &&
    !/登录/.test(item.title || ""));
  const target = candidates.sort((a, b) => {
    const priority = item => {
      const url = item.url || "";
      if (/\/web\/chat\/recommend/.test(url)) return 0;
      if (/\/web\/chat/.test(url)) return 1;
      if (/\/web\/geek\/recommend|\/web\/recruit/.test(url)) return 2;
      return 10;
    };
    return priority(a) - priority(b);
  })[0];
  if (!target) throw new Error("paused_boss_not_logged_in");
  return target;
}

async function inspectPage(targetId) {
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const docs = [document, ...[...document.querySelectorAll('iframe')].map(f => {
      try { return f.contentDocument; } catch { return null; }
    }).filter(Boolean)];
    const text = docs.map(d => d.body?.innerText || '').join('\\n').slice(0, 30000);
    const warningPattern = /操作(?:过于)?频繁|账号(?:存在)?异常|检测到异常操作|暂时无法沟通|访问受限|沟通功能受限|账号存在风险/;
    const visibleNoticeText = docs.flatMap(d => [...d.querySelectorAll(
      '[role="dialog"],[class*="dialog"],[class*="modal"],[class*="toast"],[class*="notice"],[class*="warning"]'
    )]).filter(el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
    }).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean).slice(0, 20);
    const warningText = visibleNoticeText.find(value => warningPattern.test(value)) || '';
    return {
      title: document.title,
      url: location.href,
      captcha: /验证码|安全验证|拖动滑块|行为验证|人机验证/.test(text),
      login: /请登录|扫码登录|登录后/.test(text),
      warning: Boolean(warningText) || warningPattern.test(text),
      warning_reason: warningText || (text.match(warningPattern) || [])[0] || '',
      quota: /今日沟通额度.*(?:用完|耗尽)|沟通次数已用完|暂无沟通次数|权益.*耗尽/.test(text)
    };
  })())`);
  return JSON.parse(raw);
}

async function gotoRecommend(targetId) {
  const current = await requestJson(`${PROXY}/info?target=${encodeURIComponent(targetId)}`, { timeout: 3000 }).catch(() => null);
  if (/\/web\/chat\/recommend/.test(current?.url || "")) {
    return { ok: true, targetId, url: current.url, alreadyThere: true };
  }

  await requestJson(
    `${PROXY}/navigate?target=${encodeURIComponent(targetId)}&url=${encodeURIComponent("https://www.zhipin.com/web/chat/recommend")}`,
    { timeout: 8000 },
  );
  await wait(2200);
  const navigated = await requestJson(`${PROXY}/info?target=${encodeURIComponent(targetId)}`, { timeout: 3000 }).catch(() => null);
  if (/\/web\/chat\/recommend/.test(navigated?.url || "")) {
    return { ok: true, targetId, url: navigated.url, directNavigation: true };
  }

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
  const resolved = await findBossTarget();
  return { ...result, targetId: resolved.targetId, url: resolved.url };
}

async function selectRecommendJob(targetId, options) {
  const aliases = options.jobAliases || [options.jobName];
  const probe = async (mode) => JSON.parse(await evalTarget(targetId, `JSON.stringify((() => {
    const desiredAliases = ${JSON.stringify(aliases)};
    const mode = ${JSON.stringify(mode)};
    const frame = document.querySelector('iframe[name="recommendFrame"]');
    const doc = frame?.contentDocument;
    const frameRect = frame?.getBoundingClientRect();
    if (!doc || !frameRect) return {
      ok: false,
      reason: 'recommend_frame_unavailable',
      aliases: desiredAliases,
      candidates: []
    };
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
      .replace(/[\\s·•・_\\-—–（）()【】\\[\\]]+/g, '');
    const desired = desiredAliases.map(normalize).filter(Boolean);
    const matchesDesired = text => {
      const normalized = normalize(text);
      return desired.some(value => value && normalized.includes(value));
    };
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden' &&
        style?.opacity !== '0' && style?.pointerEvents !== 'none';
    };
    const describe = el => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.textContent || '').trim();
      return {
        text,
        desiredMatch: matchesDesired(text),
        x: frameRect.x + rect.x + rect.width / 2,
        y: frameRect.y + rect.y + rect.height / 2,
        source: 'recommendFrame',
        signature: [
          el.tagName, el.className?.baseVal || el.className || '',
          el.getAttribute?.('role') || '', el.parentElement?.className?.baseVal ||
          el.parentElement?.className || ''
        ].join(' ').slice(0, 180)
      };
    };
    const current = [...doc.querySelectorAll('.job-item.curr,[class*="job-item"][class*="curr"]')]
      .find(visible);
    const trigger = [
      ...doc.querySelectorAll('.job-selecter-wrap,.job-selector-wrap,[class*="job-selecter"],[class*="job-selector"]')
    ].filter(visible).sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.width * ar.height - br.width * br.height;
    })[0];
    const options = [...doc.querySelectorAll('.job-item,[class*="job-item"],[role="option"]')]
      .filter(visible)
      .map(describe)
      .filter(Boolean);
    const target = mode === 'option'
      ? options.find(item => item.desiredMatch)
      : describe(trigger);
    const currentDetail = describe(current) || describe(trigger);
    return {
      ok: !!target,
      alreadySelected: mode === 'trigger' && !!currentDetail?.desiredMatch,
      target,
      current: currentDetail,
      aliases: desiredAliases,
      candidates: options.slice(0, 15)
    };
  })())`));

  const current = await probe("trigger");
  appendJsonl(runLogFile(), {
    timestamp: now(),
    run_id: activeTask.state.run_id,
    event: "recommend_job_probe",
    job_id: options.jobId,
    detail: current,
  });
  if (!current.ok) throw new Error("paused_recommend_job_selector_not_found");
  if (current.alreadySelected) {
    updateState({
      recommend_job: {
        job_id: options.jobId,
        selected_text: current.current?.text || current.target?.text || "",
        already_selected: true,
      },
    }, "recommend_job_selected");
    return current;
  }

  let option = await probe("option");
  let dropdownWasOpen = option.ok;
  if (!option.ok) {
    await clickPagePoint(targetId, current.target.x, current.target.y, "recommend-job-trigger");
    await wait(500);
    option = await probe("option");
    dropdownWasOpen = false;
  }
  appendJsonl(runLogFile(), {
    timestamp: now(),
    run_id: activeTask.state.run_id,
    event: "recommend_job_option",
    job_id: options.jobId,
    dropdown_was_open: dropdownWasOpen,
    detail: option,
  });
  if (!option.ok) throw new Error("paused_recommend_job_option_not_found");
  await clickPagePoint(targetId, option.target.x, option.target.y, "recommend-job-option");
  await wait(1200);

  const verified = await probe("trigger");
  if (!verified.ok || !verified.alreadySelected) {
    throw new Error("paused_recommend_job_verification_failed");
  }
  updateState({
    recommend_job: {
      job_id: options.jobId,
      selected_text: verified.current?.text || verified.target?.text || "",
      already_selected: false,
    },
  }, "recommend_job_selected");
  return verified;
}

function cardExtractionExpression(jobName) {
  return `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const frameRect = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
    const bodyText = doc.body?.innerText || '';
    const warningPattern = /操作(?:过于)?频繁|账号(?:存在)?异常|检测到异常操作|暂时无法沟通|访问受限|沟通功能受限|账号存在风险/;
    const visibleNoticeText = [...doc.querySelectorAll(
      '[role="dialog"],[class*="dialog"],[class*="modal"],[class*="toast"],[class*="notice"],[class*="warning"]'
    )].filter(el => {
      const rect = el.getBoundingClientRect?.();
      const style = doc.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 && style?.display !== 'none' && style?.visibility !== 'hidden';
    }).map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean);
    const warningText = visibleNoticeText.find(value => warningPattern.test(value)) || '';
    const invalidName = value => !value || value.length < 2 || value.length > 12 ||
      /^[+＋]|更多选项|打招呼|立即沟通|继续沟通|已沟通|已联系|推荐|相似|期望|学历|经历|掌握|选择/.test(value) ||
      /本科|硕士|博士|大专|应届|在读|岁|K|面议/.test(value) ||
      value.includes(${JSON.stringify(jobName)});
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = doc.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden';
    };
    const isGreetButton = el =>
      /^(打招呼|立即沟通)$/.test((el.innerText || el.textContent || '').trim()) && visible(el);
    const buttons = [...doc.querySelectorAll('button,a,div,span')]
      .filter(isGreetButton)
      .filter(el => ![...el.querySelectorAll('button,a,div,span')].some(child =>
        child !== el && isGreetButton(child)));
    const cards = buttons.map((button, index) => {
      const card = button.closest('li.card-item,.geek-card,.candidate-card,[class*="card"]');
      if (!card) return null;
      const lines = (card.innerText || '').split('\\n').map(s => s.trim()).filter(Boolean);
      const name = lines.find(line => !invalidName(line)) || '';
      const text = lines.join('\\n');
      if (/为你推荐[\\s\\S]*相似的\\s*\\d*\\s*个?牛人/.test(text) || text.length > 4000) return null;
      const school = (text.match(/([^\\s\\n]+(?:大学|学院|职业技术学院))/) || [])[1] || '';
      const age = (text.match(/(\\d{2})岁/) || [])[1] || '';
      const education = (text.match(/博士|硕士|本科|大专|专科/) || [])[0] || '';
      const expectedCity = (text.match(/期望\\s*\\n?([^\\s\\n]+)/) || [])[1] || '';
      const salary = (text.match(/\\d+\\s*[-~]\\s*\\d+K|\\d+\\s*[-~]\\s*\\d+元[^\\n]*/) || [])[0] || '';
      const rect = button.getBoundingClientRect();
      const marker = 'candidate_' + index + '_' + Math.random().toString(36).slice(2, 8);
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
      greet_control_count: cards.length,
      captcha: /验证码|安全验证|拖动滑块|行为验证|人机验证/.test(bodyText),
      login: /请登录|扫码登录/.test(bodyText) && cards.length === 0,
      warning: Boolean(warningText) || warningPattern.test(bodyText),
      warning_reason: warningText || (bodyText.match(warningPattern) || [])[0] || '',
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
    const nodes = [
      doc.scrollingElement,
      doc.documentElement,
      doc.body,
      ...doc.querySelectorAll('[class*="list"],[class*="scroll"],[class*="recommend"],[class*="content"]')
    ].filter(Boolean);
    const target = nodes.find(el => el.scrollHeight > el.clientHeight + 20);
    if (!target) return { moved: false, reason: 'no_scroll_container' };
    const before = target.scrollTop;
    const beforeHeight = target.scrollHeight;
    target.scrollBy({ top: Math.max(400, Math.floor(target.clientHeight * .8)), behavior: 'auto' });
    return {
      moved: target.scrollTop !== before || target.scrollHeight !== beforeHeight,
      before,
      after: target.scrollTop,
      before_height: beforeHeight,
      after_height: target.scrollHeight,
      target_class: String(target.className || '').slice(0, 160)
    };
  })())`);
  return JSON.parse(raw);
}

async function clickCard(targetId, card) {
  const position = JSON.parse(await evalTarget(targetId, `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const button = doc.querySelector('[data-recruit-dashboard-greet="${String(card.marker).replaceAll('"', '\\"')}"]');
    if (!button) return { ok: false, reason: 'greet_button_not_found' };
    button.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const frameRect = frame ? frame.getBoundingClientRect() : { x: 0, y: 0 };
    const rect = button.getBoundingClientRect();
    return {
      ok: rect.width > 0 && rect.height > 0,
      x: frameRect.x + rect.x + rect.width / 2,
      y: frameRect.y + rect.y + rect.height / 2,
      text: (button.innerText || button.textContent || '').trim()
    };
  })())`));
  if (!position.ok || !/^(打招呼|立即沟通)$/.test(position.text || "")) {
    throw new Error(position.reason || "greet_button_not_clickable");
  }

  const marker = `dashboard-click-${Date.now()}`;
  await evalTarget(targetId, `JSON.stringify((() => {
    document.querySelectorAll('[data-recruit-dashboard-click]').forEach(el => el.remove());
    const el = document.createElement('i');
    el.setAttribute('data-recruit-dashboard-click', ${JSON.stringify(marker)});
    Object.assign(el.style, {
      position: 'fixed', left: '${Math.round(position.x - 2)}px',
      top: '${Math.round(position.y - 2)}px', width: '4px', height: '4px',
      pointerEvents: 'none', zIndex: '2147483647'
    });
    document.documentElement.appendChild(el);
    return { ok: true };
  })())`);
  await clickSelector(targetId, `[data-recruit-dashboard-click="${marker}"]`);
  await evalTarget(targetId, `document.querySelectorAll('[data-recruit-dashboard-click]').forEach(el => el.remove())`).catch(() => {});
}

async function clickCardFallback(targetId, marker) {
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const button = doc.querySelector('[data-recruit-dashboard-greet="${String(marker).replaceAll('"', '\\"')}"]');
    const text = (button?.innerText || button?.textContent || '').trim();
    if (!button || !/^(打招呼|立即沟通)$/.test(text)) {
      return { clicked: false, reason: button ? 'button_state_changed' : 'button_not_found', text };
    }
    button.click();
    return { clicked: true, text };
  })())`);
  return JSON.parse(raw);
}

async function closePostGreetingPrompt(targetId, reason = "post_greet") {
  const closed = [];
  let quietRounds = 0;

  // The site may add one prompt per greeting. Drain all visible layers instead
  // of closing only the most recent one.
  for (let attempt = 0; attempt < 10 && quietRounds < 2; attempt += 1) {
    const raw = await evalTarget(targetId, `JSON.stringify((() => {
      const contexts = [{ doc: document, frameRect: { x: 0, y: 0 }, source: 'main' }];
      for (const frame of document.querySelectorAll('iframe')) {
        try {
          if (frame.contentDocument) contexts.push({
            doc: frame.contentDocument,
            frameRect: frame.getBoundingClientRect(),
            source: frame.name || frame.className || 'iframe'
          });
        } catch {}
      }
      const visible = el => {
        const rect = el.getBoundingClientRect?.();
        const style = el.ownerDocument.defaultView?.getComputedStyle(el);
        return rect && rect.width > 0 && rect.height > 0 &&
          style?.display !== 'none' && style?.visibility !== 'hidden' &&
          style?.opacity !== '0' && style?.pointerEvents !== 'none';
      };
      const promptPattern = /已发送招呼|招呼已发送|已打招呼|打招呼成功|为你推荐[\\s\\S]*相似|继续沟通|沟通成功/;
      const layerSelector = [
        '[role="dialog"]', '[class*="dialog"]', '[class*="modal"]',
        '[class*="popup"]', '[class*="popover"]', '[class*="layer"]',
        '[class*="mask"]', '[class*="drawer"]'
      ].join(',');
      const preferred = ['不再显示', '知道了', '我知道了', '暂不', '取消', '关闭'];

      for (const contextInfo of contexts) {
        const doc = contextInfo.doc;
        const layers = [...doc.querySelectorAll(layerSelector)]
          .filter(visible)
          .filter(layer => {
            const rect = layer.getBoundingClientRect();
            const style = doc.defaultView?.getComputedStyle(layer);
            const text = (layer.innerText || layer.textContent || '').trim();
            const modalShape = rect.width >= 180 && rect.height >= 80 &&
              (style?.position === 'fixed' || style?.position === 'absolute' || layer.getAttribute('role') === 'dialog');
            return promptPattern.test(text) || modalShape;
          })
          .sort((a, b) => {
            const az = Number(a.ownerDocument.defaultView?.getComputedStyle(a).zIndex) || 0;
            const bz = Number(b.ownerDocument.defaultView?.getComputedStyle(b).zIndex) || 0;
            return bz - az;
          });
        for (const layer of layers) {
          const context = (layer.innerText || layer.textContent || '').trim();
          const controls = [...layer.querySelectorAll(
            'button,a,[role="button"],[aria-label],[title],[class*="close"],[class*="Close"],i,svg'
          )].filter(visible);
          const textOf = el => (
            el.innerText || el.textContent || el.getAttribute?.('aria-label') ||
            el.getAttribute?.('title') || ''
          ).trim();

          for (const label of preferred) {
            const control = controls.find(el => textOf(el) === label);
            if (control) {
              const rect = control.getBoundingClientRect();
              return {
                found: true,
                button_text: label,
                reason: ${JSON.stringify(reason)},
                prompt_text: context.slice(0, 200),
                x: contextInfo.frameRect.x + rect.x + rect.width / 2,
                y: contextInfo.frameRect.y + rect.y + rect.height / 2,
                source: contextInfo.source
              };
            }
          }

          const closeControl = controls.find(el => {
            const signature = [
              textOf(el), el.className?.baseVal || el.className || '',
              el.getAttribute?.('data-icon') || ''
            ].join(' ');
            const rect = el.getBoundingClientRect();
            return rect.width <= 80 && rect.height <= 80 &&
              /关闭|close|icon-close|dialog-close|modal-close|boss-icon-close|iconfont.*close/i.test(signature);
          });
          if (closeControl) {
            const rect = closeControl.getBoundingClientRect();
            return {
              found: true,
              button_text: 'close_icon',
              reason: ${JSON.stringify(reason)},
              prompt_text: context.slice(0, 200),
              x: contextInfo.frameRect.x + rect.x + rect.width / 2,
              y: contextInfo.frameRect.y + rect.y + rect.height / 2,
              source: contextInfo.source
            };
          }
        }
      }
      return { found: false, reason: ${JSON.stringify(reason)} };
    })())`);
    const result = JSON.parse(raw);
    if (result.found) {
      await clickPagePoint(targetId, result.x, result.y, "recommend-prompt-close");
      closed.push({ ...result, closed: true });
      quietRounds = 0;
      await wait(500);
    } else {
      quietRounds += 1;
      await wait(250);
    }
  }

  return {
    closed: closed.length > 0,
    count: closed.length,
    reason,
    prompts: closed,
  };
}

async function countRecommendationPrompts(targetId) {
  return JSON.parse(await evalTarget(targetId, `JSON.stringify((() => {
    const docs = [document, ...[...document.querySelectorAll('iframe')].flatMap(frame => {
      try { return frame.contentDocument ? [frame.contentDocument] : []; } catch { return []; }
    })];
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width >= 180 && rect.height >= 80 &&
        style?.display !== 'none' && style?.visibility !== 'hidden' &&
        style?.opacity !== '0' &&
        (style?.position === 'fixed' || style?.position === 'absolute' || el.getAttribute('role') === 'dialog');
    };
    const selector = '[role="dialog"],[class*="dialog"],[class*="modal"],[class*="popup"],[class*="popover"],[class*="layer"],[class*="mask"],[class*="drawer"]';
    const promptPattern = /已发送招呼|招呼已发送|已打招呼|打招呼成功|为你推荐[\\s\\S]*相似|继续沟通|沟通成功/;
    const preferred = /^(不再显示|知道了|我知道了|暂不|取消|关闭)$/;
    const actionable = layer => {
      const text = (layer.innerText || layer.textContent || '').trim();
      if (promptPattern.test(text)) return true;
      return [...layer.querySelectorAll('button,a,[role="button"],[aria-label],[title],[class*="close"],[class*="Close"],i,svg')]
        .filter(el => {
          const rect = el.getBoundingClientRect?.();
          const style = el.ownerDocument.defaultView?.getComputedStyle(el);
          return rect && rect.width > 0 && rect.height > 0 &&
            style?.display !== 'none' && style?.visibility !== 'hidden';
        })
        .some(el => {
          const label = (
            el.innerText || el.textContent || el.getAttribute?.('aria-label') ||
            el.getAttribute?.('title') || ''
          ).trim();
          const signature = [
            label, el.className?.baseVal || el.className || '',
            el.getAttribute?.('data-icon') || ''
          ].join(' ');
          const rect = el.getBoundingClientRect();
          return preferred.test(label) ||
            (rect.width <= 80 && rect.height <= 80 &&
              /关闭|close|icon-close|dialog-close|modal-close|boss-icon-close|iconfont.*close/i.test(signature));
        });
    };
    const layers = docs.flatMap(doc => [...doc.querySelectorAll(selector)].filter(visible).filter(actionable));
    return {
      count: layers.length,
      samples: layers.slice(0, 8).map(el => ({
        text: (el.innerText || el.textContent || '').trim().slice(0, 240),
        className: String(el.className || '').slice(0, 180)
      }))
    };
  })())`));
}

async function confirmGreeting(targetId, marker) {
  await wait(1000);
  const raw = await evalTarget(targetId, `JSON.stringify((() => {
    const frame = document.querySelector('iframe[name=recommendFrame]');
    const doc = frame?.contentDocument || document;
    const docs = [document, ...(frame?.contentDocument ? [frame.contentDocument] : [])];
    const button = doc.querySelector('[data-recruit-dashboard-greet="${String(marker).replaceAll('"', '\\"')}"]');
    const card = button?.closest('li.card-item,.geek-card,.candidate-card,[class*="geek-card"],[class*="candidate-card"]');
    const text = card?.innerText || '';
    const body = docs.map(item => item.body?.innerText || '').join('\\n');
    const visible = el => {
      const rect = el.getBoundingClientRect?.();
      const style = el.ownerDocument.defaultView?.getComputedStyle(el);
      return rect && rect.width > 0 && rect.height > 0 &&
        style?.display !== 'none' && style?.visibility !== 'hidden';
    };
    const promptVisible = docs.flatMap(item => [...item.querySelectorAll('button,a,[role="button"],div,span')])
      .some(el => visible(el) && /^(不再显示|知道了|我知道了)$/.test((el.innerText || el.textContent || '').trim()) &&
        /已发送招呼|招呼已发送|已打招呼|为你推荐[\\s\\S]*相似的\\s*\\d*\\s*个?牛人/.test(
          (el.closest('[role="dialog"],[class*="dialog"],[class*="modal"],[class*="popup"],[class*="layer"],[class*="recommend"]')?.innerText || body)
        ));
    const stateChanged = !button || /继续沟通|已沟通|已联系/.test(text) ||
      !/打招呼|立即沟通/.test((button.innerText || button.textContent || '').trim());
    return {
      ok: stateChanged || promptVisible,
      prompt_visible: promptVisible,
      quota: /沟通次数已用完|暂无沟通次数|权益.*耗尽/.test(body),
      captcha: /验证码|安全验证|拖动滑块|行为验证/.test(body),
      warning: /操作(?:过于)?频繁|账号(?:存在)?异常|检测到异常操作|暂时无法沟通|访问受限|沟通功能受限|账号存在风险/.test(body)
    };
  })())`);
  return JSON.parse(raw);
}

function candidateId(card) {
  const jobKey = activeTask?.state?.options?.jobId || "unknown_job";
  if (card.data_id) return `boss_recommend:${card.data_id}:${jobKey}`;
  const hrefId = String(card.href || "").match(/(?:geek|uid|id)[=/]([^?&#/]+)/i)?.[1];
  if (hrefId) return `boss_recommend:${hrefId}:${jobKey}`;
  return `recommend:${crypto.createHash("sha256").update(`${jobKey}|${card.name}|${card.school}|${card.raw_text}`).digest("hex").slice(0, 20)}`;
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

function rememberDirectContact(candidate, legacyId) {
  appendJsonl(DIRECT_CONTACTED_FILE, {
    timestamp: now(),
    candidate_id: candidate.candidate_id,
    legacy_id: legacyId,
    candidate_name: candidate.name,
    candidate_school: candidate.school,
    source: "dashboard_recommend",
  });
}

function throwIfStopped() {
  if (pauseRequested) throw new Error("paused_by_user");
}

function checkSafety(data) {
  if (data.captcha) throw new Error("paused_captcha_detected");
  if (data.login) throw new Error("paused_boss_not_logged_in");
  if (data.warning) throw new Error(`paused_platform_warning${data.warning_reason ? `:${data.warning_reason.slice(0, 120)}` : ""}`);
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
    const stalePrompt = await closePostGreetingPrompt(targetId, "before_scan");
    if (stalePrompt.closed) updateState({}, "post_greet_prompt_closed");
    const health = await inspectPage(targetId);
    checkSafety(health);
    const data = await readCards(targetId, options.jobName);
    checkSafety(data);

    const rawCard = (data.cards || []).find((card) => card.name && !attempted.has(candidateId(card)));
    if (!rawCard) {
      if ((data.greet_control_count || 0) > 0 && (data.cards || []).length === 0) {
        appendJsonl(runLogFile(), {
          timestamp: now(),
          run_id: activeTask.state.run_id,
          event: "candidate_card_extraction_empty",
          visible_greet_controls: data.greet_control_count,
        });
      }
      if (scrollRounds >= 20) break;
      const moved = await scrollFeed(targetId);
      scrollRounds += 1;
      appendJsonl(runLogFile(), {
        timestamp: now(),
        run_id: activeTask.state.run_id,
        event: "candidate_feed_scroll",
        round: scrollRounds,
        ...moved,
      });
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

    const useLegacyDedupe = options.jobId === "ai_app_intern";
    if (activeTask.processed.has(id) || (useLegacyDedupe && activeTask.processed.has(legacyId))) {
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

    let sentConfirmed = false;
    try {
      await clickCard(targetId, rawCard);
      let confirmation = await confirmGreeting(targetId, rawCard.marker);
      checkSafety(confirmation);
      if (!confirmation.ok) {
        const fallback = await clickCardFallback(targetId, rawCard.marker);
        appendJsonl(runLogFile(), {
          timestamp: now(),
          run_id: activeTask.state.run_id,
          event: "greet_click_fallback",
          candidate_id: id,
          ...fallback,
        });
        if (fallback.clicked) confirmation = await confirmGreeting(targetId, rawCard.marker);
        checkSafety(confirmation);
      }
      if (!confirmation.ok) throw new Error("greet_no_state_change");
      activeTask.processed.add(id);
      if (useLegacyDedupe) activeTask.processed.add(legacyId);
      rememberDirectContact(candidate, legacyId);
      increment({ greeted: 1 });
      batchPassed += 1;
      logDecision(candidate, "greeted");
      sentConfirmed = true;

      const prompt = await closePostGreetingPrompt(targetId, "after_greet");
      if (prompt.closed) updateState({}, "post_greet_prompt_closed");
      const remainingPrompts = await countRecommendationPrompts(targetId);
      appendJsonl(runLogFile(), {
        timestamp: now(),
        run_id: activeTask.state.run_id,
        event: "post_greet_prompt_verify",
        candidate_id: id,
        closed_count: prompt.count,
        remaining: remainingPrompts,
      });
      if (remainingPrompts.count > 0) {
        throw new Error("paused_recommend_prompt_not_closed");
      }
      consecutiveFailures = 0;
      await wait(GREET_DELAY_MIN_MS + Math.random() * (GREET_DELAY_MAX_MS - GREET_DELAY_MIN_MS));
    } catch (error) {
      if (sentConfirmed) {
        if (/^paused_/.test(String(error.message || error))) throw error;
        throw new Error(`paused_post_greet_cleanup_failed:${String(error.message || error)}`);
      }
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
    const initialTarget = await findBossTarget();
    const recommendTarget = await gotoRecommend(initialTarget.targetId);
    const targetId = recommendTarget.targetId || initialTarget.targetId;
    checkSafety(await inspectPage(targetId));
    await selectRecommendJob(targetId, options);
    const initialPrompt = await closePostGreetingPrompt(targetId, "before_first_greet");
    const remainingInitialPrompts = await countRecommendationPrompts(targetId);
    if (initialPrompt.closed) updateState({}, "post_greet_prompt_closed");
    if (remainingInitialPrompts.count > 0) throw new Error("paused_recommend_prompt_not_closed");

    for (const batch of activeTask.state.batch_plan) {
      throwIfStopped();
      updateState({
        status: "running",
        current_batch: batch.number,
        remaining_batches: activeTask.state.batch_plan.length - batch.number,
      }, "batch_start");
      await runBatch(targetId, batch);
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
  const pipelineLock = lockInfo(PIPELINE_LOCK_DIR);
  const legacyLock = lockInfo(OLD_LOCK_DIR);
  add("runner_lock", ignoreActiveTask || !runnerLock.active || runnerLock.pid === process.pid,
    !runnerLock.active || runnerLock.pid === process.pid ? "推荐任务锁可用" : `run_lock_exists:${runnerLock.pid}`);
  add("legacy_pipeline_lock", !pipelineLock.active,
    !pipelineLock.active ? "旧链路任务锁可用" : `legacy_pipeline_active:${pipelineLock.pid}`);
  const legacyLockAvailable = !legacyLock.active || (ignoreActiveTask && legacyLock.pid === process.pid);
  add("legacy_boss_lock", legacyLockAvailable,
    legacyLockAvailable ? "Boss 页面操作锁可用" : `legacy_boss_run_active:${legacyLock.pid}`);
  try {
    const target = await findBossTarget();
    add("cdp", true, `${PROXY}, target=${target.targetId}`);
    const page = await inspectPage(target.targetId);
    add("boss_login", !page.login, page.login ? "paused_boss_not_logged_in" : "Boss 已登录");
    add("captcha", !page.captcha, page.captcha ? "paused_captcha_detected" : "未发现验证码");
    add("platform_warning", !page.warning,
      page.warning ? `paused_platform_warning:${page.warning_reason || "检测到明确的平台限制提示"}` : "未发现平台警告");
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
  const jobsConfig = loadJobsConfig(ROOT);
  const job = findJobByKey(jobsConfig, options.jobId);
  if (!job?.enabled) {
    const error = new Error("invalid_job_key");
    error.statusCode = 422;
    throw error;
  }
  options.jobName = job.display_name;
  options.jobAliases = job.boss_job_names;
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
