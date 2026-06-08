#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const FEISHU_API = "https://open.feishu.cn/open-apis";
const DEFAULT_RESUME_DIR = "/Users/apple/boss-auto-recruiting/data/resumes";
const DEFAULT_STATE_FILE = "/Users/apple/boss-auto-recruiting/data/briefs/feishu-hire-sync-state.json";
const CONTACT_EXTRACTOR = "/Users/apple/boss-auto-recruiting/feishu-sync/uploader/scripts/extract_resume_contacts.py";
const RESUME_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".rtf", ".wps"]);

class FeishuApiError extends Error {
  constructor(message, { status, body, logId }) {
    super(message);
    this.name = "FeishuApiError";
    this.status = status;
    this.body = body;
    this.logId = logId;
  }
}

class ManualReviewRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = "ManualReviewRequiredError";
  }
}

function parseArgs(argv) {
  const args = {
    apply: false,
    dir: process.env.RESUME_DIR || DEFAULT_RESUME_DIR,
    state: process.env.FEISHU_HIRE_UPLOAD_STATE || DEFAULT_STATE_FILE,
    manifest: process.env.FEISHU_HIRE_CANDIDATE_MANIFEST || "",
    mode: process.env.FEISHU_HIRE_UPLOAD_MODE || "talent_application",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--dir") args.dir = argv[++i];
    else if (arg === "--state") args.state = argv[++i];
    else if (arg === "--manifest") args.manifest = argv[++i];
    else if (arg === "--mode") args.mode = argv[++i];
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  node upload-resumes.mjs [--dry-run] [--apply] [--dir DIR] [--manifest FILE]

Modes:
  talent_application Upload resume, create or reuse talent, create job application.
  talent_enrich      Read local resume text and patch an existing talent with parsed contacts.
  website_attachment  Upload resume file, create website user, create delivery task.
  talent_basic        Upload resume file and create a basic talent record.

Required environment:
  FEISHU_APP_ID
  FEISHU_APP_SECRET

talent_application mode also requires:
  FEISHU_HIRE_JOB_ID

Optional for talent_application mode:
  FEISHU_HIRE_RESUME_SOURCE_ID
  FEISHU_HIRE_TALENT_POOL_ID
  FEISHU_HIRE_FOLDER_ID_LIST
  FEISHU_HIRE_PREFERRED_CITY_CODE
  FEISHU_HIRE_DELIVERY_TYPE

Optional environment:
  FEISHU_HIRE_CHANNEL_ID
  FEISHU_HIRE_WEBSITE_ID
  FEISHU_HIRE_JOB_POST_ID
  FEISHU_HIRE_CANDIDATE_MANIFEST

Manifest support:
  JSON array, JSON object with a candidates/items/records array, or JSONL.
  Prefer stable keys like candidate_id and external_id.
  Boss upstream is expected to provide raw summaries plus local resume paths, not structured education/work arrays.
`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optionalCsv(value) {
  if (!value) return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeLookupKey(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFC").trim();
}

function normalizeIdentityText(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(/\s+/g, "").trim().toLowerCase();
}

function normalizeIdentificationType(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") return value;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  if (text === "ID_CARD" || text === "CN_ID_CARD") return 1;
  if (text === "PASSPORT") return 2;
  return text;
}

function isDebugEnabled() {
  return process.env.FEISHU_HIRE_DEBUG === "1";
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function listResumeFiles(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      files.push(...await listResumeFiles(fullPath));
    } else if (entry.isFile() && RESUME_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(fullPath);
    }
  }

  return files.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function inferCandidateName(filePath) {
  const parsed = path.parse(filePath);
  return parsed.name
    .replace(/^(简历|个人简历)[-_ ]*/i, "")
    .replace(/^【[^】]+】/, "")
    .replace(/\s+\d{2}年应届生$/, "")
    .replace(/\s+\d+年经验$/, "")
    .trim();
}

async function loadManifest(filePath) {
  if (!filePath) return new Map();

  const text = await fs.readFile(filePath, "utf8");
  const trimmed = text.trim();
  let records;
  if (!trimmed) {
    records = [];
  } else if (trimmed.startsWith("[")) {
    records = JSON.parse(trimmed);
  } else if (trimmed.startsWith("{")) {
    try {
      const payload = JSON.parse(trimmed);
      const groupedRecords = payload.candidates || payload.items || payload.records || null;
      if (Array.isArray(groupedRecords)) {
        records = groupedRecords;
      } else if (groupedRecords && typeof groupedRecords === "object") {
        records = Object.values(groupedRecords);
      } else if (payload && typeof payload === "object") {
        records = [payload];
      } else {
        throw new Error(`Manifest object must contain an array under candidates/items/records: ${filePath}`);
      }
    } catch (error) {
      records = trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (lineError) {
          throw new Error(`Invalid JSONL line ${index + 1} in ${filePath}: ${lineError.message}`);
        }
      });
    }
  } else {
    records = trimmed.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL line ${index + 1} in ${filePath}: ${error.message}`);
      }
    });
  }

  const map = new Map();
  for (const record of records) {
    if (!record || typeof record !== "object") continue;
    const keys = [
      record.file,
      record.filename,
      record.local_resume_path,
      record.resume_path,
      record.resume_hash,
      record.candidate_id,
      record.external_id,
      record.candidate_uid,
      record.boss_candidate_uid,
      record.name,
    ]
      .filter(Boolean)
      .flatMap((value) => {
        if (typeof value !== "string") return [];
        return [value, path.basename(value)];
      });

    for (const key of keys) {
      const normalizedKey = normalizeLookupKey(key);
      if (normalizedKey) map.set(normalizedKey, record);
    }
  }
  return map;
}

function findManifestRecord(manifest, filePath, resumeHash = "") {
  const inferredName = inferCandidateName(filePath);
  return manifest.get(normalizeLookupKey(resumeHash))
    || manifest.get(normalizeLookupKey(path.basename(filePath)))
    || manifest.get(normalizeLookupKey(filePath))
    || manifest.get(normalizeLookupKey(inferredName))
    || {};
}

function getManifestIdentity(meta) {
  return meta.candidate_id || meta.external_id || meta.candidate_uid || meta.boss_candidate_uid || meta.name || "";
}

function isManifestRecordEligible(record) {
  if (!record || !Object.keys(record).length) return false;
  if (record.sync_target && record.sync_target !== "feishu_hire") return false;
  const eligibleStatuses = new Set(["resume_downloaded", "ready_for_hire_sync", "boss_completed"]);
  const statuses = [record.boss_status, record.status].filter(Boolean);
  if (statuses.length && !statuses.some((status) => eligibleStatuses.has(status))) return false;
  return true;
}

async function selectFilesForUpload(files, manifest) {
  if (process.env.FEISHU_HIRE_ALLOW_DUPLICATE_NAMES === "1") return files;

  const byName = new Map();
  for (const filePath of files) {
    const manifestRecord = findManifestRecord(manifest, filePath);
    if (isDebugEnabled()) {
      console.error(JSON.stringify({
        debug: "select_files",
        file: path.basename(filePath),
        manifest_size: manifest.size,
        manifest_record_keys: Object.keys(manifestRecord || {}),
      }));
    }
    if (manifest.size > 0) {
      if (!Object.keys(manifestRecord).length) {
        console.log(`SKIP no manifest record for ${path.basename(filePath)}`);
        continue;
      }
      if (!isManifestRecordEligible(manifestRecord)) {
        console.log(`SKIP manifest not eligible for ${path.basename(filePath)}`);
        continue;
      }
    }
    const meta = findCandidateMeta(manifest, filePath);
    const stat = await fs.stat(filePath);
    const identity = normalizeLookupKey(getManifestIdentity(meta)) || normalizeLookupKey(filePath);
    const current = byName.get(identity);
    if (!current || stat.mtimeMs > current.mtimeMs) {
      byName.set(identity, { filePath, mtimeMs: stat.mtimeMs, duplicates: current ? current.duplicates + 1 : 1 });
    } else {
      current.duplicates += 1;
    }
  }

  const selected = [];
  for (const [identity, item] of byName.entries()) {
    if (item.duplicates > 1) {
      console.log(`WARN duplicate candidate "${identity}", keeping newest file: ${path.basename(item.filePath)}`);
    }
    selected.push(item.filePath);
  }

  return selected.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function findCandidateMeta(manifest, filePath, resumeHash = "") {
  const inferredName = inferCandidateName(filePath);
  const fromManifest = findManifestRecord(manifest, filePath, resumeHash);
  const preferredCityCodeList = fromManifest.application_preferred_city_code_list
    || fromManifest.preferred_city_code_list
    || optionalCsv(process.env.FEISHU_HIRE_PREFERRED_CITY_CODE);

  return {
    name: fromManifest.name || inferredName,
    school: fromManifest.school || "",
    candidate_id: fromManifest.candidate_id || "",
    candidate_uid: fromManifest.candidate_uid || fromManifest.external_id || "",
    boss_candidate_uid: fromManifest.boss_candidate_uid || "",
    local_resume_path: fromManifest.local_resume_path || fromManifest.resume_path || filePath,
    email: fromManifest.email || "",
    mobile: fromManifest.mobile || "",
    mobile_code: fromManifest.mobile_code || "86",
    mobile_country_code: fromManifest.mobile_country_code || "CN_1",
    external_id: fromManifest.external_id || fromManifest.candidate_id || `boss-resume:${path.basename(filePath, path.extname(filePath))}`,
    identification: fromManifest.identification,
    education_list: fromManifest.education_list,
    career_list: fromManifest.career_list,
    basic_info: fromManifest.basic_info,
    project_list: fromManifest.project_list,
    works_list: fromManifest.works_list,
    award_list: fromManifest.award_list,
    language_list: fromManifest.language_list,
    sns_list: fromManifest.sns_list,
    self_evaluation: fromManifest.self_evaluation,
    customized_data: fromManifest.customized_data,
    creator_id: fromManifest.creator_id || process.env.FEISHU_HIRE_CREATOR_ID || "",
    creator_account_type: fromManifest.creator_account_type || Number(process.env.FEISHU_HIRE_CREATOR_ACCOUNT_TYPE || 3),
    job_id: fromManifest.job_id || process.env.FEISHU_HIRE_JOB_ID || "",
    talent_pool_id: fromManifest.talent_pool_id || process.env.FEISHU_HIRE_TALENT_POOL_ID || "",
    folder_id_list: fromManifest.folder_id_list || optionalCsv(process.env.FEISHU_HIRE_FOLDER_ID_LIST),
    application_preferred_city_code_list: preferredCityCodeList,
    delivery_type: fromManifest.delivery_type || Number(process.env.FEISHU_HIRE_DELIVERY_TYPE || 1),
    resume_source_id: fromManifest.resume_source_id || process.env.FEISHU_HIRE_RESUME_SOURCE_ID || "",
  };
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const logId = response.headers.get("x-tt-logid") || response.headers.get("x-request-id") || "";
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok || (typeof body.code === "number" && body.code !== 0)) {
    const logHint = logId ? ` X-Tt-Logid=${logId}` : "";
    throw new FeishuApiError(`Feishu API failed ${response.status}:${logHint} ${JSON.stringify(body)}`, {
      status: response.status,
      body,
      logId,
    });
  }

  return body;
}

function extractTalentProfile(rawData) {
  const data = rawData?.talent || rawData || {};
  const basicInfo = data.basic_info || rawData?.basic_info || {};
  const educationList = data.education_list || rawData?.education_list || [];
  const schools = educationList
    .flatMap((item) => [item?.school, item?.school_name, item?.college_name])
    .filter(Boolean);

  return {
    raw: data,
    name: basicInfo.name || data.name || "",
    schools: Array.from(new Set(schools)),
  };
}

async function getTalentDetail(token, talentId) {
  const body = await requestJson(`${FEISHU_API}/hire/v1/talents/${talentId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
  });

  return extractTalentProfile(body.data || {});
}

async function ensureSafeTalentReuse(token, talentId, meta) {
  if (!meta.name && !meta.school) return;

  const talent = await getTalentDetail(token, talentId);
  const expectedName = normalizeIdentityText(meta.name);
  const actualName = normalizeIdentityText(talent.name);
  if (expectedName && (!actualName || actualName !== expectedName)) {
    throw new ManualReviewRequiredError(
      `Existing talent ${talentId} name mismatch: expected "${meta.name}", got "${talent.name || "unknown"}"`,
    );
  }

  const expectedSchool = normalizeIdentityText(meta.school);
  if (!expectedSchool) return;

  const actualSchools = talent.schools.map((item) => normalizeIdentityText(item)).filter(Boolean);
  if (!actualSchools.length || !actualSchools.includes(expectedSchool)) {
    throw new ManualReviewRequiredError(
      `Existing talent ${talentId} school mismatch: expected "${meta.school}", got "${talent.schools.join(" / ") || "unknown"}"`,
    );
  }
}

async function getTenantAccessToken() {
  const body = await requestJson(`${FEISHU_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      app_id: requireEnv("FEISHU_APP_ID"),
      app_secret: requireEnv("FEISHU_APP_SECRET"),
    }),
  });

  return body.tenant_access_token;
}

async function uploadAttachment(token, filePath) {
  const file = await fs.readFile(filePath);
  const form = new FormData();
  form.append("content", new Blob([file]), path.basename(filePath));

  const body = await requestJson(`${FEISHU_API}/hire/v1/attachments`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });

  return body.data;
}

async function createWebsiteUser(token, websiteId, meta) {
  const payload = {
    external_id: meta.external_id,
    name: meta.name,
  };
  if (meta.email) payload.email = meta.email;
  if (meta.mobile) {
    payload.mobile = meta.mobile;
    payload.mobile_country_code = meta.mobile_country_code || "CN_1";
  }

  const body = await requestJson(`${FEISHU_API}/hire/v1/websites/${websiteId}/site_users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  return body.data.site_user;
}

async function createDeliveryByAttachment(token, websiteId, meta, siteUser, attachmentId) {
  const payload = {
    job_post_id: requireEnv("FEISHU_HIRE_JOB_POST_ID"),
    user_id: siteUser.user_id,
    resume_file_id: attachmentId,
  };

  if (process.env.FEISHU_HIRE_CHANNEL_ID) payload.channel_id = process.env.FEISHU_HIRE_CHANNEL_ID;
  if (process.env.FEISHU_HIRE_PREFERRED_CITY_CODE) {
    payload.application_preferred_city_code_list = [process.env.FEISHU_HIRE_PREFERRED_CITY_CODE];
  }
  if (meta.email) payload.email = meta.email;
  if (meta.mobile) {
    payload.mobile = meta.mobile;
    payload.mobile_country_code = "+86";
  }
  if (meta.identification) payload.identification = meta.identification;

  const body = await requestJson(`${FEISHU_API}/hire/v1/websites/${websiteId}/deliveries/create_by_attachment`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  return body.data.task_id;
}

async function pollDeliveryTask(token, websiteId, taskId) {
  const url = `${FEISHU_API}/hire/v1/websites/${websiteId}/delivery_tasks/${taskId}`;
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    const body = await requestJson(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (body.data && typeof body.data.status === "number") {
      if (body.data.status === 2) return body.data;
      if (body.data.status === 3) {
        throw new Error(`Delivery task failed: ${body.data.status_msg || "unknown error"} ${body.data.extra_info || ""}`);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(`Delivery task timeout: ${taskId}`);
}

async function createBasicTalent(token, meta, attachmentId) {
  const payload = {
    resume_attachment_id: attachmentId,
    basic_info: {
      name: meta.name,
    },
  };
  if (meta.folder_id_list?.length) payload.folder_id_list = meta.folder_id_list;
  if (meta.creator_id) payload.creator_id = meta.creator_id;
  if (meta.creator_account_type) payload.creator_account_type = meta.creator_account_type;
  if (meta.resume_source_id) payload.resume_source_id = meta.resume_source_id;
  if (meta.basic_info) payload.basic_info = { ...payload.basic_info, ...meta.basic_info };
  if (meta.email) payload.basic_info.email = meta.email;
  if (meta.mobile) {
    payload.basic_info.mobile = meta.mobile;
    payload.basic_info.mobile_country_code = meta.mobile_country_code || "CN_1";
  }
  if (meta.identification) payload.basic_info.identification = meta.identification;
  if (meta.education_list?.length) payload.education_list = meta.education_list;
  if (meta.career_list?.length) payload.career_list = meta.career_list;
  if (meta.project_list) payload.project_list = meta.project_list;
  if (meta.works_list) payload.works_list = meta.works_list;
  if (meta.award_list) payload.award_list = meta.award_list;
  if (meta.language_list) payload.language_list = meta.language_list;
  if (meta.sns_list) payload.sns_list = meta.sns_list;
  if (meta.self_evaluation) payload.self_evaluation = meta.self_evaluation;
  if (meta.customized_data) payload.customized_data = meta.customized_data;
  if (meta.application_preferred_city_code_list?.length) {
    payload.preferred_city_code_list = meta.application_preferred_city_code_list;
  }

  const body = await requestJson(`${FEISHU_API}/hire/v1/talents/combined_create`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  return body.data;
}

function parseExtractorResult(stdout, filePath) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`Empty contact extractor output for ${path.basename(filePath)}`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid contact extractor JSON for ${path.basename(filePath)}: ${error.message}`);
  }
}

function extractContactsFromResume(filePath) {
  const result = spawnSync("python3", [CONTACT_EXTRACTOR, filePath], {
    encoding: "utf8",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    throw new Error(`Resume contact extraction failed for ${path.basename(filePath)}: ${stderr || `exit ${result.status}`}`);
  }

  return parseExtractorResult(result.stdout || "", filePath);
}

function mergeExtractedContacts(meta, extracted) {
  const contact = {
    mobile: extracted.mobile || meta.mobile || "",
    mobile_country_code: extracted.mobile_country_code || meta.mobile_country_code || "CN_1",
    email: extracted.email || meta.email || "",
    identification_type: extracted.identification_type || meta.identification?.identification_type || "",
    identification_number: extracted.identification_number || meta.identification?.identification_number || "",
  };

  const hasContact = contact.mobile || contact.email || contact.identification_number;
  return { contact, hasContact };
}

function normalizeResumeMeta(meta, extracted) {
  if (!extracted) return meta;

  const contact = mergeExtractedContacts(meta, extracted).contact;
  return {
    ...meta,
    mobile: contact.mobile || meta.mobile || "",
    mobile_country_code: contact.mobile_country_code || meta.mobile_country_code || "CN_1",
    email: contact.email || meta.email || "",
    identification: contact.identification_number
      ? {
          identification_type: normalizeIdentificationType(contact.identification_type || meta.identification?.identification_type || 1),
          identification_number: contact.identification_number,
        }
      : meta.identification,
    education_list: extracted.education_list?.length ? extracted.education_list : meta.education_list,
    career_list: extracted.career_list?.length ? extracted.career_list : meta.career_list,
    project_list: extracted.project_list?.length ? extracted.project_list : meta.project_list,
    self_evaluation: extracted.self_evaluation || meta.self_evaluation,
  };
}

function extractedResumeSnapshot(meta, extracted) {
  if (!extracted) return null;
  const snapshot = {
    education_list: meta.education_list || [],
    career_list: meta.career_list || [],
    project_list: meta.project_list || [],
    self_evaluation: meta.self_evaluation || null,
  };
  if (extracted.parser_mode) snapshot.parser_mode = extracted.parser_mode;
  if (extracted.ocr_status) snapshot.ocr_status = extracted.ocr_status;
  if (typeof extracted.text_length === "number") snapshot.text_length = extracted.text_length;
  if (extracted.resume_structured) snapshot.resume_structured = extracted.resume_structured;
  return snapshot;
}

async function findExistingTalentId(token, meta) {
  const lookups = [];
  if (meta.mobile) {
    lookups.push({
      mobile_code: meta.mobile_code || "86",
      mobile_number_list: [meta.mobile],
    });
  }
  if (meta.email) lookups.push({ email_list: [meta.email] });
  if (meta.identification?.identification_number && meta.identification?.identification_type) {
    lookups.push({
      identification_type: meta.identification.identification_type,
      identification_number_list: [meta.identification.identification_number],
    });
  }

  for (const payload of lookups) {
    const body = await requestJson(`${FEISHU_API}/hire/v1/talents/batch_get_id`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });

    const talent = body.data?.talent_list?.[0];
    if (talent?.talent_id) return talent.talent_id;
  }

  return "";
}

async function updateExistingTalent(token, talentId, meta, attachmentId, extracted) {
  const { contact, hasContact } = mergeExtractedContacts(meta, extracted);
  if (!hasContact) {
    throw new Error(`No contact fields found for ${meta.name}`);
  }

  const payload = {
    talent_id: talentId,
    resume_attachment_id: attachmentId,
    basic_info: {
      name: meta.name,
    },
  };

  if (meta.creator_id) payload.creator_id = meta.creator_id;
  if (meta.creator_account_type) payload.creator_account_type = meta.creator_account_type;
  if (meta.resume_source_id) payload.resume_source_id = meta.resume_source_id;
  if (meta.folder_id_list?.length) payload.folder_id_list = meta.folder_id_list;
  if (meta.basic_info) payload.basic_info = { ...payload.basic_info, ...meta.basic_info };
  if (contact.mobile) {
    payload.basic_info.mobile = contact.mobile;
    payload.basic_info.mobile_country_code = contact.mobile_country_code || "CN_1";
  }
  if (contact.email) payload.basic_info.email = contact.email;
  if (contact.identification_number) {
    payload.basic_info.identification = {
      identification_type: normalizeIdentificationType(contact.identification_type || 1),
      identification_number: contact.identification_number,
    };
  }
  if (meta.education_list?.length) payload.education_list = meta.education_list;
  if (meta.career_list?.length) payload.career_list = meta.career_list;
  if (meta.project_list) payload.project_list = meta.project_list;
  if (meta.works_list) payload.works_list = meta.works_list;
  if (meta.award_list) payload.award_list = meta.award_list;
  if (meta.language_list) payload.language_list = meta.language_list;
  if (meta.sns_list) payload.sns_list = meta.sns_list;
  if (meta.self_evaluation) payload.self_evaluation = meta.self_evaluation;
  if (meta.customized_data) payload.customized_data = meta.customized_data;
  if (meta.application_preferred_city_code_list?.length) {
    payload.preferred_city_code_list = meta.application_preferred_city_code_list;
  }

  const body = await requestJson(`${FEISHU_API}/hire/v1/talents/combined_update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  return { data: body.data, contact };
}

async function createOrReuseTalent(token, meta, attachmentId) {
  const existingTalentId = await findExistingTalentId(token, meta);
  if (existingTalentId) {
    return { talent_id: existingTalentId, reused: true };
  }

  const created = await createBasicTalent(token, meta, attachmentId);
  return { talent_id: created.talent_id, reused: false, raw: created };
}

function buildStateIndex(state) {
  const index = new Map();
  for (const item of Object.values(state.files || {})) {
    if (!item || item.status !== "success") continue;
    const keys = [
      item.candidate_id,
      item.external_id,
      item.candidate_uid,
      item.boss_candidate_uid,
      item.name,
      item.file,
      item.attachment_id,
      item.resume_hash,
    ].filter(Boolean);
    for (const key of keys) {
      const normalizedKey = normalizeLookupKey(key);
      if (normalizedKey && !index.has(normalizedKey)) index.set(normalizedKey, item);
    }
  }
  return index;
}

async function createApplication(token, talentId, meta) {
  if (!meta.job_id) throw new Error("Missing FEISHU_HIRE_JOB_ID or manifest job_id for talent_application mode");

  const payload = {
    talent_id: talentId,
    job_id: meta.job_id,
    delivery_type: meta.delivery_type || 1,
  };

  if (meta.resume_source_id) payload.resume_source_id = meta.resume_source_id;
  if (meta.application_preferred_city_code_list?.length) {
    payload.application_preferred_city_code_list = meta.application_preferred_city_code_list;
  }

  try {
    const body = await requestJson(`${FEISHU_API}/hire/v1/applications`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payload),
    });
    return { application_id: body.data.id, duplicate: false };
  } catch (error) {
    if (error instanceof FeishuApiError && error.body?.code === 1002206) {
      return { application_id: "", duplicate: true, message: error.body.msg || "duplicate application" };
    }
    throw error;
  }
}

async function addTalentToPool(token, talentId, talentPoolId) {
  if (!talentPoolId) return null;

  const body = await requestJson(`${FEISHU_API}/hire/v1/talent_pools/${talentPoolId}/talent_relationship`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      talent_id: talentId,
      add_type: 1,
    }),
  });

  return body.data;
}

async function createNote(token, talentId, applicationId, meta, filePath) {
  if (process.env.FEISHU_HIRE_CREATE_NOTE !== "1") return null;

  const lines = [
    process.env.FEISHU_HIRE_NOTE_PREFIX || "来源：Boss直聘 / OpenClaw 自动收取附件简历",
    `本地简历：${filePath}`,
  ];
  if (meta.resume_source_id) lines.push(`简历来源ID：${meta.resume_source_id}`);
  if (meta.job_id) lines.push(`职位ID：${meta.job_id}`);

  const payload = {
    talent_id: talentId,
    content: lines.join("\n"),
    privacy: Number(process.env.FEISHU_HIRE_NOTE_PRIVACY || 2),
    notify_mentioned_user: false,
  };
  if (applicationId) payload.application_id = applicationId;
  if (meta.creator_id) payload.creator_id = meta.creator_id;

  const body = await requestJson(`${FEISHU_API}/hire/v1/notes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  return body.data.note;
}

async function processFile({ args, token, state, manifest, stateIndex, filePath }) {
  const hash = await sha256File(filePath);
  const stat = await fs.stat(filePath);
  const baseMeta = findCandidateMeta(manifest, filePath, hash);
  const fingerprint = `${hash}`;
  const identity = getManifestIdentity(baseMeta);
  const normalizedIdentity = normalizeLookupKey(identity);
  const existing = state.files[fingerprint] || (normalizedIdentity ? stateIndex.get(normalizedIdentity) : null);

  if (args.mode === "talent_enrich") {
    if (!existing?.talent?.talent_id) {
      console.log(`SKIP no existing talent for ${path.basename(filePath)}`);
      return;
    }

    const extracted = extractContactsFromResume(filePath);
    const meta = normalizeResumeMeta(baseMeta, extracted);
    const { contact, hasContact } = mergeExtractedContacts(meta, extracted);
    if (!hasContact) {
      console.log(`SKIP no contact fields found: ${path.basename(filePath)}`);
      return;
    }

    if (!args.apply) {
      console.log(`DRY-RUN ENRICH ${path.basename(filePath)} candidate=${meta.name} mobile=${contact.mobile || "-"} email=${contact.email || "-"}`);
      return;
    }

    const update = await updateExistingTalent(token, existing.talent.talent_id, meta, existing.attachment_id, extracted);
    const result = {
      ...existing,
      status: "success",
      mode: args.mode,
      updated_at: new Date().toISOString(),
      extracted_contacts: contact,
      extracted_resume: extractedResumeSnapshot(meta, extracted),
      talent_update: update.data,
    };
    state.files[fingerprint] = result;
    if (normalizedIdentity) stateIndex.set(normalizedIdentity, result);
    console.log(`ENRICHED ${path.basename(filePath)} -> talent=${existing.talent.talent_id}`);
    return;
  }

  if (existing?.status === "success") {
    console.log(`SKIP already uploaded: ${path.basename(filePath)} -> ${existing.mode}`);
    return;
  }

  let meta = baseMeta;
  let extracted = null;
  if (args.mode === "talent_application") {
    extracted = extractContactsFromResume(filePath);
    meta = normalizeResumeMeta(baseMeta, extracted);
  }

  if (isDebugEnabled()) {
    console.error(JSON.stringify({
      debug: "process_file_meta",
      file: path.basename(filePath),
      hash,
      baseMeta,
      meta,
    }));
  }

  let reuseTalentId = "";
  if (args.apply && args.mode === "talent_application") {
    reuseTalentId = await findExistingTalentId(token, meta);
    if (reuseTalentId) {
      await ensureSafeTalentReuse(token, reuseTalentId, meta);
    }
  }

  if (args.mode === "talent_application" && !meta.job_id) {
    const message = "Missing FEISHU_HIRE_JOB_ID or manifest job_id for talent_application mode";
    if (args.apply) throw new Error(message);
    console.log(`WARN ${path.basename(filePath)}: ${message}`);
  }

  console.log(`${args.apply ? "UPLOAD" : "DRY-RUN"} ${path.basename(filePath)} candidate=${meta.name}`);

  if (args.mode === "talent_application" && extracted) {
    const { hasContact } = mergeExtractedContacts(meta, extracted);
    if (!hasContact) {
      const message = `No real mobile/email/identification extracted for ${path.basename(filePath)}`;
      if (args.apply) throw new ManualReviewRequiredError(message);
      console.log(`WARN ${path.basename(filePath)}: ${message}; apply will mark needs_manual_review`);
    }
  }

  if (!args.apply) {
    state.files[fingerprint] = {
      status: "dry_run",
      mode: args.mode,
      file: filePath,
      name: meta.name,
      school: meta.school || "",
      candidate_id: meta.candidate_id || "",
      candidate_uid: meta.candidate_uid || "",
      boss_candidate_uid: meta.boss_candidate_uid || "",
      external_id: meta.external_id || "",
      extracted_contacts: extracted ? mergeExtractedContacts(meta, extracted).contact : null,
      extracted_resume: extractedResumeSnapshot(meta, extracted),
      size: stat.size,
      updated_at: new Date().toISOString(),
    };
    return;
  }

  const attachment = await uploadAttachment(token, filePath);
  const result = {
    status: "success",
    mode: args.mode,
    file: filePath,
    name: meta.name,
    school: meta.school || "",
    candidate_id: meta.candidate_id || "",
    candidate_uid: meta.candidate_uid || "",
    boss_candidate_uid: meta.boss_candidate_uid || "",
    external_id: meta.external_id || "",
    size: stat.size,
    resume_hash: hash,
    attachment_id: attachment.id,
    attachment_name: attachment.name,
    updated_at: new Date().toISOString(),
  };

  if (args.mode === "talent_application") {
    let talent;
    if (reuseTalentId) {
      const update = await updateExistingTalent(token, reuseTalentId, meta, attachment.id, extracted);
      talent = { talent_id: reuseTalentId, reused: true };
      result.talent_update = update.data;
    } else {
      const created = await createBasicTalent(token, meta, attachment.id);
      talent = { talent_id: created.talent_id, reused: false, raw: created };
    }
    const application = await createApplication(token, talent.talent_id, meta);
    const talentPool = await addTalentToPool(token, talent.talent_id, meta.talent_pool_id);
    const note = await createNote(token, talent.talent_id, application.application_id, meta, filePath);
    result.talent = talent;
    result.application = application;
    result.extracted_contacts = extracted ? mergeExtractedContacts(meta, extracted).contact : null;
    result.extracted_resume = extractedResumeSnapshot(meta, extracted);
    if (talentPool) result.talent_pool = talentPool;
    if (note) result.note = note;
  } else if (args.mode === "website_attachment") {
    const websiteId = requireEnv("FEISHU_HIRE_WEBSITE_ID");
    const siteUser = await createWebsiteUser(token, websiteId, meta);
    const taskId = await createDeliveryByAttachment(token, websiteId, meta, siteUser, attachment.id);
    const task = await pollDeliveryTask(token, websiteId, taskId);
    result.site_user_id = siteUser.user_id;
    result.delivery_task_id = taskId;
    result.delivery = task.delivery;
  } else if (args.mode === "talent_basic") {
    result.talent = await createBasicTalent(token, meta, attachment.id);
  } else {
    throw new Error(`Unsupported mode: ${args.mode}`);
  }

  state.files[fingerprint] = result;
  if (normalizedIdentity) stateIndex.set(normalizedIdentity, result);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const state = await readJson(args.state, { files: {} });
  const manifest = await loadManifest(args.manifest);
  const stateIndex = buildStateIndex(state);
  const discoveredFiles = await listResumeFiles(args.dir);
  const files = await selectFilesForUpload(discoveredFiles, manifest);

  if (!files.length) {
    console.log(`No resume files found in ${args.dir}`);
    return;
  }

  const token = args.apply ? await getTenantAccessToken() : "";
  let failed = 0;

  for (const filePath of files) {
    try {
      await processFile({ args, token, state, manifest, stateIndex, filePath });
      await writeJson(args.state, state);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${path.basename(filePath)}: ${error.message}`);
      const hash = await sha256File(filePath);
      const meta = findCandidateMeta(manifest, filePath, hash);
      state.files[hash] = {
        status: error instanceof ManualReviewRequiredError ? "needs_manual_review" : "failed",
        mode: args.mode,
        file: filePath,
        name: meta.name || "",
        school: meta.school || "",
        candidate_id: meta.candidate_id || "",
        candidate_uid: meta.candidate_uid || "",
        boss_candidate_uid: meta.boss_candidate_uid || "",
        external_id: meta.external_id || "",
        resume_hash: hash,
        error: error.message,
        updated_at: new Date().toISOString(),
      };
      await writeJson(args.state, state);
    }
  }

  const success = Object.values(state.files).filter((item) => item.status === "success").length;
  console.log(`Finished. discovered=${discoveredFiles.length} selected=${files.length} total_success=${success} failed_this_run=${failed} state=${args.state}`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
