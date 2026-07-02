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

test("normalizes editable jobs with generated internal job keys", () => {
  const file = tempJobsFile();
  const payload = normalizeJobsPayload({
    version: 1,
    jobs: [{
      display_name: "新媒体运营",
      feishu_hire_job_id: "",
      enabled: true,
    }, {
      display_name: "客户经理",
      feishu_hire_job_id: "1234567890",
      enabled: false,
    }],
  });

  writeJobsFromEditor(file, payload);
  const saved = readJobsForEditor(file);
  const routed = loadJobsConfig(path.dirname(file), file);

  assert.equal(saved.jobs.length, 2);
  assert.match(saved.jobs[0].job_key, /^job_[a-z0-9]+$/);
  assert.notEqual(saved.jobs[0].job_key, saved.jobs[1].job_key);
  assert.deepEqual(saved.jobs[0].boss_job_names, ["新媒体运营"]);
  assert.deepEqual(saved.jobs[1].boss_job_names, ["客户经理"]);
  assert.equal(saved.jobs[1].enabled, false);
  assert.equal(enabledJobs(routed).map((job) => job.job_key).join(","), saved.jobs[0].job_key);
});

test("regenerates one internal key per current job row", () => {
  const saved = normalizeJobsPayload({
    jobs: [{
      display_name: "AI应用实习生",
      enabled: true,
    }, {
      display_name: "产品运营",
      enabled: true,
    }, {
      display_name: "产品运营经理",
      enabled: true,
    }],
  });

  assert.equal(saved.jobs.length, 3);
  assert.equal(new Set(saved.jobs.map((job) => job.job_key)).size, 3);
  assert.deepEqual(saved.jobs.map((job) => job.boss_job_names), [["AI应用实习生"], ["产品运营"], ["产品运营经理"]]);
});

test("rejects non-numeric feishu job ids", () => {
  assert.throws(() => normalizeJobsPayload({
    jobs: [{
      display_name: "产品运营",
      feishu_hire_job_id: "abc123",
      enabled: true,
    }],
  }), /invalid_feishu_job_id:/);
});

test("requires at least one enabled job", () => {
  assert.throws(() => normalizeJobsPayload({
    jobs: [{
      display_name: "停用岗位",
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
