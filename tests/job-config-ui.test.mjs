import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("job config editor only exposes job name and Feishu job id fields", () => {
  const appJs = fs.readFileSync(path.join(root, "dashboard/public/app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "dashboard/public/index.html"), "utf8");

  assert.equal(appJs.includes('data-job-field="job_key"'), false);
  assert.equal(appJs.includes('data-job-field="boss_job_names"'), false);
  assert.equal(appJs.includes("Boss 岗位别名"), false);
  assert.equal(html.includes("Boss 岗位别名"), false);
  assert.equal(appJs.includes('data-job-field="display_name"'), true);
  assert.equal(appJs.includes('data-job-field="feishu_hire_job_id"'), true);
});

test("job config editor tells users Feishu URL can be pasted", () => {
  const appJs = fs.readFileSync(path.join(root, "dashboard/public/app.js"), "utf8");

  assert.match(appJs, /parseFeishuHireJobId/);
  assert.match(appJs, /可粘贴飞书招聘岗位页面 URL/);
  assert.match(appJs, /URL 中没有找到 job_id/);
});

test("job mismatch pause message asks users to check Boss job name", () => {
  const appJs = fs.readFileSync(path.join(root, "dashboard/public/app.js"), "utf8");

  assert.match(appJs, /paused_job_filter_option_not_found/);
  assert.match(appJs, /paused_recommend_job_option_not_found/);
  assert.match(appJs, /岗位名称是否与 Boss 已发布岗位名称一致/);
  assert.match(appJs, /\["failed", "paused"\]\.includes\(state\.status\) && state\.error/);
});

test("dashboard simplified layout keeps existing control bindings", () => {
  const html = fs.readFileSync(path.join(root, "dashboard/public/index.html"), "utf8");
  const requiredIds = [
    "pipelineJobKey",
    "chatLimit",
    "chatMinEducation",
    "chatMinAge",
    "chatMaxAge",
    "collectLimit",
    "syncLimit",
    "jobId",
    "dailyTarget",
    "dailyTargetNumber",
    "batchSize",
    "batchIntervalMinutes",
    "startBtn",
    "reportBtn",
    "pauseBtn",
    "pipelinePauseBtn",
    "toggleJobConfigBtn",
    "toggleMessageConfigBtn",
    "pipelineNotice",
    "preflightChecks",
  ];

  assert.match(html, /每日招聘流程链路/);
  assert.match(html, /高级设置/);
  assert.match(html, /settings-icon-jobs/);
  assert.match(html, /settings-icon-message/);
  for (const id of requiredIds) assert.match(html, new RegExp(`id="${id}"`));
});

test("dashboard defaults to real execution and removes per-run resume cleanup", () => {
  const html = fs.readFileSync(path.join(root, "dashboard/public/index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(root, "dashboard/public/app.js"), "utf8");

  assert.match(html, /name="mode" value="real-run" checked/);
  assert.doesNotMatch(html, /id="deleteUploadedResumes"/);
  assert.doesNotMatch(html, /上传成功后清理本地简历/);
  assert.match(appJs, /const deleteUploadedResumes = false;/);
  assert.doesNotMatch(appJs, /\$\("deleteUploadedResumes"\)/);
});

test("dashboard visual refactor compresses workflow and recommend controls", () => {
  const html = fs.readFileSync(path.join(root, "dashboard/public/index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "dashboard/public/style.css"), "utf8");

  assert.match(html, /<div class="section-title workflow-title-row">/);
  assert.match(html, /class="workflow-filter-row"/);
  assert.match(html, /<label class="field recommend-job-field">推荐岗位/);
  assert.match(html, /<label class="field compact-number-field">今日目标人数/);
  assert.match(css, /\.mode-section\.panel \.mode-picker\s*{[^}]*grid-template-columns: minmax\(140px, 160px\) minmax\(140px, 160px\);/s);
  assert.match(css, /\.process-card\s*{[^}]*background: #fff;/s);
  assert.match(css, /\.process-card \.button\.primary\s*{[^}]*background: var\(--primary\);/s);
  assert.match(css, /\.full-flow-actions\s*{[^}]*grid-template-columns: minmax\(160px, \.8fr\) minmax\(220px, 1\.2fr\);/s);
  assert.match(css, /\.recommend-panel \.recommend-grid\s*{[^}]*grid-template-columns: minmax\(260px, 1fr\) 120px 120px;/s);
});

test("advanced job config uses compact single-row editors", () => {
  const css = fs.readFileSync(path.join(root, "dashboard/public/style.css"), "utf8");

  assert.match(css, /\.advanced-panel \.job-editor\s*{[^}]*grid-template-columns: minmax\(150px, \.9fr\) minmax\(240px, 1\.35fr\) auto;/s);
  assert.match(css, /\.advanced-panel \.job-editor \.field small\s*{[^}]*display: none;/s);
  assert.match(css, /\.advanced-panel \.job-remove-button\s*{[^}]*min-height: 34px;/s);
});
