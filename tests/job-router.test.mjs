import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { matchJobFromText, safeJobAliases } = require("../config/job-router.cjs");

function jobsConfig() {
  return {
    version: 1,
    jobs: [{
      job_key: "dsp_operations",
      display_name: "DSP运营",
      boss_job_names: ["DSP运营"],
      enabled: true,
    }, {
      job_key: "dsp_operations_manager",
      display_name: "DSP运营经理",
      boss_job_names: ["DSP运营经理"],
      enabled: true,
    }],
  };
}

test("matches exact job names without allowing shorter aliases to match longer jobs", () => {
  const config = jobsConfig();

  assert.equal(matchJobFromText(config, "DSP运营").job.job_key, "dsp_operations");
  assert.equal(matchJobFromText(config, "DSP运营经理").job.job_key, "dsp_operations_manager");
});

test("matches job names when the page text has an explicit suffix boundary", () => {
  const config = jobsConfig();

  assert.equal(matchJobFromText(config, "DSP运营 _ 南京 8-12K").job.job_key, "dsp_operations");
  assert.equal(matchJobFromText(config, "DSP运营｜南京").job.job_key, "dsp_operations");
  assert.equal(matchJobFromText(config, "DSP运营 / 南京").job.job_key, "dsp_operations");
  assert.equal(matchJobFromText(config, "DSP运营（南京）").job.job_key, "dsp_operations");
});

test("matches job names split onto their own chat-list line", () => {
  const config = {
    version: 1,
    jobs: [{
      job_key: "product_operations",
      display_name: "产品运营",
      boss_job_names: ["产品运营"],
      enabled: true,
    }, {
      job_key: "product_operations_manager",
      display_name: "产品运营经理",
      boss_job_names: ["产品运营经理"],
      enabled: true,
    }],
  };

  assert.equal(matchJobFromText(config, "14:54\n何飞扬\n产品运营\n[送达]您好").job.job_key, "product_operations");
  assert.equal(matchJobFromText(config, "14:54\n何飞扬\n产品运营经理\n[送达]您好").job.job_key, "product_operations_manager");
});

test("matches job names that contain internal spaces before a suffix boundary", () => {
  const config = {
    version: 1,
    jobs: [{
      job_key: "ai_app_intern",
      display_name: "AI 应用实习生",
      boss_job_names: ["AI 应用实习生"],
      enabled: true,
    }],
  };

  assert.equal(matchJobFromText(config, "AI 应用实习生 _ 南京 150-200元/天").job.job_key, "ai_app_intern");
  assert.equal(matchJobFromText(config, "AI应用实习生 _ 南京 150-200元/天").job.job_key, "ai_app_intern");
  assert.equal(matchJobFromText(config, "AI 应用实习生｜南京").job.job_key, "ai_app_intern");
  assert.equal(matchJobFromText(config, "AI应用实习生经理").status, "unknown");
});

test("matches compact configured job names against page text with internal spaces", () => {
  const config = {
    version: 1,
    jobs: [{
      job_key: "ai_app_intern",
      display_name: "AI应用实习生",
      boss_job_names: ["AI应用实习生"],
      enabled: true,
    }],
  };

  assert.equal(matchJobFromText(config, "AI 应用实习生 _ 南京 150-200元/天").job.job_key, "ai_app_intern");
});

test("does not match expanded job names without an explicit boundary", () => {
  const config = jobsConfig();

  assert.equal(matchJobFromText(config, "高级DSP运营").status, "unknown");
  assert.equal(matchJobFromText(config, "DSP运营主管").status, "unknown");
  assert.equal(matchJobFromText(config, "DSP运营实习生").status, "unknown");
});

test("returns ambiguous when multiple enabled jobs have the same normalized alias", () => {
  const config = {
    version: 1,
    jobs: [{
      job_key: "product_operations",
      display_name: "产品运营",
      boss_job_names: ["产品运营"],
      enabled: true,
    }, {
      job_key: "product_ops_duplicate",
      display_name: "产品 运营",
      boss_job_names: ["产品 运营"],
      enabled: true,
    }],
  };

  const result = matchJobFromText(config, "产品运营");

  assert.equal(result.status, "ambiguous");
  assert.deepEqual(result.matches, ["product_operations", "product_ops_duplicate"]);
});

test("ignores unsafe shorter aliases contained by a longer alias for the same job", () => {
  const config = {
    version: 1,
    jobs: [{
      job_key: "product_operations_manager",
      display_name: "产品运营经理",
      boss_job_names: ["产品运营经理", "产品运营"],
      enabled: true,
    }],
  };

  assert.deepEqual(safeJobAliases(config.jobs[0]), ["产品运营经理"]);
  assert.equal(matchJobFromText(config, "产品运营经理").job.job_key, "product_operations_manager");
  assert.equal(matchJobFromText(config, "产品运营").status, "unknown");
});

test("keeps the display name when an unsafe longer alias contains it", () => {
  const config = {
    version: 1,
    jobs: [{
      job_key: "product_operations",
      display_name: "产品运营",
      boss_job_names: ["产品运营", "产品运营经理"],
      enabled: true,
    }],
  };

  assert.deepEqual(safeJobAliases(config.jobs[0]), ["产品运营"]);
  assert.equal(matchJobFromText(config, "产品运营").job.job_key, "product_operations");
  assert.equal(matchJobFromText(config, "产品运营经理").status, "unknown");
});
