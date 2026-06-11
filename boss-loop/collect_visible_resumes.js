#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const {
  parseArgs,
  loadConfigOptions,
  makeClient,
  loadState,
  getCandidates,
  saveState,
  appendLog,
  now,
  pageHealth,
  acquireLock,
  releaseLock,
  ensureDir,
  sleepMs,
  fileHash,
  safeFilename,
  requestJson,
  COLLECT_STATUSES,
} = require("./lib/common");

const MODE = "collect-resumes";

function loadOptions() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfigOptions(args);
  if (!cfg.jobName) throw new Error("job_name is required. Pass --job-name or configure in default-config.yaml.");
  return {
    ...cfg,
    target: args.target || "",
    runId: args["run-id"] || `collect-${now().replace(/[:.]/g, "-")}`,
    selfCheck: !!args["self-check"],
    dryRun: !!args["dry-run"],
  };
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

function collectPriority(status) {
  if (status === "paused_send_failed") return -1;
  if (status === "attachment_received" || status === "download_failed" || status === "paused_download_failed") return 0;
  if (status === "attachment_sent_by_candidate") return 1;
  if (status === "resume_downloaded" || status === "sync_queue_failed") return 2;
  return 3;
}

function normalizeIdentityPart(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}

function candidateNameJobKey(candidate) {
  return `${normalizeIdentityPart(candidate?.name)}__${normalizeIdentityPart(candidate?.job_name)}`;
}

function hasCompletedResume(candidate) {
  if (!candidate) return false;
  if (hasUsableLocalResume(candidate)) return true;
  return ["resume_downloaded", "ready_for_hire_sync", "boss_completed"].includes(candidate.status);
}

function requestExpired(candidate, ttlDays, nowMs = Date.now()) {
  if (candidate?.status !== "attachment_requested") return false;
  const sentAt = Date.parse(candidate.message_sent_at || "");
  if (!Number.isFinite(sentAt)) return false;
  return nowMs - sentAt > Math.max(0, Number(ttlDays) || 0) * 86400000;
}

function getCollectTargets(candidates, maxCollect, jobName, ttlDays) {
  const values = Object.values(candidates);
  const completedKeys = new Set(
    values
      .filter(hasCompletedResume)
      .map(candidateNameJobKey)
      .filter((key) => !key.startsWith("__")),
  );
  const pool = Object.values(candidates).filter(c => {
    if (!c || !c.candidate_id || !c.name) return false;
    if (invalidCandidateName(c.name, jobName)) return false;
    if (!c.message_sent_at) return false;
    if (requestExpired(c, ttlDays)) return false;
    if (hasCompletedResume(c)) return false;
    if (completedKeys.has(candidateNameJobKey(c))) return false;
    return COLLECT_STATUSES.has(c.status);
  });
  pool.sort((a, b) => {
    const pa = collectPriority(a.status);
    const pb = collectPriority(b.status);
    if (pa !== pb) return pa - pb;
    const ta = String(a.message_sent_at || a.resume_downloaded_at || a.ready_for_hire_sync_at || "");
    const tb = String(b.message_sent_at || b.resume_downloaded_at || b.ready_for_hire_sync_at || "");
    return tb.localeCompare(ta);
  });
  return pool.slice(0, maxCollect).map(c => ({
    id: c.candidate_id,
    name: c.name,
    school: c.school || "",
    jobName: c.job_name || "",
    status: c.status,
    localResumePath: c.local_resume_path || null,
    resumeHash: c.resume_hash || null,
  }));
}

function removeCandidateFromState(state, candidateId) {
  if (Array.isArray(state)) {
    const index = state.findIndex((candidate) => candidate?.candidate_id === candidateId);
    if (index >= 0) state.splice(index, 1);
    return;
  }
  if (state?.candidates) delete state.candidates[candidateId];
}

function archiveExpiredCandidates(state, candidates, options) {
  const expired = Object.values(candidates).filter((candidate) =>
    candidate?.candidate_id &&
    requestExpired(candidate, options.collectRequestTtlDays),
  );
  if (!expired.length || options.dryRun || options.selfCheck) return expired;

  if (options.archiveFile) {
    ensureDir(path.dirname(options.archiveFile));
    for (const candidate of expired) {
      fs.appendFileSync(options.archiveFile, JSON.stringify({
        ...candidate,
        previous_status: candidate.status,
        status: "resume_request_expired",
        archive_reason: "resume_not_received_before_deadline",
        archived_at: now(),
      }) + "\n");
    }
  }

  for (const candidate of expired) {
    removeCandidateFromState(state, candidate.candidate_id);
    appendLog(options.logFile, options.runId, MODE, {
      candidate_id: candidate.candidate_id,
      action: "expire_resume_request",
      result: "archived",
      message_sent_at: candidate.message_sent_at,
      ttl_days: options.collectRequestTtlDays,
    });
  }
  saveState(options.stateFile, state, options.jobName);
  return expired;
}

function searchThreadByName(cdp, target, options) {
  let search = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    search = cdp.eval(`(() => {
      const name = ${JSON.stringify(target.name)};
      const actionId = 'thread-search-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      document.querySelectorAll('[data-boss-auto-search-id], [data-boss-auto-search-open-id]').forEach(el => {
        el.removeAttribute('data-boss-auto-search-id');
        el.removeAttribute('data-boss-auto-search-open-id');
      });
      const visible = el => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      };
      const textHint = el => [
        el.getAttribute?.('placeholder'),
        el.getAttribute?.('aria-label'),
        el.getAttribute?.('title'),
        el.className,
        el.parentElement?.className,
        el.parentElement?.innerText,
      ].filter(Boolean).join(' ');
      const inputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
        .filter(visible)
        .filter(el => !el.closest('.chat-conversation, [class*="editor"], [class*="input-box"]'))
        .filter(el => {
          const hint = textHint(el);
          const isNameSearch = el.matches?.('.search-input') || el.closest?.('.chat-top-search, .search-box') || /搜索姓名|姓名.{0,3}群聊|候选人|牛人/i.test(hint);
          if (isNameSearch) return true;
          return !el.closest('.chat-job-search, .chat-job, .job-select, [class*="job-select"], [class*="dropmenu"]');
        })
        .filter(el => {
          const r = el.getBoundingClientRect();
          const hint = textHint(el);
          return r.x >= 180 && r.x < 560 && r.y >= 90 && r.y < 230 && (/搜|搜索|查找|姓名|候选人|牛人|联系人|search/i.test(hint) || el.tagName === 'INPUT');
        })
        .sort((a, b) => {
          const ah = /搜|搜索|查找|search/i.test(textHint(a)) ? 0 : 1;
          const bh = /搜|搜索|查找|search/i.test(textHint(b)) ? 0 : 1;
          if (ah !== bh) return ah - bh;
          return a.getBoundingClientRect().y - b.getBoundingClientRect().y;
        });
      const input = inputs[0];
      if (!input) {
        const exactOpeners = Array.from(document.querySelectorAll('.chat-search-btn'));
        const fallbackOpeners = Array.from(document.querySelectorAll('[class*="search"]'))
          .filter(el => !el.classList?.contains('chat-job-search') && !el.closest('.chat-job-search, .chat-job, .job-select, [class*="job-select"], [class*="dropmenu"]'));
        const opener = [...exactOpeners, ...fallbackOpeners]
          .filter(visible)
          .filter(el => {
            const r = el.getBoundingClientRect();
            if (el.classList?.contains('chat-search-btn')) return r.x >= 160 && r.x < 700 && r.y >= 70 && r.y < 260;
            return r.x >= 180 && r.x < 700 && r.y >= 70 && r.y < 260;
          })
          .sort((a, b) => {
            const ae = a.classList?.contains('chat-search-btn') ? 0 : 1;
            const be = b.classList?.contains('chat-search-btn') ? 0 : 1;
            if (ae !== be) return ae - be;
            return b.getBoundingClientRect().x - a.getBoundingClientRect().x;
          })[0];
        if (opener) {
          opener.setAttribute('data-boss-auto-search-open-id', actionId);
          const r = opener.getBoundingClientRect();
          return { ok: false, reason: 'search_input_not_found', openSelector: '[data-boss-auto-search-open-id="' + actionId + '"]', openerClass: String(opener.className || '').slice(0, 80), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }
        return { ok: false, reason: 'search_input_not_found' };
      }
      input.setAttribute('data-boss-auto-search-id', actionId);
      input.focus();
      if (input.isContentEditable) {
        input.textContent = name;
      } else {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, name);
        else input.value = name;
      }
      input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: name }));
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: name }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      const r = input.getBoundingClientRect();
      return { ok: true, selector: '[data-boss-auto-search-id="' + actionId + '"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, hint: textHint(input).slice(0, 120) };
    })()`);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "search_thread", result: search.ok ? "input" : "failed", detail: search });
    if (search.ok) break;
    if (search.openSelector && attempt === 0) {
      cdp.clickAt(search.openSelector);
      sleepMs(800);
      continue;
    }
    break;
  }
  if (!search.ok) return { item: null, search };
  sleepMs(1200);

  const item = cdp.eval(`(() => {
    const name = ${JSON.stringify(target.name)};
    const school = ${JSON.stringify(target.school || "")};
    const jobName = ${JSON.stringify(target.jobName || "")};
    const actionId = 'thread-result-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-thread-result-id]').forEach(el => el.removeAttribute('data-boss-auto-thread-result-id'));
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const input = document.querySelector('[data-boss-auto-search-id]') || document.querySelector('.chat-top-search input, .search-box input, .search-input');
    const inputRect = input?.getBoundingClientRect?.();
    const textOf = el => (el.innerText || el.textContent || '').trim();
    const contactNodes = inputRect ? Array.from(document.querySelectorAll('div, a, li, [role="button"]'))
      .filter(visible)
      .filter(el => !el.closest('.geek-item'))
      .map(el => ({ el, text: textOf(el), rect: el.getBoundingClientRect() }))
      .filter(v => v.text.includes(name))
      .filter(v => v.rect.x >= inputRect.x - 40 && v.rect.x < inputRect.x + inputRect.width + 80)
      .filter(v => v.rect.y > inputRect.bottom && v.rect.y < inputRect.bottom + 280)
      .filter(v => v.rect.width >= 120 && v.rect.height >= 32)
      .filter(v => v.rect.height <= 180)
      .sort((a, b) => {
        const as = school && a.text.includes(school) ? 0 : jobName && a.text.includes(jobName) ? 1 : 2;
        const bs = school && b.text.includes(school) ? 0 : jobName && b.text.includes(jobName) ? 1 : 2;
        if (as !== bs) return as - bs;
        const aa = a.rect.width * a.rect.height;
        const ba = b.rect.width * b.rect.height;
        return aa - ba;
      }) : [];
    const contact = contactNodes[0];
    if (contact) {
      contact.el.setAttribute('data-boss-auto-thread-result-id', actionId);
      const r = contact.el.getBoundingClientRect();
      return { ok: true, source: 'search_contact_result', selector: '[data-boss-auto-thread-result-id="' + actionId + '"]', id: contact.el.id || '', text: contact.text.slice(0, 240), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    }
    const items = Array.from(document.querySelectorAll('.geek-item')).filter(visible);
    const matches = items.map((el, idx) => ({ el, idx, text: (el.innerText || el.textContent || '').trim() }))
      .filter(v => v.text.includes(name))
      .sort((a, b) => {
        const as = school && a.text.includes(school) ? 0 : jobName && a.text.includes(jobName) ? 1 : 2;
        const bs = school && b.text.includes(school) ? 0 : jobName && b.text.includes(jobName) ? 1 : 2;
        return as - bs;
      });
    const match = matches[0];
    if (!match) return { ok: false, reason: 'search_result_not_found', visible: items.slice(0, 12).map(el => (el.innerText || el.textContent || '').trim().slice(0, 100)) };
    match.el.setAttribute('data-boss-auto-thread-result-id', actionId);
    const r = match.el.getBoundingClientRect();
    return { ok: true, source: 'chat_list_item', selector: '[data-boss-auto-thread-result-id="' + actionId + '"]', id: match.el.id || '', text: match.text.slice(0, 240), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
  appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "search_thread_result", result: item.ok ? "found" : "not_found", detail: item });
  return item.ok ? { item, search } : { item: null, search, result: item };
}

function probeAttachment(cdp, name) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const conv = document.querySelector('.chat-conversation');
    const text = (conv?.innerText || '').trim();
    const identity = text.includes(name);
    const hasRequest = /对方想发送附件简历给您，您是否同意/.test(text);
    const hasPreview = /点击预览附件简历|附件简历\.(pdf|doc|docx)|简历\.pdf|简历\.doc|简历\.docx/.test(text);
    const acceptBtns = Array.from((conv || document).querySelectorAll('button, a, div, span'))
      .filter(el => /^同意$|^接收$/.test((el.innerText || el.textContent || '').trim()) && !String(el.className).includes('disabled'));
    const previewBtns = Array.from((conv || document).querySelectorAll('button, a, div, span'))
      .filter(el => /点击预览附件简历|预览简历/.test((el.innerText || el.textContent || '').trim()));
    return {
      identity,
      text: text.slice(0, 900),
      hasRequest,
      hasPreview,
      acceptCount: acceptBtns.length,
      acceptSelector: acceptBtns[0] ? acceptBtns[0].id ? '#' + CSS.escape(acceptBtns[0].id) : '' : '',
      previewSelector: previewBtns[0] ? previewBtns[0].id ? '#' + CSS.escape(previewBtns[0].id) : '' : '',
    };
  })()`);
}

function threadIdentityStillMatches(cdp, name) {
  return cdp.eval(`(() => {
    const name = ${JSON.stringify(name)};
    const visibleText = el => (el?.innerText || el?.textContent || '').trim();
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const selected = Array.from(document.querySelectorAll('.geek-item.selected, .geek-item.active, [class*="selected"], [class*="active"]'))
      .filter(visible)
      .map(visibleText)
      .find(t => t.includes(name));
    const conv = document.querySelector('.chat-conversation');
    const convHasName = !!conv && visibleText(conv).includes(name);
    const minRightX = Math.max(480, Math.floor(window.innerWidth * 0.35));
    const header = Array.from(document.querySelectorAll('[class*="header"], [class*="title"], [class*="name"]'))
      .filter(visible)
      .filter(el => !el.closest('.geek-item'))
      .filter(el => {
        const r = el.getBoundingClientRect();
        return r.x >= minRightX || !!el.closest('.chat-container-private, [class*="conversation"], [class*="message"]');
      })
      .map(visibleText)
      .find(t => t.includes(name));
    return { ok: !!(header || convHasName), selected: !!selected, header: !!header, convHasName, hasConversation: !!conv };
  })()`);
}

function waitForCandidateThread(cdp, target, options) {
  if (options.dryRun) {
    return { ok: true, dryRun: true, probe: { identity: true, hasRequest: false, hasPreview: false, acceptCount: 0 } };
  }
  let last = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    sleepMs(450);
    const probe = probeAttachment(cdp, target.name);
    const identity = probe.identity ? { ok: true, conversation: true } : threadIdentityStillMatches(cdp, target.name);
    last = { attempt, probe, identity };
    appendLog(options.logFile, options.runId, MODE, {
      candidate_id: target.id,
      action: "thread_switch_check",
      result: identity.ok ? "ok" : "retry",
      attempt,
      detail: identity,
    });
    if (identity.ok) return { ok: true, probe, identity, attempts: attempt };
  }
  return { ok: false, ...last };
}

function clickFirstAccept(cdp) {
  return cdp.eval(`(() => {
    const conv = document.querySelector('.chat-conversation');
    const btns = Array.from((conv || document).querySelectorAll('button, a, div, span'))
      .filter(el => /^同意$|^接收$/.test((el.innerText || el.textContent || '').trim()) && !String(el.className).includes('disabled'));
    if (!btns.length) return { ok: false, reason: 'no_accept_button' };
    const btn = btns[0];
    btn.scrollIntoView({ block: 'center' });
    btn.setAttribute('data-boss-auto-action', 'accept-resume');
    const r = btn.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-action="accept-resume"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
}

function clickPreview(cdp) {
  return cdp.eval(`(() => {
    const conv = document.querySelector('.chat-conversation');
    const root = conv || document;
    const actionId = 'preview-resume-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    document.querySelectorAll('[data-boss-auto-action="preview-resume"], [data-boss-auto-action-id]').forEach(el => {
      el.removeAttribute('data-boss-auto-action');
      el.removeAttribute('data-boss-auto-action-id');
    });
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const textOf = el => (el.innerText || el.textContent || '').trim();
    const nodes = Array.from(root.querySelectorAll('button, a, div, span, p, i, [role="button"]')).filter(visible);
    const byLatestVisiblePosition = (a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      if (Math.abs(br.y - ar.y) > 4) return br.y - ar.y;
      if (Math.abs(br.x - ar.x) > 4) return br.x - ar.x;
      return nodes.indexOf(b) - nodes.indexOf(a);
    };
    const exact = nodes
      .filter(el => textOf(el) === '点击预览附件简历')
      .sort(byLatestVisiblePosition)[0];
    const fileNode = !exact ? nodes
      .filter(el => /^.{1,120}\\.(pdf|doc|docx)$/i.test(textOf(el)))
      .sort(byLatestVisiblePosition)[0] : null;
    const leaf = exact || fileNode;
    if (!leaf) return { ok: false, reason: 'no_precise_preview_node', sample: nodes.slice(-20).map(el => textOf(el).slice(0, 60)).filter(Boolean) };
    let btn = leaf;
    for (let p = leaf; p && p !== root; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      const role = p.getAttribute?.('role') || '';
      const cls = String(p.className || '');
      const tag = p.tagName;
      const clickable = /^(BUTTON|A)$/i.test(tag) || role === 'button' || /file|resume|attachment|preview|card|message|bubble/i.test(cls) || p.onclick;
      if (clickable && r.width > 0 && r.height > 0 && r.width < 420 && r.height < 180) {
        btn = p;
        break;
      }
    }
    btn.scrollIntoView({ block: 'center' });
    btn.setAttribute('data-boss-auto-action', 'preview-resume');
    btn.setAttribute('data-boss-auto-action-id', actionId);
    const r = btn.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-action-id="' + actionId + '"]', leafText: textOf(leaf), targetText: textOf(btn).slice(0, 120), rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
  })()`);
}

function scrollConversationToBottom(cdp) {
  return cdp.eval(`(() => {
    const conv = document.querySelector('.chat-conversation');
    const candidates = [conv, conv?.parentElement, document.querySelector('[class*="message-list"], [class*="conversation"], [class*="scroll"]'), document.scrollingElement].filter(Boolean);
    const target = candidates.find(el => el.scrollHeight > el.clientHeight + 20) || conv || document.scrollingElement;
    if (!target) return { ok: false, reason: 'no_conversation_scroll_target' };
    const beforeTop = target.scrollTop || 0;
    target.scrollTop = target.scrollHeight;
    return { ok: true, beforeTop, afterTop: target.scrollTop, scrollHeight: target.scrollHeight, clientHeight: target.clientHeight };
  })()`);
}

function closeOpenPreviews(cdp, options, candidateId = "") {
  if (options?.dryRun) return { ok: true, closed: false, reason: "dry_run" };
  const attempts = [];
  const readState = () => cdp.eval(`(() => {
    const layers = Array.from(document.querySelectorAll('.dialog-wrap.active, .boss-dialog__wrapper.resume-common-dialog, .resume-common-dialog.search-resume, .resume-common-wrap, .new-resume-online-main-ui, [class*="preview"], [class*="Preview"], [class*="viewer"], [class*="Viewer"]'))
      .filter(el => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const text = (el.innerText || el.textContent || '').trim();
        return /下载|附件简历|简历|pdf|doc|预览/i.test(text) || !!el.querySelector?.('.attachment-resume-btns, iframe, [class*="download"], [class*="Download"]');
      });
    return { open: layers.length > 0, count: layers.length, text: layers.map(el => (el.innerText || el.textContent || '').trim().slice(0, 180)).filter(Boolean).slice(0, 3) };
  })()`);
  for (let i = 0; i < 4; i++) {
    const before = readState();
    attempts.push({ step: "read", round: i + 1, state: before });
    if (!before.open) {
      const result = { ok: true, closed: i > 0, attempts };
      if (i > 0) appendLog(options.logFile, options.runId, MODE, { candidate_id: candidateId, action: "close_stale_preview", result: "ok", detail: result });
      return result;
    }
    const close = cdp.eval(`(() => {
      const visible = el => {
        const r = el.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      };
      const label = el => [
        el.innerText,
        el.textContent,
        el.getAttribute?.('title'),
        el.getAttribute?.('aria-label'),
        el.className,
        el.id,
      ].filter(Boolean).join(' ');
      const roots = Array.from(document.querySelectorAll('.dialog-wrap.active, .boss-dialog__wrapper, .resume-common-dialog, .resume-common-wrap, .new-resume-online-main-ui, [class*="preview"], [class*="Preview"], [class*="viewer"], [class*="Viewer"]'));
      const nodes = roots.flatMap(root => Array.from(root.querySelectorAll('button, a, i, span, div, svg, [role="button"], [class*="close"], [class*="Close"], [title], [aria-label]')));
      const btn = nodes
        .filter(visible)
        .filter(el => /关闭|close|取消|×|x/i.test(label(el)))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const ac = /close|Close|dialog-close|preview-close/i.test(String(a.className || '')) ? 0 : 1;
          const bc = /close|Close|dialog-close|preview-close/i.test(String(b.className || '')) ? 0 : 1;
          if (ac !== bc) return ac - bc;
          return (ar.width * ar.height) - (br.width * br.height);
        })[0];
      if (btn) {
        btn.click();
        return { ok: true, method: 'close_button' };
      }
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      return { ok: true, method: 'escape_key' };
    })()`);
    attempts.push({ step: "close", round: i + 1, result: close });
    sleepMs(350);
  }
  const finalState = readState();
  const result = { ok: !finalState.open, closed: !finalState.open, reason: finalState.open ? "preview_still_open" : "", finalState, attempts };
  appendLog(options.logFile, options.runId, MODE, { candidate_id: candidateId, action: "close_stale_preview", result: result.ok ? "ok" : "failed", detail: result });
  return result;
}

function ensurePreviewOpen(cdp, options) {
  const readPreviewState = () => cdp.eval(`(() => {
      const text = document.body.innerText || '';
      const activeDialog = document.querySelector('.dialog-wrap.active, .boss-dialog__wrapper.resume-common-dialog, .resume-common-dialog.search-resume, .resume-common-wrap, .new-resume-online-main-ui');
      const hasToolbarDownload = !!Array.from(document.querySelectorAll('.attachment-resume-btns *, .resume-footer-wrap *, .dialog-wrap.active *, .boss-dialog__wrapper *'))
        .find(el => {
          const r = el.getBoundingClientRect?.();
          if (!r || r.width <= 0 || r.height <= 0) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          const t = (el.innerText || el.textContent || el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '').trim();
          return t === '下载' || /download/i.test(String(el.className || ''));
        });
      const hasPreviewLayer = !!activeDialog || (hasToolbarDownload && /下载/.test(text) && (/附件简历|简历|pdf|doc/i.test(text) || !!document.querySelector('iframe, [class*="preview"], [class*="Preview"], [class*="viewer"], [class*="Viewer"]')));
      const conv = document.querySelector('.chat-conversation');
      const hasPreviewButton = !!Array.from((conv || document).querySelectorAll('button, a, div, span, [class*="file"], [class*="resume"], [class*="attachment"]'))
        .find(el => {
          const t = (el.innerText || el.textContent || '').trim();
          return t === '点击预览附件简历' || /^.{1,120}\\.(pdf|doc|docx)$/i.test(t);
        });
      return { hasPreviewLayer, hasPreviewButton, hasToolbarDownload, activeDialog: !!activeDialog, text: text.slice(0, 500) };
    })()`);
  const stale = readPreviewState();
  if (stale.hasPreviewLayer) {
    const closed = closeOpenPreviews(cdp, options);
    if (!closed.ok) return { ok: false, reason: 'stale_preview_close_failed', state: stale, close: closed };
    sleepMs(500);
  }
  for (let i = 0; i < 10; i++) {
    const state = readPreviewState();
    if (state.hasPreviewLayer) {
      const closed = closeOpenPreviews(cdp, options);
      if (!closed.ok) return { ok: false, reason: 'stale_preview_close_failed', state, close: closed };
      sleepMs(500);
      continue;
    }
    if (!state.hasPreviewButton) {
      scrollConversationToBottom(cdp);
      sleepMs(700);
      continue;
    }
    scrollConversationToBottom(cdp);
    sleepMs(250);
    const preview = clickPreview(cdp);
    appendLog(options.logFile, options.runId, MODE, { action: "open_preview", result: preview.ok ? "clicked" : "failed", detail: preview });
    if (preview.ok && preview.selector) {
      cdp.clickAt(preview.selector);
      sleepMs(1600);
      const afterClickState = readPreviewState();
      if (afterClickState.hasPreviewLayer) return { ok: true, alreadyOpen: false, state: afterClickState };
    } else {
      return { ok: false, reason: preview.reason || 'preview_click_failed', state };
    }
  }
  const finalState = readPreviewState();
  if (finalState.hasPreviewLayer) return { ok: true, alreadyOpen: false, state: finalState };
  return { ok: false, reason: 'preview_open_timeout', state: finalState };
}

function clickDownloadInPreview(cdp) {
  return cdp.eval(`(() => {
    document.querySelectorAll('[data-boss-auto-action="download-resume"], [data-boss-auto-download-id]').forEach(el => {
      el.removeAttribute('data-boss-auto-action');
      el.removeAttribute('data-boss-auto-download-id');
    });
    const actionId = 'download-resume-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
    const docs = [document];
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch (_) {}
    }
    const all = [];
    const walk = root => {
      if (!root) return;
      const nodes = root.querySelectorAll ? Array.from(root.querySelectorAll('button, a, div, span, i, svg, [role="button"], [class*="download"], [class*="Download"], [title], [aria-label]')) : [];
      for (const node of nodes) {
        all.push(node);
        if (node.shadowRoot) walk(node.shadowRoot);
      }
    };
    docs.forEach(walk);
    const visible = el => {
      const r = el.getBoundingClientRect?.();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const label = el => [
      el.innerText,
      el.textContent,
      el.getAttribute?.('title'),
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('data-title'),
      el.className,
      el.id,
    ].filter(Boolean).join(' ');
    const previewText = (document.body.innerText || '').slice(0, 1200);
    const inActivePreview = el => !!el.closest?.('.dialog-wrap.active, .boss-dialog__wrapper, .resume-common-dialog, .search-resume, [class*="preview"], [class*="Preview"], [class*="viewer"], [class*="Viewer"]');
    const candidates = all
      .filter(visible)
      .filter(el => /下载|download|down-load/i.test(label(el)))
      .map(el => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || '').trim();
        const cls = String(el.className || '');
        const exactLabel = text === '下载' ||
          /^(下载|download)$/i.test(String(el.getAttribute?.('title') || el.getAttribute?.('aria-label') || '').trim());
        const downloadClass = /(?:^|[\\s_-])(download|down-load)(?:$|[\\s_-])/i.test(cls);
        const compactControl = r.width <= 120 && r.height <= 80;
        const containsMorePreciseControl = [...el.querySelectorAll?.(
          'button,a,[role="button"],[title],[aria-label],[class*="download"],[class*="Download"]'
        ) || []].some(child => {
          const cr = child.getBoundingClientRect?.();
          if (!cr || cr.width <= 0 || cr.height <= 0 || cr.width > 120 || cr.height > 80) return false;
          const childText = (child.innerText || child.textContent || '').trim();
          const childLabel = [
            child.getAttribute?.('title'),
            child.getAttribute?.('aria-label'),
            child.className,
          ].filter(Boolean).join(' ');
          return childText === '下载' || /download|down-load/i.test(childLabel);
        });
        if (!compactControl || containsMorePreciseControl || (!exactLabel && !downloadClass)) return null;
        const score =
          (text === '下载' ? 0 : 20) +
          (/icon-content|download|toolbar|attachment-resume-btns/i.test(cls) ? 0 : 10) +
          (inActivePreview(el) ? 0 : 30) +
          (r.width <= 80 && r.height <= 60 ? 0 : 20) +
          (r.y <= 80 ? 0 : 10) +
          (r.width * r.height) / 10000;
        return { el, r, text, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score);
    const btn = candidates[0]?.el;
    if (!btn) {
      return {
        ok: false,
        reason: /正在加载简历|请稍等/.test(previewText) ? 'download_button_not_ready' : 'no_download_button',
        previewText,
        candidates: all.filter(visible).slice(0, 30).map(el => label(el).slice(0, 80))
      };
    }
    btn.setAttribute('data-boss-auto-action', 'download-resume');
    btn.setAttribute('data-boss-auto-download-id', actionId);
    const r = btn.getBoundingClientRect();
    return { ok: true, selector: '[data-boss-auto-download-id="' + actionId + '"]', text: label(btn).slice(0, 120), rect: { x: r.x, y: r.y, width: r.width, height: r.height }, score: candidates[0]?.score };
  })()`);
}

function closePreview(cdp) {
  return cdp.eval(`(() => {
    const closeBtn = document.querySelector('.preview-close, [class*="close"], [class*="Close"], .dialog-close, .modal-close');
    if (closeBtn) {
      closeBtn.click();
      return { ok: true, method: 'close_button' };
    }
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true });
    document.dispatchEvent(escEvent);
    return { ok: true, method: 'escape_key' };
  })()`);
}

function setDownloadDir(proxy, target, dir) {
  try {
    const info = requestJson("GET", `${proxy}/info?target=${target}`);
    const browserContextId = info.browserContextId;
    if (!browserContextId) return { ok: false, reason: "no_browser_context_id" };
    const body = JSON.stringify({ method: "Browser.setDownloadBehavior", params: { behavior: "allow", downloadPath: dir, browserContextId } });
    requestJson("POST", `${proxy}/cdp?target=${target}`, body);
    return { ok: true, method: "Browser.setDownloadBehavior" };
  } catch (e) {
    try {
      const body2 = JSON.stringify({ method: "Page.setDownloadBehavior", params: { behavior: "allow", downloadPath: dir } });
      requestJson("POST", `${proxy}/cdp?target=${target}`, body2);
      return { ok: true, method: "Page.setDownloadBehavior" };
    } catch (e2) {
      return { ok: false, reason: "cdp_set_download_behavior_failed" };
    }
  }
}

function dirSnapshot(dir) {
  if (!fs.existsSync(dir)) return new Map();
  const map = new Map();
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    const st = fs.statSync(fp);
    map.set(fp, { mtime: st.mtimeMs, size: st.size });
  }
  return map;
}

function findNewDownload(dir, beforeSnapshot, afterTime, pollIntervalMs, maxWaitSeconds) {
  const deadline = Date.now() + maxWaitSeconds * 1000;
  let lastCandidates = new Map();
  while (Date.now() < deadline) {
    const candidates = [];
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (/\.(crdownload|tmp|part)$/i.test(f)) continue;
        const fp = path.join(dir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs < afterTime - 2000) continue;
        if (beforeSnapshot.has(fp) && beforeSnapshot.get(fp).mtime === st.mtimeMs && beforeSnapshot.get(fp).size === st.size) continue;
        candidates.push({ path: fp, size: st.size, mtime: st.mtimeMs });
      }
    }
    const stable = candidates.filter(c => {
      const prev = lastCandidates.get(c.path);
      return prev && prev.size === c.size && prev.mtime === c.mtime;
    });
    if (stable.length > 0) {
      stable.sort((a, b) => b.mtime - a.mtime);
      return { ok: true, filePath: stable[0].path, size: stable[0].size };
    }
    for (const c of candidates) lastCandidates.set(c.path, c);
    sleepMs(pollIntervalMs);
  }
  return { ok: false, reason: "download_timeout" };
}

function makeResumeFilename(jobName, name, school, ext, originalFilename) {
  // 如果有原始文件名，直接使用BOSS下载的默认文件名
  if (originalFilename) {
    return originalFilename;
  }
  // 否则使用简单的命名格式
  const j = safeFilename(jobName);
  const n = safeFilename(name);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${j}_${n}_${date}.${ext}`;
}

function resolveUniquePath(dir, filename) {
  let fp = path.join(dir, filename);
  if (!fs.existsSync(fp)) return fp;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let idx = 1;
  while (idx < 1000) {
    fp = path.join(dir, `${base}_${idx}${ext}`);
    if (!fs.existsSync(fp)) return fp;
    idx++;
  }
  const hash = Math.random().toString(36).slice(2, 6);
  return path.join(dir, `${base}_${hash}${ext}`);
}

function findExistingResumeByHash(candidates, candidateId, hash) {
  if (!hash) return null;
  const sameCandidate = candidates[candidateId];
  if (sameCandidate?.resume_hash === hash && sameCandidate.local_resume_path && fs.existsSync(sameCandidate.local_resume_path)) {
    return { candidate_id: candidateId, local_resume_path: sameCandidate.local_resume_path, scope: "same_candidate" };
  }
  for (const c of Object.values(candidates)) {
    if (!c || c.candidate_id === candidateId) continue;
    if (c.resume_hash === hash && c.local_resume_path && fs.existsSync(c.local_resume_path)) {
      return { candidate_id: c.candidate_id, local_resume_path: c.local_resume_path, scope: "other_candidate_same_hash" };
    }
  }
  return null;
}

function hasUsableLocalResume(candidate) {
  return !!(
    candidate &&
    candidate.local_resume_path &&
    candidate.resume_hash &&
    fs.existsSync(candidate.local_resume_path)
  );
}

function syncQueueRecordExists(options, candidateId, hash, localPath) {
  if (!options.syncQueueFile || !fs.existsSync(options.syncQueueFile)) return false;
  try {
    const resolvedPath = localPath ? path.resolve(localPath) : "";
    const lines = fs.readFileSync(options.syncQueueFile, "utf8").split(/\r?\n/).filter(Boolean);
    return lines.some(line => {
      try {
        const record = JSON.parse(line);
        if (record.candidate_id !== candidateId) return false;
        if (hash && record.resume_hash === hash) return true;
        return !!(resolvedPath && record.local_resume_path && path.resolve(record.local_resume_path) === resolvedPath);
      } catch (_) {
        return false;
      }
    });
  } catch (_) {
    return false;
  }
}

function confirmReplyAlreadySent(cdp, options) {
  if (options.dryRun) return { ok: false, dryRun: true };
  return cdp.eval(`(() => {
    const message = ${JSON.stringify(options.confirmReceivedMessage)};
    const conv = document.querySelector('.chat-conversation');
    const text = (conv?.innerText || '').trim();
    return { ok: !!message && text.includes(message), textTail: text.slice(-500) };
  })()`);
}

function ensureChatPage(cdp) {
  let health = pageHealth(cdp);
  if (health.loginExpired || health.captcha || health.hasChatList) return health;

  try {
    cdp.navigate("https://www.zhipin.com/web/chat/index");
  } catch (_) {}

  for (let attempt = 0; attempt < 3; attempt++) {
    sleepMs(1200);
    health = pageHealth(cdp);
    if (health.loginExpired || health.captcha || health.hasChatList) break;
  }
  return health;
}

function main() {
  const options = loadOptions();
  if (options.selfCheck) {
    _main(options);
    return;
  }

  ensureDir(options.lockDir ? path.dirname(options.lockDir) : null);

  if (!acquireLock(options.lockDir, options.lockTtlMinutes, MODE)) {
    console.log(JSON.stringify({ status: "skipped", reason: "lock_exists", mode: MODE }));
    process.exit(0);
  }

  try {
    _main(options);
  } finally {
    releaseLock(options.lockDir);
  }
}

function _main(options) {
  const state = loadState(options.stateFile);
  const candidates = getCandidates(state);
  const expired = archiveExpiredCandidates(state, candidates, options);
  const activeCandidates = getCandidates(state);
  const targets = getCollectTargets(
    activeCandidates,
    options.maxCollectPerRun,
    options.jobName,
    options.collectRequestTtlDays,
  );

  if (options.selfCheck) {
    console.log(JSON.stringify({
      status: "ok",
      script: "collect_visible_resumes",
      job_name: options.jobName,
      collect_targets: targets.length,
      expired_targets: expired.length,
      dry_run_supported: true,
    }));
    return;
  }

  const cdp = makeClient({ proxy: options.proxy, target: options.target });
  const health = ensureChatPage(cdp);
  if (health.loginExpired || health.captcha || !health.hasChatList) {
    const reason = health.captcha
      ? "paused_captcha_detected"
      : health.loginExpired
        ? "paused_login_required"
        : "paused_chat_page_unavailable";
    console.log(JSON.stringify({
      status: "paused",
      reason,
      mode: MODE,
      target: cdp.target,
      url: health.url || "",
      title: health.title || "",
    }));
    return;
  }

  ensureDir(options.resumeDownloadDir);
  let downloadDirSet = false;
  if (!options.dryRun) {
    const dirResult = setDownloadDir(options.proxy, cdp.target, options.resumeDownloadDir);
    downloadDirSet = dirResult.ok;
    if (!dirResult.ok) {
      appendLog(options.logFile, options.runId, MODE, { action: "set_download_dir", result: "failed", error: dirResult.reason });
    }
  }

  let scanned = 0;
  let received = 0;
  let downloaded = 0;
  let queued = 0;
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  let pausedReason = null;
  let healthCounter = 0;
  let batch = [];
  let lastDuplicateOtherHash = "";
  let consecutiveDuplicateOtherHash = 0;
  let consecutiveDownloadFailures = 0;

  for (const target of targets) {
    if (pausedReason) break;

    if (!options.dryRun) {
      const closed = closeOpenPreviews(cdp, options, target.id);
      if (!closed.ok) {
        candidates[target.id] = {
          ...(candidates[target.id] || {}),
          last_observation: "stale_preview_close_failed",
          last_error: closed.reason || "stale_preview_close_failed",
        };
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "close_stale_preview", result: "failed", detail: closed });
        failed++;
        pausedReason = "paused_stale_preview_close_failed";
        batch.push(target.id);
        break;
      }
    }

    if (healthCounter >= options.healthCheckEveryCandidates) {
      healthCounter = 0;
      const h = pageHealth(cdp);
      if (h.captcha) { pausedReason = "paused_captcha_detected"; break; }
      if (h.loginExpired) { pausedReason = "paused_login_required"; break; }
    }

    const found = searchThreadByName(cdp, target, options);
    const item = found.item;
    if (!item) {
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "open_thread", result: "skipped", error_code: "candidate_not_found_by_search", detail: found.result || found.search || null });
      skipped++;
      continue;
    }

    if (!options.dryRun) {
      cdp.eval(`(() => {
        const el = document.querySelector(${JSON.stringify(item.selector)});
        if (el) el.scrollIntoView({ block: 'center', inline: 'nearest' });
        return { ok: !!el };
      })()`);
      sleepMs(300);
      cdp.clickAt(item.selector);
      sleepMs(1200 + Math.floor(Math.random() * 400));
    }

    const switched = waitForCandidateThread(cdp, target, options);
    const probe = switched.probe;

    scanned++;
    healthCounter++;

    if (!switched.ok) {
      candidates[target.id] = { ...(candidates[target.id] || {}), status: "paused_thread_switch_failed", last_observation: "candidate_thread_switch_failed", last_error: "candidate_thread_switch_failed" };
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "identity_check", result: "failed", detail: switched });
      failed++;
      pausedReason = "paused_thread_switch_failed";
      batch.push(target.id);
      break;
    }

    const c = candidates[target.id] || {};

    if (hasUsableLocalResume(c) && ["resume_downloaded", "ready_for_hire_sync", "sync_queue_failed", "paused_send_failed"].includes(c.status)) {
      if (c.status === "resume_downloaded" || c.status === "sync_queue_failed" || !syncQueueRecordExists(options, target.id, c.resume_hash, c.local_resume_path)) {
        const queueResult = writeSyncQueue(options, target.id, c.name, c.school, c.local_resume_path, c.resume_hash);
        if (queueResult.ok) {
          candidates[target.id] = {
            ...c,
            status: c.status === "paused_send_failed" ? "paused_send_failed" : "ready_for_hire_sync",
            sync_queue_status: "pending",
            ready_for_hire_sync_at: c.ready_for_hire_sync_at || now(),
            last_observation: queueResult.alreadyExists ? "sync_queue_already_written" : "sync_queue_written",
          };
          if (!queueResult.alreadyExists) queued++;
          batch.push(target.id);
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: queueResult.alreadyExists ? "already_exists" : "ok" });
          saveState(options.stateFile, state, options.jobName);
          batch = [];
        } else {
          candidates[target.id] = { ...c, status: "sync_queue_failed", last_observation: "sync_queue_write_failed", last_error: queueResult.reason || "sync_queue_write_failed" };
          failed++;
          pausedReason = "paused_sync_queue_write_failed";
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: "failed", detail: queueResult });
          break;
        }
      }

      const current = candidates[target.id] || c;
      const alreadyMarked = !!(current.boss_completed_at || current.confirm_received_sent_at || current.status === "boss_completed");
      const alreadyInThread = alreadyMarked ? { ok: true, state: true } : confirmReplyAlreadySent(cdp, options);
      if (alreadyInThread.ok) {
        candidates[target.id] = {
          ...current,
          status: "boss_completed",
          boss_completed_at: current.boss_completed_at || now(),
          confirm_received_sent_at: current.confirm_received_sent_at || now(),
          last_observation: alreadyMarked ? "confirm_reply_already_marked" : "confirm_reply_already_in_thread",
        };
        if (!alreadyMarked) completed++;
        batch.push(target.id);
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: alreadyMarked ? "already_marked" : "already_sent" });
        saveState(options.stateFile, state, options.jobName);
        batch = [];
      } else {
        const replyResult = options.dryRun ? { ok: true, dryRun: true } : sendConfirmReply(cdp, options);
        if (replyResult.ok) {
          candidates[target.id] = { ...current, status: "boss_completed", boss_completed_at: now(), confirm_received_sent_at: now(), last_observation: "boss_completed" };
          completed++;
          batch.push(target.id);
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "ok", detail: replyResult });
          saveState(options.stateFile, state, options.jobName);
          batch = [];
        } else {
          candidates[target.id] = { ...current, status: "paused_send_failed", last_observation: "confirm_reply_failed", last_error: replyResult.reason || "confirm_reply_failed" };
          failed++;
          pausedReason = "paused_send_failed";
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "failed", detail: replyResult });
          break;
        }
      }
      continue;
    }

    if (!probe.hasRequest && !probe.hasPreview && !probe.acceptCount) {
      candidates[target.id] = { ...c, last_observation: "no_attachment_yet", history: [...(c.history || []), { at: now(), run_id: options.runId, action: "collect_probe", result: "no_attachment_yet" }] };
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "collect_probe", result: "no_attachment_yet" });
      skipped++;
      continue;
    }

    received++;

    if (options.dryRun) {
      candidates[target.id] = { ...c, status: "attachment_received", last_observation: "dry_run_attachment_detected" };
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "collect", result: "dry_run" });
      continue;
    }

    if (probe.acceptCount > 0) {
      const accept = clickFirstAccept(cdp);
      if (accept.ok && accept.selector) {
        cdp.clickAt(accept.selector);
        sleepMs(1000);
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "accept_attachment", result: "clicked" });
        const scrollResult = scrollConversationToBottom(cdp);
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "scroll_conversation_bottom", result: scrollResult.ok ? "ok" : "failed", detail: scrollResult });
        sleepMs(400);
      }
    }

    const afterAcceptProbe = probeAttachment(cdp, target.name);
    const afterAcceptIdentity = afterAcceptProbe.identity ? { ok: true, conversation: true } : threadIdentityStillMatches(cdp, target.name);
    if (!afterAcceptIdentity.ok) {
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "identity_check_after_accept", result: "failed", detail: afterAcceptIdentity });
      skipped++;
      continue;
    }

    const previewOpen = ensurePreviewOpen(cdp, options);
    if (!previewOpen.ok) {
      candidates[target.id] = { ...c, status: "download_failed", last_observation: previewOpen.reason, last_error: previewOpen.reason };
      failed++;
      consecutiveDownloadFailures++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "open_preview", result: "failed", error_code: previewOpen.reason, detail: previewOpen });
      saveState(options.stateFile, state, options.jobName);
      if (consecutiveDownloadFailures >= 2) {
        pausedReason = "paused_consecutive_download_failures";
        break;
      }
      continue;
    }

    let dlBtn = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      dlBtn = clickDownloadInPreview(cdp);
      if (dlBtn.ok || dlBtn.reason !== "download_button_not_ready") break;
      sleepMs(250);
    }
    if (!dlBtn.ok) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: "download_button_not_found", last_error: "download_button_not_found" };
      failed++;
      consecutiveDownloadFailures++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: "download_button_not_found", detail: dlBtn });
      saveState(options.stateFile, state, options.jobName);
      if (consecutiveDownloadFailures >= 2) {
        pausedReason = "paused_consecutive_download_failures";
        break;
      }
      continue;
    }

    const beforeSnapshot = dirSnapshot(downloadDirSet ? options.resumeDownloadDir : require("os").homedir() + "/Downloads");
    const clickTime = Date.now();
    cdp.clickAt(dlBtn.selector);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "click_download", result: "clicked", detail: dlBtn });

    const downloadDir = downloadDirSet ? options.resumeDownloadDir : (require("os").homedir() + "/Downloads");
    const dlResult = findNewDownload(downloadDir, beforeSnapshot, clickTime, options.downloadPollIntervalMs, options.downloadMaxWaitSeconds);

    if (!dlResult.ok) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: dlResult.reason, last_error: dlResult.reason };
      failed++;
      consecutiveDownloadFailures++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: dlResult.reason });
      saveState(options.stateFile, state, options.jobName);
      if (consecutiveDownloadFailures >= 2) {
        pausedReason = "paused_consecutive_download_failures";
        break;
      }
      continue;
    }

    const ext = path.extname(dlResult.filePath).toLowerCase() || ".pdf";
    const downloadedHash = fileHash(dlResult.filePath);
    const existingResume = findExistingResumeByHash(candidates, target.id, downloadedHash);
    if (existingResume) {
      closePreview(cdp);
      if (path.resolve(dlResult.filePath) !== path.resolve(existingResume.local_resume_path)) {
        try { fs.unlinkSync(dlResult.filePath); } catch (_) {}
      }
      if (existingResume.scope !== "same_candidate") {
        if (lastDuplicateOtherHash === downloadedHash) consecutiveDuplicateOtherHash++;
        else consecutiveDuplicateOtherHash = 1;
        lastDuplicateOtherHash = downloadedHash;
        candidates[target.id] = {
          ...c,
          status: "download_failed",
          last_observation: "duplicate_resume_hash_other_candidate",
          last_error: "duplicate_resume_hash_other_candidate",
          history: [...(c.history || []), { at: now(), run_id: options.runId, action: "download_resume", result: "duplicate_other_candidate", duplicate_of: existingResume.candidate_id }],
        };
        batch.push(target.id);
        failed++;
        appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download_resume", result: "duplicate_other_candidate", hash: downloadedHash, duplicate: existingResume, consecutive_duplicate_hash: consecutiveDuplicateOtherHash });
        if (consecutiveDuplicateOtherHash >= 2) {
          pausedReason = "paused_repeated_duplicate_resume_hash";
          appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "safety_pause", result: "paused", error_code: pausedReason, hash: downloadedHash, duplicate: existingResume });
          break;
        }
        continue;
      }
      candidates[target.id] = {
        ...c,
        status: "resume_downloaded",
        local_resume_path: existingResume.local_resume_path,
        resume_hash: downloadedHash,
        resume_downloaded_at: c.resume_downloaded_at || now(),
        last_observation: "duplicate_resume_reused",
        history: [...(c.history || []), { at: now(), run_id: options.runId, action: "download_resume", result: "duplicate_reused", duplicate_of: existingResume.candidate_id }],
      };
      batch.push(target.id);
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download_resume", result: "duplicate_reused", hash: downloadedHash, duplicate: existingResume });
      saveState(options.stateFile, state, options.jobName);
      batch = [];
      continue;
    }
    lastDuplicateOtherHash = "";
    consecutiveDuplicateOtherHash = 0;

    const originalFilename = path.basename(dlResult.filePath);
    const finalName = makeResumeFilename(options.jobName, target.name, target.school, ext.replace(/^\./, ""), originalFilename);
    const destPath = resolveUniquePath(options.resumeDownloadDir, finalName);

    try {
      if (downloadDirSet) {
        fs.renameSync(dlResult.filePath, destPath);
      } else {
        fs.copyFileSync(dlResult.filePath, destPath);
        fs.unlinkSync(dlResult.filePath);
      }
      const finalStat = fs.statSync(destPath);
      if (!finalStat.isFile() || finalStat.size <= 0) {
        throw new Error("downloaded_file_invalid");
      }
    } catch (e) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: "rename_failed", last_error: String(e.message) };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: "rename_failed" });
      continue;
    }

    const hash = downloadedHash || fileHash(destPath);
    if (!hash || !fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
      closePreview(cdp);
      candidates[target.id] = { ...c, status: "download_failed", last_observation: "download_verify_failed", last_error: "download_verify_failed" };
      failed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download", result: "failed", error_code: "download_verify_failed", path: destPath });
      continue;
    }
    downloaded++;
    consecutiveDownloadFailures = 0;
    candidates[target.id] = {
      ...c,
      status: "resume_downloaded",
      local_resume_path: destPath,
      resume_hash: hash,
      resume_downloaded_at: now(),
      last_observation: "resume_downloaded",
      history: [...(c.history || []), { at: now(), run_id: options.runId, action: "download_resume", result: "ok" }],
    };
    batch.push(target.id);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "download_resume", result: "ok", path: destPath, hash });
    saveState(options.stateFile, state, options.jobName);
    batch = [];

    const queueResult = writeSyncQueue(options, target.id, c.name, c.school, destPath, hash);
    if (!queueResult.ok) {
      candidates[target.id] = { ...candidates[target.id], status: "sync_queue_failed", last_observation: "sync_queue_write_failed", last_error: queueResult.reason || "sync_queue_write_failed" };
      failed++;
      pausedReason = "paused_sync_queue_write_failed";
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: "failed", detail: queueResult });
      break;
    }

    if (!queueResult.alreadyExists) queued++;
    candidates[target.id] = { ...candidates[target.id], status: "ready_for_hire_sync", sync_queue_status: "pending", ready_for_hire_sync_at: now(), last_observation: queueResult.alreadyExists ? "sync_queue_already_written" : "sync_queue_written" };
    batch.push(target.id);
    appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "sync_queue", result: queueResult.alreadyExists ? "already_exists" : "ok" });
    saveState(options.stateFile, state, options.jobName);
    batch = [];

    closePreview(cdp);
    sleepMs(500);

    const alreadyInThread = confirmReplyAlreadySent(cdp, options);
    const replyResult = alreadyInThread.ok ? { ok: true, alreadySent: true } : sendConfirmReply(cdp, options);
    if (replyResult.ok) {
      candidates[target.id] = { ...candidates[target.id], status: "boss_completed", boss_completed_at: now(), confirm_received_sent_at: now(), last_observation: replyResult.alreadySent ? "confirm_reply_already_in_thread" : "boss_completed" };
      if (!replyResult.alreadySent) completed++;
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "ok", detail: replyResult });
      saveState(options.stateFile, state, options.jobName);
      batch = [];
    } else {
      candidates[target.id] = { ...candidates[target.id], status: "paused_send_failed", last_observation: "confirm_reply_failed", last_error: replyResult.reason || "confirm_reply_failed" };
      failed++;
      pausedReason = "paused_send_failed";
      appendLog(options.logFile, options.runId, MODE, { candidate_id: target.id, action: "confirm_reply", result: "failed", detail: replyResult });
      break;
    }

    if (batch.length >= options.stateFlushBatchSize) {
      saveState(options.stateFile, state, options.jobName);
      batch = [];
    }
  }

  saveState(options.stateFile, state, options.jobName);
  console.log(JSON.stringify({
    status: pausedReason ? "paused" : "ok",
    mode: MODE,
    scanned,
    received,
    downloaded,
    queued,
    completed,
    skipped,
    failed,
    paused_reason: pausedReason,
    run_id: options.runId,
    target: cdp.target,
  }));
}

function writeSyncQueue(options, candidateId, name, school, localPath, hash) {
  try {
    if (syncQueueRecordExists(options, candidateId, hash, localPath)) {
      return { ok: true, alreadyExists: true };
    }
    const record = {
      candidate_id: candidateId,
      name: name || "",
      school: school || "",
      job_name: options.jobName,
      filename: path.basename(localPath),
      local_resume_path: localPath,
      resume_hash: hash,
      sync_queue_status: "pending",
      boss_status: "boss_completed",
      ready_for_hire_sync_at: now(),
    };
    ensureDir(options.syncQueueFile ? path.dirname(options.syncQueueFile) : null);
    fs.appendFileSync(options.syncQueueFile, JSON.stringify(record) + "\n");
    return { ok: true, written: true };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

function sendConfirmReply(cdp, options) {
  try {
    const existing = confirmReplyAlreadySent(cdp, options);
    if (existing.ok) return { ok: true, alreadySent: true, existing };

    const prepared = cdp.eval(`(() => {
      const message = ${JSON.stringify(options.confirmReceivedMessage)};
      const actionId = 'confirm-send-' + Date.now() + '-' + Math.floor(Math.random() * 1000000);
      document.querySelectorAll('[data-boss-auto-confirm-send-id]').forEach(el => el.removeAttribute('data-boss-auto-confirm-send-id'));
      const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
      if (!editor) return { ok: false, reason: 'editor_not_found' };
      editor.focus();
      editor.innerHTML = '';
      editor.textContent = message;
      editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: message }));
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));

      // 等待一下确保UI更新
      const startTime = Date.now();
      while (Date.now() - startTime < 300) {
        // 短暂等待
      }

      const btns = Array.from(document.querySelectorAll('.chat-container-private .submit, .chat-input .submit, .submit, button, [role="button"]'))
        .filter(el => {
          const r = el.getBoundingClientRect?.();
          if (!r || r.width <= 0 || r.height <= 0) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
          const t = (el.innerText || el.textContent || el.getAttribute?.('aria-label') || el.getAttribute?.('title') || '').trim();
          return /发送/.test(t) || String(el.className || '').includes('submit');
        })
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const as = String(a.className || '').includes('submit') ? 0 : 10;
          const bs = String(b.className || '').includes('submit') ? 0 : 10;
          if (as !== bs) return as - bs;
          return br.x - ar.x;
        });
      const btn = btns[0];
      if (!btn) return { ok: false, reason: 'send_button_not_found', editorText: (editor.innerText || editor.textContent || '').trim() };
      btn.setAttribute('data-boss-auto-confirm-send-id', actionId);
      const r = btn.getBoundingClientRect();
      return { ok: true, selector: '[data-boss-auto-confirm-send-id="' + actionId + '"]', rect: { x: r.x, y: r.y, width: r.width, height: r.height }, editorText: (editor.innerText || editor.textContent || '').trim() };
    })()`);
    if (!prepared.ok || !prepared.selector) return prepared;

    // 多次尝试点击发送按钮
    let clickAttempts = 0;
    let check = null;
    while (clickAttempts < 3) {
      cdp.clickAt(prepared.selector);
      sleepMs(Math.max(Number(options.confirmTimeoutMs) || 0, 1500));

      check = cdp.eval(`(() => {
        const message = ${JSON.stringify(options.confirmReceivedMessage)};
        const conv = document.querySelector('.chat-conversation');
        const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
        const editorText = (editor?.innerText || editor?.textContent || '').trim();
        const convText = (conv?.innerText || '').trim();
        return {
          ok: convText.includes(message) && !editorText.includes(message),
          messageInConversation: convText.includes(message),
          editorCleared: !editorText.includes(message),
          editorText: editorText.slice(0, 120),
        };
      })()`);

      if (check.ok) break;
      clickAttempts++;
      sleepMs(500);
    }

    if (!check.ok) {
      if (check.messageInConversation && !check.editorCleared) {
        const cleared = cdp.eval(`(() => {
          const message = ${JSON.stringify(options.confirmReceivedMessage)};
          const editor = document.querySelector('.chat-container-private [contenteditable="true"], .chat-input [contenteditable="true"], [contenteditable="true"]');
          if (!editor) return { ok: false, reason: 'editor_not_found' };
          const editorText = (editor.innerText || editor.textContent || '').trim();
          if (!editorText.includes(message)) return { ok: true, alreadyCleared: true };
          editor.focus();
          editor.innerHTML = '';
          editor.textContent = '';
          editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
          editor.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, clearedDraft: true };
        })()`);
        if (cleared.ok) return { ok: true, prepared, check, clearedDraft: cleared };
      }
      return { ok: false, reason: check.messageInConversation ? 'confirm_editor_not_cleared' : 'confirm_message_not_in_conversation', prepared, check };
    }
    return { ok: true, prepared, check };
  } catch (e) {
    return { ok: false, reason: String(e.message || e) };
  }
}

main();
