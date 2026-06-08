const state = {
  jobName: "",
  task: null,
  jobNames: [],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function formatBytes(bytes) {
  if (!bytes) return "0 MB";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function setBusy(isBusy) {
  $$("[data-action]").forEach((button) => {
    button.disabled = isBusy;
  });
}

function renderMetrics(data) {
  const metrics = [
    ["候选人", data.state.total],
    ["待收简历", data.state.collectTargets],
    ["同步队列", data.queue.pending],
    ["本地简历", `${data.resumes.count} / ${formatBytes(data.resumes.bytes)}`],
    ["任务锁", data.lock?.exists ? (data.lock.stale ? "陈旧" : "运行中") : "无"],
  ];
  $("#metrics").innerHTML = metrics.map(([label, value]) => `
    <div class="metric">
      <span class="muted">${label}</span>
      <strong>${value}</strong>
    </div>
  `).join("");
}

function renderTask(task) {
  state.task = task;
  const pill = $("#taskPill");
  pill.className = "status-pill";
  if (!task) {
    pill.textContent = "空闲";
    $("#taskMeta").textContent = "";
    $("#taskOutput").textContent = "暂无运行任务";
    setBusy(false);
    return;
  }
  pill.textContent = task.status === "running" ? "运行中" : task.status;
  if (task.status === "running") pill.classList.add("running");
  if (task.status === "failed") pill.classList.add("failed");
  setBusy(task.status === "running" || task.status === "stopping");
  const step = task.steps[task.currentStep] || task.steps[task.steps.length - 1];
  $("#taskMeta").textContent = step ? `${step.label} · ${task.startedAt}` : task.startedAt;
  $("#taskOutput").textContent = (task.output || []).join("").trim() || "任务已启动，等待输出...";
  $("#taskOutput").scrollTop = $("#taskOutput").scrollHeight;
}

function renderCollectPreview(data) {
  $("#collectCount").textContent = `${data.state.collectTargets} 人`;
  const items = data.state.collectPreview || [];
  $("#collectPreview").innerHTML = items.length ? items.map((item) => `
    <div class="candidate">
      <strong>${escapeHtml(item.name)}${item.school ? ` · ${escapeHtml(item.school)}` : ""}</strong>
      <span>${escapeHtml(item.status)} · ${escapeHtml(item.messageSentAt || "无发送时间")}</span>
    </div>
  `).join("") : `<p class="muted">当前没有严格筛选后的待收简历候选人。</p>`;
}

function renderChecks(data) {
  $("#checks").innerHTML = data.checks.map((check) => `
    <div class="check-card ${check.ok ? "ok" : "bad"}">
      <strong>${check.ok ? "通过" : "需处理"} · ${escapeHtml(check.label)}</strong>
      <p>${escapeHtml(check.detail)}</p>
    </div>
  `).join("");
}

function renderLogs(data) {
  const lines = data.lines || [];
  $("#logs").innerHTML = lines.length ? lines.reverse().map((line) => `
    <div class="log-row">
      <code>${escapeHtml(line.at || "")}</code>
      <strong>${escapeHtml(line.action || line.mode || "log")}</strong>
      <span>${escapeHtml(line.candidate_id || line.error_code || line.reason || JSON.stringify(line).slice(0, 160))}</span>
      <code>${escapeHtml(line.result || line.status || "")}</code>
    </div>
  `).join("") : `<p class="muted">暂无日志。</p>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refreshStatus() {
  const jobName = $("#jobName").value.trim() || localStorage.getItem("boss-panel-job-name") || "";
  const data = await api(`/api/status${jobName ? `?jobName=${encodeURIComponent(jobName)}` : ""}`);
  renderJobNames(data.state.jobNames || [], data.jobName);
  if (!$("#jobName").value && data.jobName) $("#jobName").value = data.jobName;
  state.jobName = $("#jobName").value.trim();
  renderMetrics(data);
  renderCollectPreview(data);
  renderTask(data.task);
}

function renderJobNames(jobNames, currentJobName) {
  const select = $("#jobSelect");
  const prior = select.value;
  state.jobNames = jobNames;
  const selected = prior || currentJobName || localStorage.getItem("boss-panel-job-name") || "";
  select.innerHTML = [
    `<option value="">手动输入岗位名</option>`,
    ...jobNames.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`),
  ].join("");
  if (selected && jobNames.includes(selected)) select.value = selected;
}

async function refreshHealth() {
  const data = await api("/api/health");
  renderChecks(data);
}

async function refreshLogs() {
  const data = await api("/api/logs?limit=80");
  renderLogs(data);
}

async function runAction(action) {
  const payload = {
    jobName: $("#jobName").value.trim(),
    dryRun: $("#dryRun").checked,
    skipRecommend: $("#skipRecommend").checked,
  };
  if (payload.jobName) localStorage.setItem("boss-panel-job-name", payload.jobName);
  const task = await api(`/api/run/${action}`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  renderTask(task);
}

async function stopTask() {
  await api("/api/stop", { method: "POST", body: "{}" });
  await refreshHealth();
  await refreshStatus();
}

async function clearLock() {
  const result = await api("/api/lock/clear", { method: "POST", body: JSON.stringify({ force: false }) });
  if (!result.cleared && result.reason === "lock_process_alive") {
    alert("任务锁对应的进程仍在运行，未清理。请先暂停当前任务。");
  } else if (result.cleared) {
    alert("已清理陈旧任务锁。");
  } else {
    alert("当前没有任务锁。");
  }
  await refreshHealth();
  await refreshStatus();
}

async function startProxy() {
  const result = await api("/api/proxy/start", { method: "POST", body: "{}" });
  const message = result.proxy?.ok
    ? "CDP Proxy 已可用。"
    : `CDP Proxy 未就绪：${result.proxy?.reason || result.status || "unknown"}`;
  alert(message);
  await refreshHealth();
}

function bind() {
  $("#refreshBtn").addEventListener("click", () => {
    refreshStatus().catch(alertError);
    refreshLogs().catch(alertError);
  });
  $("#healthBtn").addEventListener("click", () => refreshHealth().catch(alertError));
  $("#proxyBtn").addEventListener("click", () => startProxy().catch(alertError));
  $("#logsBtn").addEventListener("click", () => refreshLogs().catch(alertError));
  $("#stopBtn").addEventListener("click", () => stopTask().catch(alertError));
  $("#clearLockBtn").addEventListener("click", () => clearLock().catch(alertError));
  $("#jobSelect").addEventListener("change", () => {
    const value = $("#jobSelect").value;
    if (value) {
      $("#jobName").value = value;
      localStorage.setItem("boss-panel-job-name", value);
      refreshStatus().catch(alertError);
    }
  });
  $("#jobName").addEventListener("change", () => {
    const value = $("#jobName").value.trim();
    if (value) localStorage.setItem("boss-panel-job-name", value);
    refreshStatus().catch(alertError);
  });
  $$("[data-action]").forEach((button) => {
    button.addEventListener("click", () => runAction(button.dataset.action).catch(alertError));
  });
}

function alertError(error) {
  alert(error.message || String(error));
}

bind();
refreshHealth().catch(alertError);
refreshStatus().catch(alertError);
refreshLogs().catch(alertError);
setInterval(() => {
  refreshStatus().catch(() => {});
}, 2500);
setInterval(() => {
  refreshLogs().catch(() => {});
}, 10000);
