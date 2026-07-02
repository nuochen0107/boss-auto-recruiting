import fs from "node:fs";
import path from "node:path";

export const MESSAGE_CONFIG_FIELDS = {
  request_resume_message: "你好，我这边看了你的经历，和当前岗位匹配度不错。方便的话，可以发一份最新附件简历给我吗？我这边进一步评估后再和你沟通，谢谢。",
  confirm_received_message: "简历已收到，我们会尽快筛选，合适的话会联系您。",
};

function readYamlScalar(text, key) {
  const match = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!match) return "";
  return match[1].trim().replace(/^["']|["']$/g, "");
}

function quoteYaml(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeMessage(value, key) {
  const text = String(value || "").trim();
  if (!text) {
    const error = new Error(`empty_message:${key}`);
    error.statusCode = 422;
    throw error;
  }
  if (text.length > 500) {
    const error = new Error(`message_too_long:${key}`);
    error.statusCode = 422;
    throw error;
  }
  return text;
}

function replaceOrAppendScalar(text, key, value) {
  const line = `${key}: ${quoteYaml(value)}`;
  const pattern = new RegExp(`^${key}:.*$`, "m");
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.replace(/\s*$/, "\n")}${line}\n`;
}

export function readMessageConfig(file) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const messages = {};
  for (const [key, fallback] of Object.entries(MESSAGE_CONFIG_FIELDS)) {
    messages[key] = readYamlScalar(text, key) || fallback;
  }
  return { file, messages, writable: true };
}

export function writeMessageConfig(file, payload = {}) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const key of Object.keys(MESSAGE_CONFIG_FIELDS)) {
    const value = normalizeMessage(payload.messages?.[key] ?? payload[key], key);
    text = replaceOrAppendScalar(text, key, value);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
  return readMessageConfig(file);
}
