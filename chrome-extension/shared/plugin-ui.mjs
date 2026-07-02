export const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";

export const STATUS_TEXT = {
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

export function normalizeServiceUrl(value) {
  const raw = String(value || DEFAULT_SERVICE_URL).trim().replace(/\/+$/, "");
  const url = new URL(raw);
  if (url.protocol !== "http:") throw new Error("本地服务地址必须使用 http://");
  return url.origin;
}

export function isActiveStatus(status) {
  return ["starting", "running", "pausing"].includes(status);
}

export function statusLabel(status) {
  return STATUS_TEXT[status] || status || "空闲";
}

export function statusClass(status) {
  if (status === "completed") return "ok";
  if (["starting", "running", "waiting", "pausing", "completed_partial"].includes(status)) return "warn";
  if (status === "failed") return "bad";
  return "";
}

export function friendlyError(error) {
  const raw = String(error?.message || error || "未知错误");
  if (/Failed to fetch|NetworkError|fetch/i.test(raw)) return "无法连接本地控制面板，请先打开 Boss招聘助手.app。";
  if (/pipeline_already_active|legacy_pipeline_lock/.test(raw)) return "已有日常流程正在运行，请先暂停或等待完成。";
  if (/run_already_active|run_lock_exists|runner_lock/.test(raw)) return "推荐页任务正在运行，请先暂停或等待完成。";
  if (/missing_feishu_job_route|no_feishu_job_routes_configured/.test(raw)) return "当前岗位没有飞书路由，只能执行 Boss 沟通和收简历。";
  if (/boss_login/.test(raw)) return "Boss 尚未登录，请在开启远程调试的 Chrome 中登录 Boss 直聘招聘端。";
  if (/captcha/.test(raw)) return "Boss 页面出现验证码，请先人工处理后再继续。";
  if (/platform_warning/.test(raw)) return "Boss 页面存在平台警告，请先人工处理后再继续。";
  return raw;
}

export function summarizeReport(report = {}) {
  const totals = report.totals || report.summary || {};
  const runs = Array.isArray(report.runs) ? report.runs.length : Number(report.run_count || 0);
  const greeted = Number(totals.greeted ?? totals.greeted_count ?? report.greeted ?? 0);
  const skipped = Number(totals.skipped ?? totals.skipped_count ?? report.skipped ?? 0);
  const failed = Number(totals.failed ?? totals.failed_count ?? report.failed ?? 0);
  const parts = [
    `${report.date || "今日"}：运行 ${runs} 次`,
    `已打招呼 ${greeted}`,
    `跳过 ${skipped}`,
    `失败 ${failed}`,
  ];
  return parts.join("，");
}
