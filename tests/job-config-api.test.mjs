import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { normalizeJobsPayload, readJobsForEditor, writeJobsFromEditor } from "../dashboard/job-config-editor.mjs";

const require = createRequire(import.meta.url);
const { enabledJobs, loadJobsConfig } = require("../config/job-router.cjs");

function tempJobsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-jobs-config-test-"));
  return path.join(dir, "jobs.json");
}

test("normalizes editable jobs and preserves current job-router compatibility", () => {
  const file = tempJobsFile();
  const payload = normalizeJobsPayload({
    version: 1,
    jobs: [{
      job_key: "new_media_operations",
      display_name: "新媒体运营",
      boss_job_names: "新媒体运营\n新媒体运营实习生",
      feishu_hire_job_id: "",
      enabled: true,
    }, {
      job_key: "customer_manager",
      display_name: "客户经理",
      boss_job_names: ["客户经理", "客户经理"],
      feishu_hire_job_id: "1234567890",
      enabled: false,
    }],
  });

  writeJobsFromEditor(file, payload);
  const saved = readJobsForEditor(file);
  const routed = loadJobsConfig(path.dirname(file), file);

  assert.equal(saved.jobs.length, 2);
  assert.deepEqual(saved.jobs[0].boss_job_names, ["新媒体运营", "新媒体运营实习生"]);
  assert.equal(saved.jobs[1].enabled, false);
  assert.equal(enabledJobs(routed).map((job) => job.job_key).join(","), "new_media_operations");
});

test("rejects duplicate job keys", () => {
  assert.throws(() => normalizeJobsPayload({
    jobs: [{
      job_key: "ai_app_intern",
      display_name: "AI应用实习生",
      boss_job_names: ["AI应用实习生"],
      enabled: true,
    }, {
      job_key: "ai_app_intern",
      display_name: "AI应用实习生 2",
      boss_job_names: ["AI应用实习生 2"],
      enabled: true,
    }],
  }), /duplicate_job_key:ai_app_intern/);
});

test("rejects non-numeric feishu job ids", () => {
  assert.throws(() => normalizeJobsPayload({
    jobs: [{
      job_key: "product_operations",
      display_name: "产品运营",
      boss_job_names: ["产品运营"],
      feishu_hire_job_id: "abc123",
      enabled: true,
    }],
  }), /invalid_feishu_job_id:product_operations/);
});

test("requires at least one enabled job", () => {
  assert.throws(() => normalizeJobsPayload({
    jobs: [{
      job_key: "disabled_job",
      display_name: "停用岗位",
      boss_job_names: ["停用岗位"],
      enabled: false,
    }],
  }), /no_enabled_jobs/);
});

test("reads an empty default jobs file for first-run setup", () => {
  const file = tempJobsFile();
  fs.writeFileSync(file, '{\n  "version": 1,\n  "jobs": []\n}\n');

  const saved = readJobsForEditor(file);

  assert.equal(saved.version, 1);
  assert.deepEqual(saved.jobs, []);
});
