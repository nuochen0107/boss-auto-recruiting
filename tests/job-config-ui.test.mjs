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

test("job mismatch pause message asks users to check Boss job name", () => {
  const appJs = fs.readFileSync(path.join(root, "dashboard/public/app.js"), "utf8");

  assert.match(appJs, /paused_job_filter_option_not_found/);
  assert.match(appJs, /paused_recommend_job_option_not_found/);
  assert.match(appJs, /岗位名称是否与 Boss 已发布岗位名称一致/);
  assert.match(appJs, /\["failed", "paused"\]\.includes\(state\.status\) && state\.error/);
});
