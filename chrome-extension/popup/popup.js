import {
  DEFAULT_SERVICE_URL,
  friendlyError,
  isActiveStatus,
  normalizeServiceUrl,
  statusClass,
  statusLabel,
} from "../shared/plugin-ui.mjs";

const $ = (id) => document.getElementById(id);

let serviceUrl = DEFAULT_SERVICE_URL;
let pollTimer = null;
let lastOutput = "请先打开 Boss招聘助手.app，让本地控制面板保持运行。";
let currentRecommend = { status: "idle" };
let currentPipeline = { status: "idle" };

function render(value) {
  lastOutput = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  $("output").textContent = lastOutput;
  $("emptyLog").hidden = Boolean(lastOutput.trim());
}

async function loadSettings() {
  const stored = await chrome.storage.local.get({ serviceUrl: DEFAULT_SERVICE_URL });
  serviceUrl = normalizeServiceUrl(stored.serviceUrl);
  $("serviceUrlLabel").textContent = serviceUrl.replace(/^http:\/\//, "");
}

async function request(path, options = {}) {
  const response = await fetch(`${serviceUrl}${path}`, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(value.error || `HTTP ${response.status}`);
    error.payload = value;
    throw error;
  }
  return value;
}

function setStatus(id, status, fallback = "空闲") {
  const el = $(id);
  const cls = statusClass(status);
  el.textContent = statusLabel(status || fallback);
  el.className = ["status-value", cls].filter(Boolean).join(" ");
}

function setServiceStatus(text, cls = "") {
  $("serviceStatus").textContent = text;
  $("serviceStatus").className = ["status-value", cls].filter(Boolean).join(" ");
}

function updateButtonStates() {
  const recommendActive = isActiveStatus(currentRecommend?.status);
  const pipelineActive = isActiveStatus(currentPipeline?.status);
  const anyActive = recommendActive || pipelineActive;

  $("recommendBtn").disabled = anyActive;
  for (const button of document.querySelectorAll("[data-start]")) button.disabled = anyActive;
  $("pauseBtn").disabled = !anyActive;

  if (anyActive && !pollTimer) pollTimer = setInterval(refreshState, 1500);
  if (!anyActive && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function renderRecommend(state) {
  currentRecommend = state || { status: "idle" };
  setStatus("recommendStatus", currentRecommend.status);
  updateButtonStates();
}

function renderPipeline(state) {
  currentPipeline = state || { status: "idle" };
  setStatus("pipelineStatus", currentPipeline.status);
  updateButtonStates();
}

function renderStateSummary() {
  render({
    recommend: currentRecommend,
    pipeline: currentPipeline,
  });
}

async function refreshJobs() {
  const result = await request("/api/jobs");
  const jobs = result.jobs || [];
  $("jobKey").replaceChildren(new Option("全部启用岗位", "all"));
  for (const job of jobs) {
    const suffix = job.feishu_configured ? "" : "（无飞书路由）";
    $("jobKey").add(new Option(`${job.display_name}${suffix}`, job.job_key));
  }
  return result;
}

async function refreshState({ showOutput = true } = {}) {
  try {
    const [recommend, pipeline] = await Promise.all([
      request("/api/runs/current"),
      request("/api/pipeline/current"),
    ]);
    renderRecommend(recommend);
    renderPipeline(pipeline);
    setServiceStatus("已连接", "ok");
    if (showOutput) renderStateSummary();
  } catch (error) {
    setServiceStatus("未连接", "bad");
    setStatus("recommendStatus", "failed");
    setStatus("pipelineStatus", "failed");
    render(friendlyError(error));
  }
}

async function checkHealth() {
  const health = await request("/api/health");
  setServiceStatus("已连接", "ok");
  return health;
}

function numeric(id, fallback, min, max) {
  const value = Number($(id).value);
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
}

function pipelinePayload(type) {
  return {
    type,
    mode: $("mode").value,
    dailyTarget: numeric("dailyTarget", 20, 1, 200),
    chatLimit: numeric("chatLimit", 20, 1, 200),
    collectLimit: numeric("collectLimit", 20, 1, 200),
    syncLimit: numeric("syncLimit", 3, 1, 50),
    jobKey: $("jobKey").value,
    deleteUploadedResumes: false,
  };
}

async function startPipeline(type, label) {
  if ($("mode").value === "real-run" && !confirm(`${label}将调用本地 App 的既有链路执行真实操作，确认开始？`)) return;
  try {
    render(`正在启动：${label}...`);
    const state = await request("/api/pipeline/start", {
      method: "POST",
      body: JSON.stringify(pipelinePayload(type)),
    });
    renderPipeline(state);
    render(state);
  } catch (error) {
    render({ error: friendlyError(error), detail: error.payload || error.message });
    await refreshState({ showOutput: false });
  }
}

async function startRecommend() {
  if ($("jobKey").value === "all") {
    render("推荐页打招呼需要选择单个岗位。");
    return;
  }
  if ($("mode").value === "real-run" && !confirm("推荐页打招呼将调用本地 App 的既有链路执行真实操作，确认开始？")) return;
  try {
    const target = numeric("dailyTarget", 20, 1, 200);
    const state = await request("/api/runs/start", {
      method: "POST",
      body: JSON.stringify({
        jobId: $("jobKey").value,
        dailyTarget: target,
        batchSize: Math.min(target, 50),
        batchIntervalMinutes: 0,
        mode: $("mode").value,
      }),
    });
    renderRecommend(state);
    render(state);
  } catch (error) {
    render({ error: friendlyError(error), detail: error.payload || error.message });
    await refreshState({ showOutput: false });
  }
}

function openDashboard(path = "/") {
  chrome.tabs.create({ url: `${serviceUrl}${path}` });
}

async function init() {
  await loadSettings();
  $("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("openDashboardBtn").addEventListener("click", () => openDashboard("/"));
  $("recommendBtn").addEventListener("click", startRecommend);
  $("chatBtn").addEventListener("click", () => startPipeline("chat", "沟通页打招呼"));
  $("collectBtn").addEventListener("click", () => startPipeline("collect", "收取简历"));
  $("syncBtn").addEventListener("click", () => startPipeline("sync", "同步飞书"));
  $("pauseBtn").addEventListener("click", async () => {
    try {
      const [pipeline, recommend] = await Promise.allSettled([
        request("/api/pipeline/pause", { method: "POST", body: "{}" }),
        request("/api/runs/pause", { method: "POST", body: "{}" }),
      ]);
      const pipelineValue = pipeline.status === "fulfilled" ? pipeline.value : { error: friendlyError(pipeline.reason) };
      const recommendValue = recommend.status === "fulfilled" ? recommend.value : { error: friendlyError(recommend.reason) };
      if (pipeline.status === "fulfilled") renderPipeline(pipeline.value.state || {});
      if (recommend.status === "fulfilled") renderRecommend(recommend.value.state || {});
      render({ pipeline: pipelineValue, recommend: recommendValue });
      await refreshState({ showOutput: false });
    } catch (error) {
      render({ error: friendlyError(error), detail: error.payload || error.message });
    }
  });

  try {
    await checkHealth();
    await refreshJobs();
    await refreshState();
  } catch (error) {
    setServiceStatus("未连接", "bad");
    setStatus("recommendStatus", "failed");
    setStatus("pipelineStatus", "failed");
    render(friendlyError(error));
  }
}

init().catch((error) => render(String(error.message || error)));
