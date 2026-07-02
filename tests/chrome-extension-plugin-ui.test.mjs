import assert from "node:assert/strict";
import test from "node:test";
import {
  friendlyError,
  isActiveStatus,
  normalizeServiceUrl,
  summarizeReport,
} from "../chrome-extension/shared/plugin-ui.mjs";

test("normalizes local dashboard service urls", () => {
  assert.equal(normalizeServiceUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
  assert.equal(normalizeServiceUrl(" http://localhost:8787/dashboard "), "http://localhost:8787");
});

test("rejects non-http service urls", () => {
  assert.throws(() => normalizeServiceUrl("https://example.com"), /本地服务地址必须使用 http:\/\//);
});

test("detects active task statuses", () => {
  assert.equal(isActiveStatus("starting"), true);
  assert.equal(isActiveStatus("running"), true);
  assert.equal(isActiveStatus("pausing"), true);
  assert.equal(isActiveStatus("completed"), false);
  assert.equal(isActiveStatus("idle"), false);
});

test("maps common local api errors to readable Chinese messages", () => {
  assert.equal(friendlyError(new Error("Failed to fetch")), "无法连接本地控制面板，请先打开 Boss招聘助手.app。");
  assert.equal(friendlyError(new Error("pipeline_already_active")), "已有日常流程正在运行，请先暂停或等待完成。");
  assert.equal(friendlyError(new Error("run_lock_exists")), "推荐页任务正在运行，请先暂停或等待完成。");
  assert.equal(friendlyError(new Error("missing_feishu_job_route")), "当前岗位没有飞书路由，只能执行 Boss 沟通和收简历。");
});

test("summarizes today report payloads for the popup", () => {
  const report = summarizeReport({
    date: "2026-06-29",
    totals: {
      greeted: 8,
      skipped: 3,
      failed: 1,
    },
    runs: [{ id: "a" }, { id: "b" }],
  });

  assert.match(report, /2026-06-29/);
  assert.match(report, /运行 2 次/);
  assert.match(report, /已打招呼 8/);
  assert.match(report, /跳过 3/);
  assert.match(report, /失败 1/);
});
