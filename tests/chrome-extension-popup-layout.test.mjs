import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../chrome-extension/popup/popup.html", import.meta.url), "utf8");

function indexOfId(id) {
  const index = html.indexOf(`id="${id}"`);
  assert.notEqual(index, -1, `expected #${id} to exist`);
  return index;
}

test("popup pairs each task limit with its action in the requested order", () => {
  const order = [
    "chatLimit",
    "chatBtn",
    "collectLimit",
    "collectBtn",
    "syncLimit",
    "syncBtn",
    "dailyTarget",
    "recommendBtn",
  ].map(indexOfId);

  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("popup keeps only dashboard and pause as utility actions", () => {
  assert.notEqual(indexOfId("openDashboardBtn"), -1);
  assert.notEqual(indexOfId("pauseBtn"), -1);
  for (const removedId of [
    "openJobsBtn",
    "openMessagesBtn",
    "preflightBtn",
    "proxyBtn",
    "refreshBtn",
    "reportBtn",
    "frontBtn",
    "copyOutputBtn",
  ]) {
    assert.equal(html.includes(`id="${removedId}"`), false, `expected #${removedId} to be removed`);
  }
});

test("popup keeps output collapsed and visually separates utility actions", () => {
  assert.match(html, /<details[^>]*class="[^"]*\boutput-panel\b[^"]*"/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b/);
  assert.match(html, /<summary>运行日志<\/summary>/);
  assert.match(html, /id="syncBtn"[^>]*class="[^"]*\bprimary\b/);
  assert.match(html, /<div class="utility-actions">/);
});

test("popup exposes enterprise console sections and accessible status regions", () => {
  for (const section of [
    "status-section",
    "config-section",
    "task-section",
    "support-section",
    "log-section",
  ]) {
    assert.match(html, new RegExp(`class="[^"]*\\b${section}\\b[^"]*"`), `expected ${section}`);
  }

  assert.match(html, /aria-live="polite"/);
  assert.match(html, /role="status"/);
  assert.match(html, /class="[^"]*\bstatus-dot\b[^"]*"/);
  assert.match(html, /class="[^"]*\bempty-log\b[^"]*"/);
  assert.match(html, /暂无运行日志/);
});

test("popup preserves current functional control ids", () => {
  for (const id of [
    "optionsBtn",
    "jobKey",
    "mode",
    "chatLimit",
    "chatBtn",
    "collectLimit",
    "collectBtn",
    "syncLimit",
    "syncBtn",
    "dailyTarget",
    "recommendBtn",
    "openDashboardBtn",
    "pauseBtn",
    "output",
  ]) {
    assert.notEqual(indexOfId(id), -1, `expected #${id} to remain available`);
  }
});
