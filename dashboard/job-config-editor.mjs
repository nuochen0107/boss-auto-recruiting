import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadJobsConfig } = require("../config/job-router.cjs");

function normalizeJobKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function hashJobName(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function jobKeyFromDisplayName(displayName, usedKeys) {
  const slug = normalizeJobKey(displayName);
  const hash = hashJobName(displayName);
  const base = slug ? `${slug}_${hash}` : `job_${hash}`;
  let key = base;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${base}_${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);
  return key;
}

export function extractFeishuHireJobId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    const jobId = parsed.searchParams.get("job_id");
    if (jobId && /^\d+$/.test(jobId)) return jobId;
    const pathMatch = parsed.pathname.match(/\/hire\/job\/(\d+)(?:\/|$)/);
    if (pathMatch) return pathMatch[1];
  } catch { /* fall through to regex fallback */ }
  const match = raw.match(/[?&]job_id=(\d+)(?:&|$)|\/hire\/job\/(\d+)(?:[/?#]|$)/);
  if (match) return match[1] || match[2];
  return raw;
}

export function normalizeJobsPayload(payload = {}) {
  if (!Array.isArray(payload.jobs)) {
    const error = new Error("invalid_jobs_payload");
    error.statusCode = 422;
    throw error;
  }

  const usedKeys = new Set();
  const jobs = payload.jobs.map((item, index) => {
    const displayName = String(item?.display_name || "").trim();
    if (!displayName) {
      const error = new Error(`missing_job_display_name_at_index_${index}`);
      error.statusCode = 422;
      throw error;
    }

    const jobKey = jobKeyFromDisplayName(displayName, usedKeys);
    const feishuJobId = extractFeishuHireJobId(item?.feishu_hire_job_id);
    if (feishuJobId && !/^\d+$/.test(feishuJobId)) {
      const error = new Error(`invalid_feishu_job_id:${jobKey}`);
      error.statusCode = 422;
      throw error;
    }
    return {
      job_key: jobKey,
      display_name: displayName,
      boss_job_names: [displayName],
      feishu_hire_job_id: feishuJobId,
      enabled: item?.enabled !== false,
    };
  });

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
