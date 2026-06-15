const fs = require("fs");
const path = require("path");

function defaultJobsFile(projectRoot) {
  if (process.env.BOSS_JOBS_FILE) return path.resolve(process.env.BOSS_JOBS_FILE);
  if (process.env.BOSS_CONFIG_ROOT) return path.resolve(process.env.BOSS_CONFIG_ROOT, "jobs.json");
  return path.resolve(projectRoot, "config/jobs.json");
}

function normalizeJobText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·•・_\-—–（）()【】[\]]+/g, "");
}

function validateJob(job, index) {
  const jobKey = String(job?.job_key || "").trim();
  const displayName = String(job?.display_name || "").trim();
  const aliases = Array.isArray(job?.boss_job_names)
    ? job.boss_job_names.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(jobKey)) {
    throw new Error(`invalid_job_key_at_index_${index}`);
  }
  if (!displayName) throw new Error(`missing_job_display_name:${jobKey}`);
  if (!aliases.length) aliases.push(displayName);
  const feishuJobId = String(job?.feishu_hire_job_id || "").trim();
  if (feishuJobId && !/^\d+$/.test(feishuJobId)) {
    throw new Error(`invalid_feishu_job_id:${jobKey}`);
  }
  return {
    job_key: jobKey,
    display_name: displayName,
    boss_job_names: Array.from(new Set([displayName, ...aliases])),
    feishu_hire_job_id: feishuJobId,
    enabled: job?.enabled !== false,
  };
}

function loadJobsConfig(projectRoot, explicitFile = "") {
  const file = explicitFile ? path.resolve(explicitFile) : defaultJobsFile(projectRoot);
  if (!fs.existsSync(file)) throw new Error(`jobs_config_not_found:${file}`);
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(payload?.jobs)) throw new Error(`invalid_jobs_config:${file}`);
  const jobs = payload.jobs.map(validateJob);
  const keys = new Set();
  for (const job of jobs) {
    if (keys.has(job.job_key)) throw new Error(`duplicate_job_key:${job.job_key}`);
    keys.add(job.job_key);
  }
  return { version: Number(payload.version) || 1, file, jobs };
}

function enabledJobs(config) {
  return (config?.jobs || []).filter((job) => job.enabled);
}

function findJobByKey(config, jobKey) {
  return (config?.jobs || []).find((job) => job.job_key === jobKey) || null;
}

function matchJobFromText(config, text) {
  const normalizedText = normalizeJobText(text);
  if (!normalizedText) return { status: "unknown", job: null, matches: [] };
  const matches = [];
  for (const job of enabledJobs(config)) {
    const alias = job.boss_job_names
      .map((value) => ({ raw: value, normalized: normalizeJobText(value) }))
      .filter((value) => value.normalized && normalizedText.includes(value.normalized))
      .sort((a, b) => b.normalized.length - a.normalized.length)[0];
    if (alias) matches.push({ job, alias: alias.raw, length: alias.normalized.length });
  }
  matches.sort((a, b) => b.length - a.length);
  if (!matches.length) return { status: "unknown", job: null, matches: [] };
  if (matches.length > 1 && matches[0].length === matches[1].length) {
    return { status: "ambiguous", job: null, matches: matches.map((item) => item.job.job_key) };
  }
  return {
    status: "matched",
    job: matches[0].job,
    matched_alias: matches[0].alias,
    matches: matches.map((item) => item.job.job_key),
  };
}

module.exports = {
  defaultJobsFile,
  enabledJobs,
  findJobByKey,
  loadJobsConfig,
  matchJobFromText,
  normalizeJobText,
};
