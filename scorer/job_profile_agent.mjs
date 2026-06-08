#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { callJsonLlm, hasConfiguredLlm, parseLlmJsonObject } from "./llm_config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, "config/job-profiles");
const REQUIRED = [
  "job_name", "city", "salary_range", "education_requirements",
  "experience_requirements", "must_have", "nice_to_have",
  "reject_conditions", "target_candidate_summary", "greeting_template",
  "score_threshold_default",
];

export function profilePath(profileId = "ai_app_intern") {
  if (!/^[a-z0-9_-]+$/i.test(profileId)) throw new Error("invalid_job_profile_id");
  return path.join(PROFILE_DIR, `${profileId}.json`);
}

export function validateJobProfile(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("job_profile_must_be_object");
  for (const key of REQUIRED) {
    if (!(key in value)) throw new Error(`job_profile_missing_${key}`);
  }
  for (const key of ["city", "education_requirements", "must_have", "nice_to_have", "reject_conditions"]) {
    if (!Array.isArray(value[key]) || value[key].some((item) => typeof item !== "string")) {
      throw new Error(`job_profile_invalid_${key}`);
    }
  }
  if (!Number.isFinite(Number(value.score_threshold_default)) ||
      Number(value.score_threshold_default) < 0 ||
      Number(value.score_threshold_default) > 100) {
    throw new Error("job_profile_invalid_score_threshold_default");
  }
  for (const key of ["job_name", "salary_range", "experience_requirements", "target_candidate_summary", "greeting_template"]) {
    if (typeof value[key] !== "string") throw new Error(`job_profile_invalid_${key}`);
  }
  return { ...value, score_threshold_default: Number(value.score_threshold_default) };
}

export function loadJobProfile(profileId = "ai_app_intern") {
  const file = profilePath(profileId);
  if (!fs.existsSync(file)) throw new Error("job_profile_not_found");
  return validateJobProfile(JSON.parse(fs.readFileSync(file, "utf8")));
}

export function saveJobProfile(profileId, profile) {
  const validated = validateJobProfile(profile);
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const file = profilePath(profileId);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(validated, null, 2)}\n`);
  fs.renameSync(temp, file);
  return { profile: validated, path: file };
}

export { hasConfiguredLlm };

export async function generateJobProfile({ profileId = "ai_app_intern", jd }) {
  if (!String(jd || "").trim()) throw new Error("jd_required");
  if (!hasConfiguredLlm()) {
    const error = new Error("llm_api_key_not_configured");
    error.statusCode = 422;
    throw error;
  }
  const prompt = `你是招聘岗位分析器。根据以下 JD 生成岗位画像。
只输出一个合法 JSON 对象，不要 Markdown，不要解释。
必须包含这些字段：${REQUIRED.join(", ")}。
数组字段必须是字符串数组；score_threshold_default 为 0-100 的数字。
岗位名称固定为“AI应用实习生”，默认阈值建议为 70。

JD:
${String(jd).slice(0, 16000)}`;
  const result = await callJsonLlm(prompt, { maxTokens: 3200 });
  const profile = validateJobProfile(parseLlmJsonObject(result.content));
  return { ...saveJobProfile(profileId, profile), provider: result.provider, model: result.model };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const jdIndex = process.argv.indexOf("--jd");
  const fileIndex = process.argv.indexOf("--jd-file");
  const jd = jdIndex >= 0
    ? process.argv[jdIndex + 1]
    : fileIndex >= 0
      ? fs.readFileSync(path.resolve(process.argv[fileIndex + 1]), "utf8")
      : "";
  generateJobProfile({ jd })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    });
}
