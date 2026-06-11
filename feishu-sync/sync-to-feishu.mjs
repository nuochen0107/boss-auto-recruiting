#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const dataRoot = path.resolve(process.env.BOSS_DATA_ROOT || path.join(projectRoot, "data"));
const configRoot = process.env.BOSS_CONFIG_ROOT ? path.resolve(process.env.BOSS_CONFIG_ROOT) : "";
const upstream = path.join(__dirname, "uploader/upload-resumes.mjs");
const envFile = process.env.FEISHU_ENV_FILE ||
  (configRoot ? path.join(configRoot, "feishu.env") : path.join(__dirname, "uploader/.env.local"));
const bossConfigFile = process.env.BOSS_CONFIG_FILE || path.join(projectRoot, "boss-loop/assets/default-config.yaml");
const defaultResumeDir = path.join(dataRoot, "resumes");
const defaultManifestFile = path.join(dataRoot, "briefs/boss-auto-lightweight-loop-state.json");
const defaultStateFile = path.join(dataRoot, "briefs/feishu-hire-sync-state.json");
const argv = process.argv.slice(2);

function parseEnvFile(filePath) {
  if (!existsSync(filePath)) return {};

  const env = {};
  for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    const quote = value[0];
    if ((quote === `"` || quote === `'`) && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }
  return env;
}

function readYamlScalar(filePath, key) {
  if (!existsSync(filePath)) return "";
  const text = readFileSync(filePath, "utf8");
  const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function yamlConfigEnv(filePath) {
  const mappings = {
    FEISHU_APP_ID: "feishu_app_id",
    FEISHU_APP_SECRET: "feishu_app_secret",
    RESUME_DIR: "feishu_resume_dir",
    FEISHU_HIRE_UPLOAD_MODE: "feishu_hire_upload_mode",
    FEISHU_HIRE_JOB_ID: "feishu_hire_job_id",
    FEISHU_HIRE_RESUME_SOURCE_ID: "feishu_hire_resume_source_id",
    FEISHU_HIRE_TALENT_POOL_ID: "feishu_hire_talent_pool_id",
    FEISHU_HIRE_FOLDER_ID_LIST: "feishu_hire_folder_id_list",
    FEISHU_HIRE_PREFERRED_CITY_CODE: "feishu_hire_preferred_city_code",
    FEISHU_HIRE_DELIVERY_TYPE: "feishu_hire_delivery_type",
    FEISHU_HIRE_CREATOR_ACCOUNT_TYPE: "feishu_hire_creator_account_type",
    FEISHU_HIRE_CREATOR_ID: "feishu_hire_creator_id",
    FEISHU_HIRE_CREATE_NOTE: "feishu_hire_create_note",
    FEISHU_HIRE_NOTE_PRIVACY: "feishu_hire_note_privacy",
    FEISHU_HIRE_NOTE_PREFIX: "feishu_hire_note_prefix",
    FEISHU_HIRE_WEBSITE_ID: "feishu_hire_website_id",
    FEISHU_HIRE_JOB_POST_ID: "feishu_hire_job_post_id",
    FEISHU_HIRE_CHANNEL_ID: "feishu_hire_channel_id",
    FEISHU_HIRE_CANDIDATE_MANIFEST: "feishu_hire_candidate_manifest",
    FEISHU_HIRE_UPLOAD_STATE: "feishu_hire_upload_state",
    FEISHU_HIRE_ALLOW_DUPLICATE_NAMES: "feishu_hire_allow_duplicate_names",
  };
  const out = {};
  for (const [envKey, yamlKey] of Object.entries(mappings)) {
    const value = readYamlScalar(filePath, yamlKey);
    if (value) out[envKey] = value;
  }
  const sharedJobId = readYamlScalar(filePath, "job_id");
  if (sharedJobId && !out.FEISHU_HIRE_JOB_ID) out.FEISHU_HIRE_JOB_ID = sharedJobId;
  return out;
}

function parseManifestRecords(filePath) {
  const text = readFileSync(filePath, "utf8");
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed);
      if (Array.isArray(payload.candidates)) return payload.candidates;
      if (Array.isArray(payload.items)) return payload.items;
      if (Array.isArray(payload.records)) return payload.records;
      if (payload.candidates && typeof payload.candidates === "object") {
        return Object.values(payload.candidates);
      }
      if (payload.items && typeof payload.items === "object") {
        return Object.values(payload.items);
      }
      if (payload.records && typeof payload.records === "object") {
        return Object.values(payload.records);
      }
      return [payload];
    } catch {
      return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`Invalid JSONL line ${index + 1} in ${filePath}: ${error.message}`);
        }
      });
    }
  }

  return trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL line ${index + 1} in ${filePath}: ${error.message}`);
    }
  });
}

function isUnsignedInteger(value) {
  return typeof value === "string" && /^[0-9]+$/.test(value.trim());
}

function sanitizeManifest(filePath, resumeSourceId) {
  if (!filePath || !existsSync(filePath)) return filePath;

  const records = parseManifestRecords(filePath).filter((record) => record && typeof record === "object");
  if (!records.length) return filePath;

  let changed = false;
  const sanitized = records.map((record) => {
    const next = { ...record };
    const current = String(next.resume_source_id || "").trim();
    if (!isUnsignedInteger(current)) {
      if (!isUnsignedInteger(resumeSourceId)) {
        throw new Error(
          `Manifest has invalid resume_source_id "${current || "(empty)"}" and FEISHU_HIRE_RESUME_SOURCE_ID is not numeric`,
        );
      }
      next.resume_source_id = resumeSourceId.trim();
      changed = true;
    }
    return next;
  });

  if (!changed) return filePath;

  const dir = mkdtempSync(path.join(os.tmpdir(), "feishu-hire-sync-"));
  const sanitizedFile = path.join(dir, "manifest.jsonl");
  writeFileSync(sanitizedFile, `${sanitized.map((record) => JSON.stringify(record)).join("\n")}\n`);
  console.error(`INFO sanitized manifest resume_source_id -> ${resumeSourceId.trim()}: ${sanitizedFile}`);
  return sanitizedFile;
}

const envFromFile = parseEnvFile(envFile);
const envFromYaml = yamlConfigEnv(bossConfigFile);
const baseEnv = {
  ...envFromFile,
  ...envFromYaml,
  ...process.env,
};
const manifestFile = baseEnv.FEISHU_HIRE_SYNC_MANIFEST || defaultManifestFile;
const resumeSourceId = baseEnv.FEISHU_HIRE_RESUME_SOURCE_ID || "";
const sanitizedManifestFile = sanitizeManifest(manifestFile, resumeSourceId);

const env = {
  ...baseEnv,
  RESUME_DIR: baseEnv.FEISHU_HIRE_SYNC_RESUME_DIR || baseEnv.FEISHU_HIRE_RESUME_DIR || defaultResumeDir,
  FEISHU_HIRE_UPLOAD_MODE: baseEnv.FEISHU_HIRE_UPLOAD_MODE || "talent_application",
  FEISHU_HIRE_CANDIDATE_MANIFEST: sanitizedManifestFile,
  FEISHU_HIRE_UPLOAD_STATE:
    baseEnv.FEISHU_HIRE_SYNC_STATE_FILE ||
    baseEnv.FEISHU_HIRE_SYNC_STATE ||
    baseEnv.FEISHU_HIRE_UPLOAD_STATE ||
    defaultStateFile,
  FEISHU_HIRE_SYNC_STATE:
    baseEnv.FEISHU_HIRE_SYNC_STATE_FILE ||
    baseEnv.FEISHU_HIRE_SYNC_STATE ||
    baseEnv.FEISHU_HIRE_UPLOAD_STATE ||
    defaultStateFile,
};

const result = spawnSync(process.execPath, [upstream, ...argv], {
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else if (result.status !== null) {
  process.exitCode = result.status;
}
