const $ = (id) => document.getElementById(id);
const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";
const STATUS_TEXT = {
  idle: "空闲",
  starting: "启动中",
  running: "运行中",
  waiting: "等待中",
  pausing: "暂停中",
  paused: "已暂停",
  completed: "已完成",
  completed_partial: "部分完成",
  failed: "失败",
  pending: "等待执行",
};

let serviceUrl = DEFAULT_SERVICE_URL;
let pollTimer = null;

function render(value) {
  $("output").textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function normalizeServiceUrl(value) {
  const raw = String(value || DEFAULT_SERVICE_URL).trim().replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.protocol !== "http:") throw new Error("本地服务地址必须使用 http://");
  return url.origin;
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

function friendlyError(error) {
  const raw = String(error?.message || error || "未知错误");
  if (/Failed to fetch|NetworkError|fetch/i.test(raw)) return "无法连接本地控制面板，请先打开 Boss招聘助手.app。";
  if (/pipeline_already_active/.test(raw)) return "已有流程正在运行，请先暂停或等待完成。";
  if (/run_already_active|run_lock_exists/.test(raw)) return "推荐页任务正在运行，请先暂停或等待完成。";
  if (/missing_feishu_job_route|no_feishu_job_routes_configured/.test(raw)) return "当前岗位没有飞书路由，只能执行 Boss 沟通和收简历。";
  return raw;
}

function setServiceStatus(text, cls = "") {
  $("serviceStatus").textContent = text;
  $("serviceStatus").className = cls;
}

function statusClass(status) {
  if (status === "completed") return "ok";
  if (["starting", "running", "pausing", "completed_partial"].includes(status)) return "warn";
  if (status === "failed") return "bad";
  return "";
}

function renderPipeline(state) {
  const status = state?.status || "idle";
  $("pipelineStatus").textContent = STATUS_TEXT[status] || status;
  $("pipelineStatus").className = statusClass(status);
  render(state || {});
  const active = ["starting", "running", "pausing"].includes(status);
  for (const button of document.querySelectorAll("[data-start]")) button.disabled = active;
  if (active && !pollTimer) pollTimer = setInterval(refreshState, 1500);
  if (!active && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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

async function refreshState() {
  try {
    const state = await request("/api/pipeline/current");
    renderPipeline(state);
    setServiceStatus("已连接", "ok");
  } catch (error) {
    setServiceStatus("未连接", "bad");
    $("pipelineStatus").textContent = "不可用";
    $("pipelineStatus").className = "bad";
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
  } catch (error) {
    render({ error: friendlyError(error), detail: error.payload || error.message });
    await refreshState();
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
    render(state);
  } catch (error) {
    render({ error: friendlyError(error), detail: error.payload || error.message });
  }
}

async function init() {
  await loadSettings();
  $("optionsBtn").addEventListener("click", () => chrome.runtime.openOptionsPage());
  $("openDashboardBtn").addEventListener("click", () => chrome.tabs.create({ url: serviceUrl }));
  $("refreshBtn").addEventListener("click", refreshState);
  $("preflightBtn").addEventListener("click", async () => {
    try {
      render(await request("/api/preflight"));
      setServiceStatus("已连接", "ok");
    } catch (error) {
      setServiceStatus("未连接", "bad");
      render(friendlyError(error));
    }
  });
  $("proxyBtn").addEventListener("click", async () => {
    try {
      render(await request("/api/proxy/start", { method: "POST", body: "{}" }));
    } catch (error) {
      render({ error: friendlyError(error), detail: error.payload || error.message });
    }
  });
  $("recommendBtn").addEventListener("click", startRecommend);
  $("chatBtn").addEventListener("click", () => startPipeline("chat", "沟通页打招呼"));
  $("collectBtn").addEventListener("click", () => startPipeline("collect", "收取简历"));
  $("frontBtn").addEventListener("click", () => startPipeline("front", "沟通并收简历"));
  $("syncBtn").addEventListener("click", () => startPipeline("sync", "同步飞书"));
  $("pauseBtn").addEventListener("click", async () => {
    try {
      const [pipeline, recommend] = await Promise.allSettled([
        request("/api/pipeline/pause", { method: "POST", body: "{}" }),
        request("/api/runs/pause", { method: "POST", body: "{}" }),
      ]);
      const pipelineValue = pipeline.status === "fulfilled" ? pipeline.value : { error: friendlyError(pipeline.reason) };
      const recommendValue = recommend.status === "fulfilled" ? recommend.value : { error: friendlyError(recommend.reason) };
      render({ pipeline: pipelineValue, recommend: recommendValue });
      if (pipeline.status === "fulfilled") renderPipeline(pipeline.value.state || {});
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
    $("pipelineStatus").textContent = "不可用";
    $("pipelineStatus").className = "bad";
    render(friendlyError(error));
  }
}

init().catch((error) => render(String(error.message || error)));
