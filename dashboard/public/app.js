const $ = (id) => document.getElementById(id);
let pollTimer = null;

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
  $("passed").textContent = counters.passed || 0;
  $("greeted").textContent = counters.greeted || 0;
  $("skipped").textContent = counters.skipped || 0;
  $("review").textContent = counters.review || 0;
  $("currentBatch").textContent = state.current_batch || 0;
  $("remainingBatches").textContent = state.remaining_batches || 0;
  $("details").textContent = JSON.stringify(state, null, 2);
  $("detailTitle").textContent = state.error ? `运行详情 · ${state.error}` : "运行详情";
  if (["running", "starting", "waiting", "pausing"].includes(state.status)) startPolling();
  else stopPolling();
}

function runOptions() {
  return {
    jobProfileId: $("jobProfileId").value,
    dailyTarget: Number($("dailyTargetNumber").value),
    scoreThreshold: Number($("scoreThreshold").value),
    batchSize: Number($("batchSize").value),
    batchIntervalMinutes: Number($("batchIntervalMinutes").value),
    mode: document.querySelector('input[name="mode"]:checked').value,
  };
}

async function health() {
  try {
    const result = await request("/api/health");
    $("serviceBadge").textContent = result.llmConfigured ? "服务正常 · LLM 已配置" : "服务正常 · 未配置 LLM";
    $("serviceBadge").className = `badge ${result.llmConfigured ? "ok" : "warn"}`;
  } catch {
    $("serviceBadge").textContent = "服务异常";
    $("serviceBadge").className = "badge bad";
  }
}

async function loadProfile() {
  try {
    const result = await request("/api/job-profile/ai-app-intern");
    $("profileView").textContent = JSON.stringify(result.profile, null, 2);
    $("scoreThreshold").value = result.profile.score_threshold_default || 70;
  } catch (error) {
    $("profileView").textContent = error.message;
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

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(() => loadState(true), 1500);
}
function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

$("dailyTarget").addEventListener("input", (event) => syncTarget(event.target.value));
$("dailyTargetNumber").addEventListener("input", (event) => syncTarget(event.target.value));
$("batchSize").addEventListener("change", (event) => {
  event.target.value = Math.max(1, Math.min(50, Number(event.target.value) || 50));
});

$("preflightBtn").addEventListener("click", async () => {
  try {
    const result = await request(`/api/preflight?jobProfileId=${encodeURIComponent($("jobProfileId").value)}`);
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
$("loadProfileBtn").addEventListener("click", loadProfile);
$("reportBtn").addEventListener("click", async () => {
  try {
    const report = await request("/api/runs/report/today");
    $("detailTitle").textContent = `今日报告 · ${report.date}`;
    $("details").textContent = JSON.stringify(report, null, 2);
    notice("今日报告已加载", "ok");
  } catch (error) { notice(error.message, "bad"); }
});

$("generateBtn").addEventListener("click", async () => {
  const jd = $("jd").value.trim();
  if (!jd) return notice("请先输入 JD", "bad");
  try {
    notice("正在生成岗位画像...");
    const result = await request("/api/job-profile/ai-app-intern/generate", { method: "POST", body: JSON.stringify({ jd }) });
    $("profileView").textContent = JSON.stringify(result.profile, null, 2);
    notice("岗位画像已生成并保存", "ok");
  } catch (error) { notice(`生成失败：${error.message}`, "bad"); }
});

await Promise.all([health(), loadProfile(), loadState(true)]);
