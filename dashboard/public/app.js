const $ = (id) => document.getElementById(id);
let pollTimer = null;
let pipelinePollTimer = null;

const STATUS_TEXT = {
  idle: "空闲",
  starting: "正在启动",
  running: "运行中",
  waiting: "等待下一批",
  pausing: "正在暂停",
  paused: "已暂停",
  completed: "已完成",
  completed_partial: "部分完成",
  failed: "失败",
  pending: "等待执行",
};

const ERROR_MAP = [
  [/Failed to fetch|fetch failed|NetworkError/i, ["无法连接控制面板", "确认启动面板的终端仍在运行，然后刷新页面。"]],
  [/pipeline_already_active/, ["已有流程正在运行", "等待当前流程完成，或点击“暂停当前流程”。"]],
  [/run_already_active|run_lock_exists/, ["推荐页任务正在运行", "等待任务完成，或先暂停推荐页任务。"]],
  [/recommend_run_already_active/, ["推荐页任务占用中", "先暂停推荐页任务，再执行日常招聘流程。"]],
  [/legacy_boss_run_already_active|legacy_boss_run_active/, ["Boss 页面正在被其他任务使用", "等待当前任务结束，不要同时启动多个任务。"]],
  [/invalid_feishu_job_id/, ["飞书岗位 ID 不正确", "填写岗位页面网址中 job_id= 后面的纯数字。"]],
  [/hire:application|99991672/, ["飞书应用缺少投递权限", "在飞书开放平台为当前应用开通 hire:application，并发布新版本。"]],
  [/school mismatch/i, ["候选人资料需要人工确认", "飞书中已有同一候选人，但学校信息不同。请人工核对后再处理。"]],
  [/paused_boss_not_logged_in|paused_login_required/, ["Boss 登录已失效", "在已开启远程调试的 Chrome 中重新登录 Boss 直聘。"]],
  [/paused_chat_page_unavailable/, ["沟通页面未成功加载", "在远程调试 Chrome 中手动打开 Boss 沟通页，确认能看到候选人会话列表后重新执行。"]],
  [/paused_captcha_detected/, ["Boss 出现验证码", "请在 Chrome 中人工完成验证码，再重新执行。"]],
  [/paused_platform_warning/, ["Boss 出现平台警告", "请先人工处理平台提示，确认安全后再继续。"]],
  [/ECONNREFUSED|3456.*没有服务/i, ["浏览器连接服务未启动", "点击页面下方“启动浏览器连接”，然后重新检查。"]],
  [/9222.*未监听|Chrome 未开启远程调试/i, ["Chrome 远程调试未开启", "打开 chrome://inspect/#remote-debugging，并开启 Allow remote debugging。"]],
  [/process_exit_\d+/, ["任务脚本异常结束", "展开页面底部任务详情，查看最后一条错误。"]],
];

async function request(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: { "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || `HTTP ${response.status}`);
      error.payload = value;
      throw error;
    }
    return value;
  } catch (error) {
    if (!error.payload && /fetch/i.test(String(error.message))) error.message = "fetch failed";
    throw error;
  }
}

function friendlyError(value) {
  const text = String(value?.message || value || "未知错误");
  for (const [pattern, result] of ERROR_MAP) {
    if (pattern.test(text)) return { title: result[0], guide: result[1], raw: text };
  }
  return { title: "操作未完成", guide: "展开页面底部任务详情查看具体原因；处理后再重试。", raw: text };
}

function showNotice(id, message, type = "", guide = "") {
  const element = $(id);
  element.className = `notice ${type}`;
  element.replaceChildren();
  const title = document.createElement("strong");
  title.textContent = message;
  element.append(title);
  if (guide) {
    const detail = document.createElement("span");
    detail.textContent = `解决方法：${guide}`;
    element.append(detail);
  }
}

function showError(id, error) {
  const friendly = friendlyError(error);
  showNotice(id, friendly.title, "bad", friendly.guide);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderPreflight(result) {
  $("preflightChecks").innerHTML = (result.checks || []).map((check) => `
    <div class="check-card ${check.ok ? "ok" : "bad"}">
      <strong>${check.ok ? "正常" : "需要处理"} · ${escapeHtml(check.label || check.key)}</strong>
      <p>${escapeHtml(check.detail || "")}</p>
      ${check.guide ? `<p class="guide">解决方法：${escapeHtml(check.guide)}</p>` : ""}
    </div>
  `).join("") || '<div class="check-card bad"><strong>检查失败</strong><p>没有收到检查结果，请重启控制面板。</p></div>';
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function renderState(state) {
  const counters = state.counters || {};
  $("status").textContent = STATUS_TEXT[state.status] || state.status || "空闲";
  $("scanned").textContent = counters.scanned || 0;
  $("eligible").textContent = counters.eligible || 0;
  $("greeted").textContent = counters.greeted || 0;
  $("skipped").textContent = counters.skipped || 0;
  $("failed").textContent = counters.failed || 0;
  $("details").textContent = JSON.stringify(state, null, 2);
  $("detailTitle").textContent = state.error ? `推荐页任务：${friendlyError(state.error).title}` : "推荐页任务详情";
  if (["running", "starting", "waiting", "pausing"].includes(state.status)) startPolling();
  else stopPolling();
}

function renderPipeline(state) {
  const stages = state.stages || [];
  const completed = stages.filter((stage) => ["completed", "completed_partial"].includes(stage.status)).length;
  const isActive = ["running", "starting", "pausing"].includes(state.status);
  $("pipelineStatus").textContent = STATUS_TEXT[state.status] || state.status || "空闲";
  $("pipelineStage").textContent = state.current_stage_label || "-";
  $("pipelineProgress").textContent = `${completed} / ${stages.length}`;
  $("pipelineDetails").textContent = JSON.stringify(state, null, 2);
  for (const button of document.querySelectorAll(".pipeline-start")) button.disabled = isActive;

  if (state.status === "failed" && state.error) showError("pipelineNotice", state.error);
  else if (state.status === "completed_partial") {
    const partialStage = stages.find((stage) => stage.status === "completed_partial");
    const result = partialStage?.result || {};
    const detail = [
      Number.isFinite(result.attempted) ? `本次处理 ${result.attempted} 人` : "",
      Number.isFinite(result.manual_review_this_run) ? `需人工确认 ${result.manual_review_this_run} 人` : "",
      Number.isFinite(result.failed_this_run) ? `失败 ${result.failed_this_run} 人` : "",
    ].filter(Boolean).join("，");
    showNotice(
      "pipelineNotice",
      "流程已完成，但有候选人需要人工确认",
      "",
      detail || "展开任务详情查看具体记录。"
    );
  }
  else if (state.status === "completed") showNotice("pipelineNotice", "流程已完成", "ok");

  if (isActive) startPipelinePolling();
  else stopPipelinePolling();
}

async function health() {
  try {
    await request("/api/health");
    $("serviceBadge").textContent = "服务正常";
    $("serviceBadge").className = "badge ok";
  } catch (error) {
    $("serviceBadge").textContent = friendlyError(error).title;
    $("serviceBadge").className = "badge bad";
  }
}

async function loadState(silent = false) {
  try {
    renderState(await request("/api/runs/current"));
    if (!silent) showNotice("notice", "推荐页任务状态已刷新", "ok");
  } catch (error) {
    if (!silent) showError("notice", error);
  }
}

async function loadPipelineState(silent = false) {
  try {
    renderPipeline(await request("/api/pipeline/current"));
    if (!silent) showNotice("pipelineNotice", "流程状态已刷新", "ok");
  } catch (error) {
    if (!silent) showError("pipelineNotice", error);
  }
}

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(() => loadState(true), 1500);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
function startPipelinePolling() {
  if (!pipelinePollTimer) pipelinePollTimer = setInterval(() => loadPipelineState(true), 1500);
}
function stopPipelinePolling() {
  if (pipelinePollTimer) clearInterval(pipelinePollTimer);
  pipelinePollTimer = null;
}

$("dailyTarget").addEventListener("input", (event) => {
  $("dailyTargetNumber").value = event.target.value;
});
$("dailyTargetNumber").addEventListener("input", (event) => {
  const value = Math.max(1, Math.min(200, Number(event.target.value) || 1));
  event.target.value = value;
  $("dailyTarget").value = value;
});
$("batchSize").addEventListener("change", (event) => {
  event.target.value = Math.max(1, Math.min(50, Number(event.target.value) || 50));
});

$("preflightBtn").addEventListener("click", async () => {
  try {
    const result = await request("/api/preflight");
    renderPreflight(result);
  } catch (error) {
    const friendly = friendlyError(error);
    $("preflightChecks").innerHTML = `<div class="check-card bad"><strong>${escapeHtml(friendly.title)}</strong><p class="guide">解决方法：${escapeHtml(friendly.guide)}</p></div>`;
  }
});

$("proxyBtn").addEventListener("click", async () => {
  try {
    $("proxyBtn").disabled = true;
    $("proxyBtn").textContent = "正在连接...";
    const result = await request("/api/proxy/start", { method: "POST", body: "{}" });
    const preflight = await request("/api/preflight");
    renderPreflight(preflight);
    if (!result.ok) throw new Error(result.message || "proxy_start_failed");
  } catch (error) {
    const friendly = friendlyError(error);
    $("preflightChecks").innerHTML = `<div class="check-card bad"><strong>${escapeHtml(friendly.title)}</strong><p class="guide">解决方法：${escapeHtml(friendly.guide)}</p></div>`;
  } finally {
    $("proxyBtn").disabled = false;
    $("proxyBtn").textContent = "启动浏览器连接";
  }
});

$("startBtn").addEventListener("click", async () => {
  const config = {
    jobId: $("jobId").value,
    dailyTarget: Number($("dailyTargetNumber").value),
    batchSize: Number($("batchSize").value),
    batchIntervalMinutes: Number($("batchIntervalMinutes").value),
    mode: currentMode(),
  };
  if (config.mode === "real-run" && !window.confirm("将真实操作推荐牛人页并发送招呼，确认开始？")) return;
  try {
    showNotice("notice", "正在检查环境并启动推荐页任务...");
    const state = await request("/api/runs/start", { method: "POST", body: JSON.stringify(config) });
    renderState(state);
    showNotice("notice", "推荐页任务已启动", "ok");
  } catch (error) {
    $("details").textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
    showError("notice", error);
  }
});

$("pauseBtn").addEventListener("click", async () => {
  try {
    const result = await request("/api/runs/pause", { method: "POST", body: "{}" });
    renderState(result.state || {});
    showNotice("notice", result.paused ? "暂停请求已提交" : "当前没有运行中的推荐页任务", result.paused ? "ok" : "");
  } catch (error) {
    showError("notice", error);
  }
});

$("reportBtn").addEventListener("click", async () => {
  try {
    const report = await request("/api/runs/report/today");
    $("detailTitle").textContent = `今日推荐页报告 · ${report.date}`;
    $("details").textContent = JSON.stringify(report, null, 2);
    showNotice("notice", "今日报告已加载", "ok");
  } catch (error) {
    showError("notice", error);
  }
});

for (const button of document.querySelectorAll(".pipeline-start")) {
  button.addEventListener("click", async () => {
    const type = button.dataset.pipeline;
    const feishuJobId = $("feishuJobId").value.trim();
    const chatLimit = Math.max(1, Math.min(200, Number($("chatLimit").value) || 20));
    const collectLimit = Math.max(1, Math.min(200, Number($("collectLimit").value) || 50));
    const syncLimit = Math.max(1, Math.min(50, Number($("syncLimit").value) || 1));
    const labels = {
      chat: "处理沟通页",
      collect: "收取简历",
      sync: "同步飞书招聘",
      full: "依次执行沟通、收简历和飞书同步",
    };
    if (["sync", "full"].includes(type) && !/^\d+$/.test(feishuJobId)) {
      showError("pipelineNotice", new Error("invalid_feishu_job_id"));
      $("feishuJobId").focus();
      return;
    }
    if (currentMode() === "real-run" && !window.confirm(`${labels[type]}将执行真实操作，确认开始？`)) return;
    try {
      showNotice("pipelineNotice", `正在启动：${labels[type]}...`);
      const state = await request("/api/pipeline/start", {
        method: "POST",
        body: JSON.stringify({
          type,
          mode: currentMode(),
          dailyTarget: Number($("dailyTargetNumber").value),
          chatLimit,
          collectLimit,
          feishuJobId,
          syncLimit,
        }),
      });
      renderPipeline(state);
      showNotice("pipelineNotice", `${labels[type]}已启动`, "ok");
    } catch (error) {
      if (error.message === "pipeline_already_active") {
        renderPipeline(error.payload?.currentRun || await request("/api/pipeline/current"));
      }
      showError("pipelineNotice", error);
    }
  });
}

$("pipelinePauseBtn").addEventListener("click", async () => {
  try {
    const result = await request("/api/pipeline/pause", { method: "POST", body: "{}" });
    renderPipeline(result.state || {});
    showNotice("pipelineNotice", result.paused ? "暂停请求已提交" : "当前没有运行中的流程", result.paused ? "ok" : "");
  } catch (error) {
    showError("pipelineNotice", error);
  }
});

$("pipelineStatusBtn").addEventListener("click", () => loadPipelineState());
$("feishuJobId").value = localStorage.getItem("boss-feishu-job-id") || "";
$("feishuJobId").addEventListener("change", () => {
  localStorage.setItem("boss-feishu-job-id", $("feishuJobId").value.trim());
});

await Promise.all([health(), loadState(true), loadPipelineState(true)]);
