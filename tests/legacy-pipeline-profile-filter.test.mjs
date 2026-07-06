import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOptions, stagesFor } from "../orchestrator/legacy_pipeline_runner.mjs";

test("legacy pipeline normalizes chat profile filter options", () => {
  const options = normalizeOptions({
    type: "chat",
    jobKey: "all",
    minAge: 17,
    maxAge: 48,
    minEducation: "2",
  });

  assert.deepEqual(options.profileFilter, {
    minAge: 18,
    maxAge: 45,
    minEducation: 2,
  });
});

test("legacy pipeline passes chat profile filter flags to Boss script", () => {
  const stages = stagesFor({
    type: "chat",
    mode: "real-run",
    chatLimit: 20,
    jobKey: "all",
    selectedJobs: [{ job_key: "product_ops", display_name: "产品运营", feishu_hire_job_id: "" }],
    profileFilter: { minAge: 20, maxAge: 30, minEducation: 2 },
  });

  assert.equal(stages.length, 1);
  assert.deepEqual(stages[0].args.slice(-6), [
    "--min-age", "20",
    "--max-age", "30",
    "--min-education", "2",
  ]);
});
