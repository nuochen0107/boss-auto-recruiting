# Chrome Extension Control Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Chrome extension a more complete remote control for the local Boss recruiting dashboard, and document a fast source-based debug workflow.

**Architecture:** Keep the current delivery model: the extension calls the local Dashboard API, while the local app owns Node, CDP, files, Feishu, and resume parsing. Extract popup-only pure logic into a small shared module so state decisions and error wording can be tested without Chrome APIs.

**Tech Stack:** Chrome Manifest V3 popup/options, vanilla JavaScript modules, local HTTP Dashboard API, Node `node:test`.

---

### Task 1: Shared Popup Logic

**Files:**
- Create: `chrome-extension/shared/plugin-ui.mjs`
- Test: `tests/chrome-extension-plugin-ui.test.mjs`
- Modify: `chrome-extension/popup/popup.js`

- [ ] **Step 1: Write failing tests**

Create tests that import `chrome-extension/shared/plugin-ui.mjs` and verify:
- `normalizeServiceUrl()` accepts `http://127.0.0.1:8787/` and returns `http://127.0.0.1:8787`.
- `normalizeServiceUrl()` rejects `https://example.com`.
- `isActiveStatus()` returns true for `starting`, `running`, and `pausing`.
- `friendlyError()` maps lock and network failures to Chinese user-facing text.
- `summarizeReport()` returns a compact Chinese summary for today report payloads.

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/chrome-extension-plugin-ui.test.mjs`

Expected: fail with `Cannot find module ... chrome-extension/shared/plugin-ui.mjs`.

- [ ] **Step 3: Implement shared logic**

Create `chrome-extension/shared/plugin-ui.mjs` with exported pure functions and update `popup.js` to import them instead of owning duplicate helpers.

- [ ] **Step 4: Verify green**

Run: `node --test tests/chrome-extension-plugin-ui.test.mjs`

Expected: pass.

### Task 2: Complete Popup Controls

**Files:**
- Modify: `chrome-extension/popup/popup.html`
- Modify: `chrome-extension/popup/popup.css`
- Modify: `chrome-extension/popup/popup.js`

- [ ] **Step 1: Add status sections**

Add separate display rows for:
- Local service
- Recommend task
- Daily pipeline

- [ ] **Step 2: Add report/config/debug controls**

Add buttons for:
- 今日报告
- 打开岗位配置
- 打开话术配置
- 复制结果

- [ ] **Step 3: Wire API calls**

Use existing endpoints:
- `GET /api/runs/current`
- `GET /api/runs/report/today`
- `GET /api/pipeline/current`

Keep config buttons opening the full dashboard for now, because the dashboard already owns the richer editors.

- [ ] **Step 4: Tighten button states**

Disable conflicting start buttons when either a recommend run or daily pipeline is active.

### Task 3: Debug Documentation

**Files:**
- Modify: `chrome-extension/README.md`

- [ ] **Step 1: Add live debug workflow**

Document loading `chrome-extension/` as an unpacked extension, refreshing it after source edits, inspecting the popup, and running the dashboard from source.

- [ ] **Step 2: Add troubleshooting table**

Document symptoms:
- 插件显示未连接
- 修改后不生效
- API 返回旧逻辑
- 真实执行前按钮不可点

### Task 4: Verification

**Files:**
- Read/check affected files only.

- [ ] **Step 1: Syntax check extension scripts**

Run:
- `node --check chrome-extension/shared/plugin-ui.mjs`
- `node --check chrome-extension/popup/popup.js`
- `node --check chrome-extension/options/options.js`

- [ ] **Step 2: Run tests**

Run: `node --test tests/*.test.mjs`

- [ ] **Step 3: Verify manifest and package shape**

Read `chrome-extension/manifest.json` and ensure no unnecessary permissions were added.
