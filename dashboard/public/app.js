const $ = (id) => document.getElementById(id);
let pollTimer = null;
let pipelinePollTimer = null;

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { "content-type": "application/json", ...(options.headers || {}) }, ...options });
  const value = await response.json();
  if (!response.ok) {
    const error = new Error(value.error || `HTTP ${response.status}`);
    error.payload = value;
    throw error;
  }
  return value;
}

function notice(message, type = "") {
  $("notice").textContent = message;
  $("notice").className = `notice ${type}`;
}

function pipelineNotice(message, type = "") {
  $("pipelineNotice").textContent = message;
  $("pipelineNotice").className = `notice ${type}`;
}

function syncTarget(value) {
  const target = Math.max(1, Math.min(200, Number(value) || 1));
  $("dailyTarget").value = target;
  $("dailyTargetNumber").value = target;
  $("targetValue").textContent = target;
}

function renderState(state) {
  const counters = state.counters || {};
  $("status").textContent = state.status || "idle";
  $("scanned").textContent = counters.scanned || 0;
  $("eligible").textContent = counters.eligible || 0;
  $("greeted").textContent = counters.greeted || 0;
  $("skipped").textContent = counters.skipped || 0;
  $("failed").textContent = counters.failed || 0;
  $("currentBatch").textContent = state.current_batch || 0;
  $("remainingBatches").textContent = state.remaining_batches || 0;
  $("details").textContent = JSON.stringify(state, null, 2);
  $("detailTitle").textContent = state.error ? `运行详情 · ${state.error}` : "运行详情";
  if (["running", "starting", "waiting", "pausing"].includes(state.status)) startPolling();
  else stopPolling();
}

function renderPipeline(state) {
  const stages = state.stages || [];
  const completed = stages.filter((stage) => stage.status === "completed").length;
  $("pipelineStatus").textContent = state.status || "idle";
  $("pipelineStage").textContent = state.current_stage_label || "-";
  $("pipelineProgress").textContent = `${completed} / ${stages.length}`;
  $("pipelineDetails").textContent = JSON.stringify(state, null, 2);
  if (["running", "starting", "pausing"].includes(state.status)) startPipelinePolling();
  else stopPipelinePolling();
}

function runOptions() {
  return {
    jobId: $("jobId").value,
    dailyTarget: Number($("dailyTargetNumber").value),
    batchSize: Number($("batchSize").value),
    batchIntervalMinutes: Number($("batchIntervalMinutes").value),
    mode: document.querySelector('input[name="mode"]:checked').value,
  };
}

async function health() {
  try {
    await request("/api/health");
    $("serviceBadge").textContent = "服务正常 · 无评分模式";
    $("serviceBadge").className = "badge ok";
  } catch {
    $("serviceBadge").textContent = "服务异常";
    $("serviceBadge").className = "badge bad";
  }
}

async function loadState(silent = false) {
  try {
    renderState(await request("/api/runs/current"));
    if (!silent) notice("状态已刷新", "ok");
  } catch (error) {
    if (!silent) notice(error.message, "bad");
  }
}

async function loadPipelineState(silent = false) {
  try {
    renderPipeline(await request("/api/pipeline/current"));
    if (!silent) pipelineNotice("旧链路状态已刷新", "ok");
  } catch (error) {
    if (!silent) pipelineNotice(error.message, "bad");
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

$("dailyTarget").addEventListener("input", (event) => syncTarget(event.target.value));
$("dailyTargetNumber").addEventListener("input", (event) => syncTarget(event.target.value));
$("batchSize").addEventListener("change", (event) => {
  event.target.value = Math.max(1, Math.min(50, Number(event.target.value) || 50));
});

$("preflightBtn").addEventListener("click", async () => {
  try {
    const result = await request("/api/preflight");
    $("detailTitle").textContent = "运行前检查";
    $("details").textContent = JSON.stringify(result, null, 2);
    notice(result.ok ? "运行前检查通过" : `检查未通过：${result.errors.join("；")}`, result.ok ? "ok" : "bad");
  } catch (error) { notice(error.message, "bad"); }
});

$("startBtn").addEventListener("click", async () => {
  const config = runOptions();
  if (config.mode === "real-run" && !window.confirm("real-run 会在 Boss 页面真实打招呼。确认开始？")) return;
  try {
    notice("正在执行运行前检查并启动任务...");
    const state = await request("/api/runs/start", { method: "POST", body: JSON.stringify(config) });
    renderState(state);
    notice("任务已启动", "ok");
  } catch (error) {
    $("details").textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
    notice(`启动失败：${error.message}`, "bad");
  }
});

$("pauseBtn").addEventListener("click", async () => {
  try {
    const result = await request("/api/runs/pause", { method: "POST", body: "{}" });
    renderState(result.state || {});
    notice(result.paused ? "暂停请求已提交" : "当前没有运行中任务", result.paused ? "ok" : "");
  } catch (error) { notice(error.message, "bad"); }
});

$("statusBtn").addEventListener("click", () => loadState());
$("reportBtn").addEventListener("click", async () => {
  try {
    const report = await request("/api/runs/report/today");
    $("detailTitle").textContent = `今日报告 · ${report.date}`;
    $("details").textContent = JSON.stringify(report, null, 2);
    notice("今日报告已加载", "ok");
  } catch (error) { notice(error.message, "bad"); }
});

for (const button of document.querySelectorAll(".pipeline-start")) {
  button.addEventListener("click", async () => {
    const type = button.dataset.pipeline;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const labels = {
      chat: "处理沟通页并发送求简历消息",
      collect: "收取候选人简历附件",
      sync: "同步到飞书招聘",
      full: "运行推荐、沟通、收简历和飞书同步完整链路",
    };
    if (mode === "real-run" && !window.confirm(`${labels[type]}将执行真实操作。确认开始？`)) return;
    try {
      pipelineNotice(`正在启动：${labels[type]}...`);
      const state = await request("/api/pipeline/start", {
        method: "POST",
        body: JSON.stringify({
          type,
          mode,
          dailyTarget: Number($("dailyTargetNumber").value),
        }),
      });
      renderPipeline(state);
      pipelineNotice("旧链路任务已启动", "ok");
    } catch (error) {
      $("pipelineDetails").textContent = JSON.stringify(error.payload || { error: error.message }, null, 2);
      pipelineNotice(`启动失败：${error.message}`, "bad");
    }
  });
}

$("pipelinePauseBtn").addEventListener("click", async () => {
  try {
    const result = await request("/api/pipeline/pause", { method: "POST", body: "{}" });
    renderPipeline(result.state || {});
    pipelineNotice(result.paused ? "旧链路暂停请求已提交" : "当前没有旧链路任务", result.paused ? "ok" : "");
  } catch (error) {
    pipelineNotice(error.message, "bad");
  }
});

$("pipelineStatusBtn").addEventListener("click", () => loadPipelineState());

await Promise.all([health(), loadState(true), loadPipelineState(true)]);
