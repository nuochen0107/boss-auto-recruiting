const $ = (id) => document.getElementById(id);
let pollTimer = null;
let pipelinePollTimer = null;
let jobConfig = null;

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

function statusClass(status) {
  if (["completed"].includes(status)) return "status-success";
  if (["running", "starting"].includes(status)) return "status-running";
  if (["waiting", "pausing", "paused", "completed_partial"].includes(status)) return "status-warning";
  if (["failed"].includes(status)) return "status-danger";
  return "status-neutral";
}

const ERROR_MAP = [
  [/Failed to fetch|fetch failed|NetworkError/i, ["无法连接控制面板", "确认启动面板的终端仍在运行，然后刷新页面。"]],
  [/pipeline_already_active/, ["已有流程正在运行", "等待当前流程完成，或点击“暂停当前流程”。"]],
  [/run_already_active|run_lock_exists/, ["推荐页任务正在运行", "等待任务完成，或先暂停推荐页任务。"]],
  [/recommend_run_already_active/, ["推荐页任务占用中", "先暂停推荐页任务，再执行日常招聘流程。"]],
  [/legacy_boss_run_already_active|legacy_boss_run_active/, ["Boss 页面正在被其他任务使用", "等待当前任务结束，不要同时启动多个任务。"]],
  [/missing_feishu_job_routes?:([^\s]+)/, ["该岗位未配置飞书同步路由", "该岗位仍可执行 Boss 沟通和收简历；如需同步到飞书，请在岗位路由配置中填写 feishu_hire_job_id 后重启控制面板。"]],
  [/no_feishu_job_routes_configured/, ["没有可同步的飞书岗位", "当前选择范围内没有配置 feishu_hire_job_id 的岗位。Boss 沟通和收简历仍可单独执行。"]],
  [/invalid_job_key/, ["岗位配置已变化", "刷新页面后重新选择岗位。"]],
  [/hire:application|99991672/, ["飞书应用缺少投递权限", "在飞书开放平台为当前应用开通 hire:application，并发布新版本。"]],
  [/school mismatch/i, ["候选人资料需要人工确认", "飞书中已有同一候选人，但学校信息不同。请人工核对后再处理。"]],
  [/paused_boss_not_logged_in|paused_login_required/, ["Boss 登录已失效", "在已开启远程调试的 Chrome 中重新登录 Boss 直聘。"]],
  [/paused_chat_page_unavailable/, ["沟通页面未成功加载", "在远程调试 Chrome 中手动打开 Boss 沟通页，确认能看到候选人会话列表后重新执行。"]],
  [/paused_chat_targets_unavailable/, ["无法打开候选人会话", "Boss 沟通列表结构可能已变化。保留任务详情中的 open_chat 诊断并停止重试，避免误报执行成功。"]],
  [/paused_collect_targets_unavailable/, ["未能打开待收简历候选人", "系统已停止并保留 search_thread 诊断。确认搜索结果中能看到该姓名后重新执行。"]],
  [/paused_download_directory_unavailable/, ["无法设置简历下载目录", "检查浏览器连接服务和 Chrome 远程调试状态，然后重新执行收简历。"]],
  [/paused_consecutive_download_failures|download_button_not_found/, ["简历预览未加载出下载按钮", "保持 Boss 页面在前台，确认简历预览能够正常打开；系统会等待预览加载后再下载。"]],
  [/paused_no_sync_candidates/, ["没有可同步到飞书的简历", "先确认收简历任务显示 downloaded 和 queued 大于 0，再执行飞书同步。"]],
  [/paused_job_filter_required|paused_job_filter_unavailable|paused_job_filter_trigger_not_found|paused_job_filter_option_not_found|paused_job_filter_verification_failed/, ["Boss 岗位筛选失败", "确认沟通页顶部可看到“全部职位”并能展开岗位列表，然后重试。"]],
  [/search_result_job_mismatch/, ["搜索到同名候选人但岗位不匹配", "系统已跳过该候选人，请在任务详情中核对姓名和岗位。"]],
  [/paused_captcha_detected/, ["Boss 出现验证码", "请在 Chrome 中人工完成验证码，再重新执行。"]],
  [/paused_platform_warning/, ["Boss 出现平台警告", "请先人工处理平台提示，确认安全后再继续。"]],
  [/paused_recommend_job_selector_not_found|paused_recommend_job_option_not_found|paused_recommend_job_verification_failed/, ["推荐页岗位切换失败", "确认推荐牛人页中间偏右位置可以手动切换招聘职位，然后重新执行。"]],
  [/paused_recommend_prompt_not_closed|paused_post_greet_cleanup_failed/, ["推荐页弹窗未能关闭", "本次已发送的招呼已记录，系统会在发送下一条前暂停。请人工关闭弹窗后再重新执行。"]],
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
  const cdpCheck = (result.checks || []).find((check) => check.key === "cdp");
  if (cdpCheck) {
    $("chromeBadge").textContent = cdpCheck.ok ? "已连接" : "未连接";
    $("chromeBadge").className = `badge ${cdpCheck.ok ? "ok" : "bad"}`;
  }
  $("preflightChecks").innerHTML = (result.checks || []).map((check) => `
    <div class="check-card ${check.ok ? "ok" : "bad"}">
      <strong>${check.ok ? "正常" : "需要处理"} · ${escapeHtml(check.label || check.key)}</strong>
      <p>${escapeHtml(check.detail || "")}</p>
      ${check.guide ? `<p class="guide">解决方法：${escapeHtml(check.guide)}</p>` : ""}
    </div>
  `).join("") || '<div class="check-card bad"><strong>检查失败</strong><p>没有收到检查结果，请重启控制面板。</p></div>';
}

function renderJobs(result) {
  const jobs = result.jobs || [];
  const pipelineSelect = $("pipelineJobKey");
  const recommendSelect = $("jobId");
  pipelineSelect.replaceChildren(new Option("全部启用岗位", "all"));
  recommendSelect.replaceChildren();
  for (const job of jobs) {
    pipelineSelect.add(new Option(job.display_name, job.job_key));
    recommendSelect.add(new Option(job.display_name, job.job_key));
  }
  $("jobRoutes").innerHTML = jobs.map((job) => `
    <div class="route-card ${job.feishu_configured ? "" : "missing"}">
      <strong>${escapeHtml(job.display_name)}</strong>
      <span>Boss 别名：${escapeHtml(job.boss_job_names.join(" / "))}</span>
      <span>飞书同步：${job.feishu_configured ? escapeHtml(job.feishu_hire_job_id) : "未配置，同步时跳过"}</span>
    </div>
  `).join("") || '<div class="route-card missing"><strong>没有启用的岗位</strong></div>';
}

async function loadJobs() {
  try {
    renderJobs(await request("/api/jobs"));
  } catch (error) {
    $("jobRoutes").innerHTML = `<div class="route-card missing"><strong>${escapeHtml(friendlyError(error).title)}</strong></div>`;
  }
}

function normalizeJobKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function createJobDraft() {
  return {
    job_key: `job_${Date.now()}`,
    display_name: "",
    boss_job_names: [],
    feishu_hire_job_id: "",
    enabled: true,
  };
}

function renderJobConfig(config) {
  jobConfig = {
    version: config.version || 1,
    file: config.file || "",
    jobs: (config.jobs || []).map((job) => ({
      job_key: job.job_key || "",
      display_name: job.display_name || "",
      boss_job_names: Array.isArray(job.boss_job_names) ? job.boss_job_names : [],
      feishu_hire_job_id: job.feishu_hire_job_id || "",
      enabled: job.enabled !== false,
    })),
  };
  $("jobConfigFile").textContent = jobConfig.file ? `配置文件：${jobConfig.file}` : "配置文件未返回";
  $("jobConfigList").replaceChildren(...jobConfig.jobs.map((job, index) => jobEditorRow(job, index)));
}

function jobEditorRow(job, index) {
  const row = document.createElement("div");
  row.className = "job-editor";
  row.dataset.index = String(index);
  row.innerHTML = `
    <label class="field">岗位标识
      <input data-job-field="job_key" type="text" value="${escapeHtml(job.job_key)}" placeholder="product_operations">
      <small>英文、数字、下划线；保存后不要随意修改</small>
    </label>
    <label class="field">岗位名称
      <input data-job-field="display_name" type="text" value="${escapeHtml(job.display_name)}" placeholder="产品运营">
      <small>Dashboard 展示名称</small>
    </label>
    <label class="field">Boss 岗位别名
      <textarea data-job-field="boss_job_names" placeholder="每行一个 Boss 岗位名">${escapeHtml((job.boss_job_names || []).join("\n"))}</textarea>
      <small>Boss 页面实际显示的岗位名，每行一个</small>
    </label>
    <label class="field">飞书岗位 ID
      <input data-job-field="feishu_hire_job_id" type="text" value="${escapeHtml(job.feishu_hire_job_id)}" placeholder="可留空">
      <small>留空时只参与 Boss 流程，同步飞书会跳过</small>
    </label>
    <div>
      <label class="job-enabled">
        <input data-job-field="enabled" type="checkbox" ${job.enabled ? "checked" : ""}>
        启用
      </label>
      <button class="button danger-button job-remove-button" type="button" data-remove-job>停用</button>
    </div>
  `;
  row.querySelector('[data-job-field="display_name"]').addEventListener("input", (event) => {
    const keyInput = row.querySelector('[data-job-field="job_key"]');
    if (!keyInput.value.trim() || /^job_\d+$/.test(keyInput.value.trim())) {
      keyInput.value = normalizeJobKey(event.target.value) || keyInput.value;
    }
  });
  row.querySelector("[data-remove-job]").addEventListener("click", () => {
    row.querySelector('[data-job-field="enabled"]').checked = false;
    row.classList.add("disabled");
  });
  return row;
}

async function loadJobConfig() {
  try {
    const config = await request("/api/jobs/config");
    renderJobConfig(config);
  } catch (error) {
    showError("jobConfigNotice", error);
  }
}

function collectJobConfig() {
  const jobs = [...document.querySelectorAll(".job-editor")].map((row) => ({
    job_key: normalizeJobKey(row.querySelector('[data-job-field="job_key"]').value),
    display_name: row.querySelector('[data-job-field="display_name"]').value.trim(),
    boss_job_names: row.querySelector('[data-job-field="boss_job_names"]').value
      .split(/[\n,，]/)
      .map((item) => item.trim())
      .filter(Boolean),
    feishu_hire_job_id: row.querySelector('[data-job-field="feishu_hire_job_id"]').value.trim(),
    enabled: row.querySelector('[data-job-field="enabled"]').checked,
  }));
  const seen = new Set();
  for (const job of jobs) {
    if (!job.job_key) throw new Error("岗位标识不能为空");
    if (!job.display_name) throw new Error(`岗位名称不能为空：${job.job_key}`);
    if (seen.has(job.job_key)) throw new Error(`岗位标识重复：${job.job_key}`);
    seen.add(job.job_key);
    if (job.feishu_hire_job_id && !/^\d+$/.test(job.feishu_hire_job_id)) {
      throw new Error(`飞书岗位 ID 必须是纯数字：${job.display_name}`);
    }
  }
  if (!jobs.some((job) => job.enabled)) throw new Error("至少需要启用一个岗位");
  return { version: jobConfig?.version || 1, jobs };
}

async function saveJobConfig() {
  try {
    $("saveJobsBtn").disabled = true;
    const payload = collectJobConfig();
    const saved = await request("/api/jobs/config", { method: "POST", body: JSON.stringify(payload) });
    renderJobConfig(saved);
    renderJobs(saved.public || await request("/api/jobs"));
    showNotice("jobConfigNotice", "岗位配置已保存", "ok", "岗位下拉框和路由卡片已刷新。");
  } catch (error) {
    showError("jobConfigNotice", error);
  } finally {
    $("saveJobsBtn").disabled = false;
  }
}

function currentMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function renderState(state) {
  const counters = state.counters || {};
  $("status").textContent = STATUS_TEXT[state.status] || state.status || "空闲";
  $("status").className = `metric-status ${statusClass(state.status)}`;
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
  $("pipelineStatus").className = `status-value ${statusClass(state.status)}`;
  $("pipelineStage").textContent = state.current_stage_label || "-";
  $("pipelineProgress").textContent = `${completed} / ${stages.length}`;
  $("pipelineDetails").textContent = JSON.stringify(state, null, 2);
  const manualReviewPanel = $("manualReviewPanel");
  manualReviewPanel.hidden = true;
  manualReviewPanel.replaceChildren();
  for (const button of document.querySelectorAll(".pipeline-start")) button.disabled = isActive;

  if (state.status === "failed" && state.error) showError("pipelineNotice", state.error);
  else if (state.status === "completed_partial") {
    const partialStage = stages.find((stage) => stage.status === "completed_partial");
    const result = partialStage?.result || {};
    const detail = [
      Number.isFinite(result.attempted) ? `本次处理 ${result.attempted} 人` : "",
      Number.isFinite(result.uploaded_this_run) ? `成功上传 ${result.uploaded_this_run} 人` : "",
      Number.isFinite(result.manual_review_this_run) ? `需人工确认 ${result.manual_review_this_run} 人` : "",
      Number.isFinite(result.failed_this_run) ? `失败 ${result.failed_this_run} 人` : "",
      Number.isFinite(result.deleted_after_success) && result.deleted_after_success > 0
        ? `已清理本地简历 ${result.deleted_after_success} 份`
        : "",
    ].filter(Boolean).join("，");
    showNotice(
      "pipelineNotice",
      "流程已完成，但有候选人需要人工确认",
      "",
      detail || "展开任务详情查看具体记录。"
    );
    const reviews = Array.isArray(result.manual_review_details) ? result.manual_review_details : [];
    if (reviews.length) {
      manualReviewPanel.hidden = false;
      manualReviewPanel.innerHTML = reviews.map((review) => {
        const reason = review.reason_code === "existing_talent_name_mismatch"
          ? `姓名冲突：Boss/简历为“${escapeHtml(review.expected_name || review.name)}”，飞书已有档案为“${escapeHtml(review.actual_name || "未知")}”`
          : review.reason_code === "existing_talent_school_mismatch"
            ? `学校冲突：候选人学校与飞书已有档案不一致`
            : escapeHtml(review.error || "身份信息需要核对");
        const talentHint = review.talent_id ? `飞书人才 ID：${escapeHtml(review.talent_id)}` : "飞书人才 ID 未返回";
        return `<article class="manual-review-card">
          <strong>${escapeHtml(review.name || "未知候选人")}</strong>
          <p>${reason}</p>
          <p>${talentHint}</p>
          <ol>
            <li>在飞书招聘的人才库中搜索该人才 ID，或分别搜索两个姓名。</li>
            <li>打开本地文件“${escapeHtml(review.file || "")}”，核对姓名、手机号、邮箱和学校。</li>
            <li>若是同一人，在飞书修正人才姓名后重新同步；若不是同一人，检查简历联系方式是否误识别或被他人复用。</li>
          </ol>
        </article>`;
      }).join("");
    }
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

$("shutdownBtn").addEventListener("click", async () => {
  if (!window.confirm("确认退出 Boss 招聘助手？正在运行的面板服务会关闭，Chrome 和 Boss 页面不会被关闭。")) return;
  try {
    $("shutdownBtn").disabled = true;
    await request("/api/app/shutdown", { method: "POST", body: "{}" });
    showNotice("pipelineNotice", "Boss 招聘助手正在退出", "ok", "服务关闭后本页面将无法继续刷新；需要使用时重新打开 App。");
    $("serviceBadge").textContent = "正在退出";
    $("serviceBadge").className = "badge neutral";
  } catch (error) {
    $("shutdownBtn").disabled = false;
    showError("pipelineNotice", error);
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
    const jobKey = $("pipelineJobKey").value;
    const chatLimit = Math.max(1, Math.min(200, Number($("chatLimit").value) || 20));
    const collectLimit = Math.max(1, Math.min(200, Number($("collectLimit").value) || 50));
    const syncLimit = Math.max(1, Math.min(50, Number($("syncLimit").value) || 1));
    const deleteUploadedResumes = $("deleteUploadedResumes").checked;
    const labels = {
      chat: "处理沟通页",
      collect: "全局搜索并收取简历",
      front: "沟通并收简历",
      sync: "同步飞书招聘",
      full: "逐岗位沟通，再全局收简历并同步飞书",
    };
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
          jobKey,
          syncLimit,
          deleteUploadedResumes,
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

$("cleanupUploadedResumesBtn").addEventListener("click", async () => {
  if (!window.confirm("这会扫描全部历史同步记录，并删除所有已确认创建人才和投递记录的本地简历；不只限于本次任务。人工确认、失败和未上传文件会保留。确认清理全部历史文件？")) return;
  try {
    const result = await request("/api/resumes/cleanup-uploaded", { method: "POST", body: "{}" });
    const mb = (Number(result.bytes_freed || 0) / 1024 / 1024).toFixed(1);
    showNotice("pipelineNotice", `已清理 ${result.deleted || 0} 份本地简历`, "ok", `释放约 ${mb} MB；人工确认和失败文件已保留。`);
  } catch (error) {
    showError("pipelineNotice", error);
  }
});

$("pipelineStatusBtn").addEventListener("click", () => loadPipelineState());
$("toggleJobConfigBtn").addEventListener("click", async () => {
  const panel = $("jobConfigPanel");
  panel.hidden = !panel.hidden;
  $("toggleJobConfigBtn").textContent = panel.hidden ? "编辑岗位配置" : "收起岗位配置";
  if (!panel.hidden && !jobConfig) await loadJobConfig();
});
$("addJobBtn").addEventListener("click", () => {
  if (!jobConfig) jobConfig = { version: 1, jobs: [] };
  jobConfig.jobs.push(createJobDraft());
  renderJobConfig(jobConfig);
});
$("saveJobsBtn").addEventListener("click", saveJobConfig);

await Promise.all([health(), loadJobs(), loadState(true), loadPipelineState(true)]);
