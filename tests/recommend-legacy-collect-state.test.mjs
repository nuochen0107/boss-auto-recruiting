import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("recommended greets are written to the legacy collect queue", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-legacy-state-"));
  process.env.BOSS_DATA_ROOT = dataRoot;
  const moduleUrl = new URL(`../orchestrator/recommend_greet_runner.mjs?case=${Date.now()}`, import.meta.url);
  const { recordLegacyCollectRequest } = await import(moduleUrl);

  const sentAt = "2026-06-29T10:00:00.000Z";
  recordLegacyCollectRequest({
    candidate: {
      candidate_id: "boss_recommend:abc123:ai_app_intern",
      name: "张三",
      school: "南京大学",
      raw_text: "张三 南京大学 AI 实习候选人",
    },
    legacyId: "张三__南京大学",
    options: {
      jobId: "ai_app_intern",
      jobName: "AI应用实习生",
    },
    runId: "recommend-test",
    timestamp: sentAt,
  });

  const stateFile = path.join(dataRoot, "briefs", "boss-auto-lightweight-loop-state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const queued = state.candidates["张三__南京大学"];

  assert.equal(queued.status, "attachment_requested");
  assert.equal(queued.message_sent_at, sentAt);
  assert.equal(queued.source, "recommended_feed");
  assert.equal(queued.job_key, "ai_app_intern");
  assert.equal(queued.job_name, "AI应用实习生");
  assert.equal(queued.recommend_candidate_id, "boss_recommend:abc123:ai_app_intern");
});

test("greeted recommendation decision logs can backfill the legacy collect queue", async () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "boss-recommend-backfill-state-"));
  process.env.BOSS_DATA_ROOT = dataRoot;
  const moduleUrl = new URL(`../orchestrator/recommend_greet_runner.mjs?case=${Date.now()}-backfill`, import.meta.url);
  const { backfillLegacyCollectRequestsFromDecisions } = await import(moduleUrl);
  const candidateDir = path.join(dataRoot, "candidates");
  const runDir = path.join(dataRoot, "runs");
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run-2026-06-29.jsonl"), `${JSON.stringify({
    run_id: "recommend-run",
    event: "run_start",
    options: {
      jobId: "product_operations",
      jobName: "产品运营实习生",
    },
  })}\n`);
  fs.writeFileSync(path.join(candidateDir, "candidate-decisions-2026-06-29.jsonl"), `${JSON.stringify({
    run_id: "recommend-run",
    timestamp: "2026-06-29T03:35:03.175Z",
    flow_mode: "direct_greet",
    job_id: "product_operations",
    candidate_id: "recommend:abc",
    candidate_name: "momo",
    raw_text: "momo\\n产品运营\\n打招呼",
    action_taken: "greeted",
  })}\n`);

  const result = backfillLegacyCollectRequestsFromDecisions({
    date: "2026-06-29",
  });
  const stateFile = path.join(dataRoot, "briefs", "boss-auto-lightweight-loop-state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));

  assert.equal(result.backfilled, 1);
  assert.equal(state.candidates.momo.status, "attachment_requested");
  assert.equal(state.candidates.momo.job_name, "产品运营实习生");
  assert.equal(state.candidates.momo.message_sent_at, "2026-06-29T03:35:03.175Z");
  assert.equal(state.candidates.momo.recommend_candidate_id, "recommend:abc");
});
