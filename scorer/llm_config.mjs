import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILES = [path.join(ROOT, ".env"), path.join(ROOT, ".env.local")];

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match) return null;
  let value = match[2].trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [match[1], value.replace(/\\n/g, "\n")];
}

export function loadLocalEnv() {
  for (const file of ENV_FILES) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const entry = parseEnvLine(line);
      if (!entry) continue;
      const [key, value] = entry;
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

loadLocalEnv();

export function getLlmConfig() {
  if (process.env.LLM_API_KEY) {
    return {
      provider: process.env.LLM_PROVIDER || "openai-compatible",
      apiKey: process.env.LLM_API_KEY,
      baseUrl: (process.env.LLM_BASE_URL || "").replace(/\/$/, ""),
      model: process.env.LLM_MODEL || "",
    };
  }
  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseUrl: (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com").replace(/\/$/, ""),
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    };
  }
  if (process.env.DASHSCOPE_API_KEY) {
    return {
      provider: "dashscope",
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl: (process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1").replace(/\/$/, ""),
      model: process.env.DASHSCOPE_MODEL || "qwen-plus",
    };
  }
  if (process.env.MINIMAX_API_KEY) {
    return {
      provider: "minimax",
      apiKey: process.env.MINIMAX_API_KEY,
      baseUrl: (process.env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/$/, ""),
      model: process.env.MINIMAX_MODEL || "MiniMax-M2.7",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai-compatible",
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    };
  }
  return null;
}

export function hasConfiguredLlm() {
  const config = getLlmConfig();
  return Boolean(config?.apiKey && config?.baseUrl && config?.model);
}

export function parseLlmJsonObject(text) {
  let value = String(text || "").trim();
  value = value.replace(/^(?:<think>[\s\S]*?<\/think>\s*)+/i, "").trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) value = fenced[1].trim();
  if (!value.startsWith("{") || !value.endsWith("}")) throw new Error("llm_response_not_plain_json");
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("llm_response_not_json_object");
  }
  return parsed;
}

export async function callJsonLlm(prompt, { maxTokens = 1200 } = {}) {
  const config = getLlmConfig();
  if (!config?.apiKey || !config?.baseUrl || !config?.model) throw new Error("llm_api_key_not_configured");
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${config.provider}_${response.status}:${body?.error?.message || body?.message || "request_failed"}`);
  }
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error(`${config.provider}_empty_response`);
  return { content, provider: config.provider, model: config.model };
}
