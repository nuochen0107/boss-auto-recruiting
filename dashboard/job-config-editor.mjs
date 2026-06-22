import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadJobsConfig } = require("../config/job-router.cjs");

function splitAliases(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,，]/);
  return values.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeJobKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeJobsPayload(payload = {}) {
  if (!Array.isArray(payload.jobs)) {
    const error = new Error("invalid_jobs_payload");
    error.statusCode = 422;
    throw error;
  }

  const jobs = payload.jobs.map((item, index) => {
    const displayName = String(item?.display_name || "").trim();
    const jobKey = normalizeJobKey(item?.job_key);
    if (!jobKey) {
      const error = new Error(`missing_job_key_at_index_${index}`);
      error.statusCode = 422;
      throw error;
    }
    if (!displayName) {
      const error = new Error(`missing_job_display_name:${jobKey}`);
      error.statusCode = 422;
      throw error;
    }

    const aliases = Array.from(new Set([displayName, ...splitAliases(item?.boss_job_names)]));
    const feishuJobId = String(item?.feishu_hire_job_id || "").trim();
    if (feishuJobId && !/^\d+$/.test(feishuJobId)) {
      const error = new Error(`invalid_feishu_job_id:${jobKey}`);
      error.statusCode = 422;
      throw error;
    }
    return {
      job_key: jobKey,
      display_name: displayName,
      boss_job_names: aliases,
      feishu_hire_job_id: feishuJobId,
      enabled: item?.enabled !== false,
    };
  });

  const keys = new Set();
  for (const job of jobs) {
    if (keys.has(job.job_key)) {
      const error = new Error(`duplicate_job_key:${job.job_key}`);
      error.statusCode = 422;
      throw error;
    }
    keys.add(job.job_key);
  }
  if (!jobs.some((job) => job.enabled)) {
    const error = new Error("no_enabled_jobs");
    error.statusCode = 422;
    throw error;
  }

  return {
    version: Math.max(1, Number(payload.version) || 1),
    jobs,
  };
}

export function readJobsForEditor(file) {
  return {
    ...loadJobsConfig(path.dirname(file), file),
    writable: true,
  };
}

export function writeJobsFromEditor(file, payload) {
  const normalized = normalizeJobsPayload(payload);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`);
  fs.renameSync(temp, file);
  return readJobsForEditor(file);
}
