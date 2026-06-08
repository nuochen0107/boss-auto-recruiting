#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateJobProfile, hasConfiguredLlm, loadJobProfile } from "../scorer/job_profile_agent.mjs";
import { getCurrentRun, getTodayReport, pauseRun, preflight, startRun } from "../orchestrator/recommend_greet_runner.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(DIR, "public");
const PORT = Number(process.env.BOSS_DASHBOARD_PORT || 8787);
const HOST = process.env.BOSS_DASHBOARD_HOST || "127.0.0.1";

function sendJson(res, value, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value, null, 2));
}

function sendFile(res, file) {
  const types = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  res.end(fs.readFileSync(file));
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, { ok: true, service: "boss-recruiting-dashboard", timestamp: new Date().toISOString(), llmConfigured: hasConfiguredLlm() });
  }
  if (req.method === "GET" && url.pathname === "/api/preflight") {
    return sendJson(res, await preflight(url.searchParams.get("jobProfileId") || "ai_app_intern"));
  }
  if (req.method === "GET" && url.pathname === "/api/job-profile/ai-app-intern") {
    return sendJson(res, { profileId: "ai_app_intern", profile: loadJobProfile("ai_app_intern"), llmConfigured: hasConfiguredLlm() });
  }
  if (req.method === "POST" && url.pathname === "/api/job-profile/ai-app-intern/generate") {
    const payload = await body(req);
    return sendJson(res, await generateJobProfile({ profileId: "ai_app_intern", jd: payload.jd }), 201);
  }
  if (req.method === "POST" && url.pathname === "/api/runs/start") return sendJson(res, await startRun(await body(req)), 202);
  if (req.method === "POST" && url.pathname === "/api/runs/pause") return sendJson(res, pauseRun());
  if (req.method === "GET" && url.pathname === "/api/runs/current") return sendJson(res, getCurrentRun());
  if (req.method === "GET" && url.pathname === "/api/runs/report/today") return sendJson(res, getTodayReport());
  return sendJson(res, { error: "not_found" }, 404);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const file = path.resolve(PUBLIC_DIR, relative);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return sendJson(res, { error: "forbidden" }, 403);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, { error: "not_found" }, 404);
    return sendFile(res, file);
  } catch (error) {
    return sendJson(res, { error: String(error.message || error), preflight: error.preflight || undefined }, error.statusCode || 500);
  }
}

http.createServer(handle).listen(PORT, HOST, () => {
  console.log(`Boss 招聘控制面板已启动: http://${HOST}:${PORT}`);
});
