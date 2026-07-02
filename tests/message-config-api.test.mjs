import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readMessageConfig, writeMessageConfig } from "../dashboard/message-config-editor.mjs";

function tempConfigFile(contents = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boss-message-config-test-"));
  const file = path.join(dir, "default-config.yaml");
  if (contents) fs.writeFileSync(file, contents);
  return file;
}

test("reads default messages when yaml fields are absent", () => {
  const file = tempConfigFile("job_name: \"AI应用实习生\"\n");

  const config = readMessageConfig(file);

  assert.match(config.messages.request_resume_message, /最新附件简历/);
  assert.match(config.messages.confirm_received_message, /简历已收到/);
});

test("writes editable message fields while preserving other config", () => {
  const file = tempConfigFile([
    'job_name: "AI应用实习生"',
    'request_resume_message: "旧索要简历"',
    'confirm_received_message: "旧确认"',
    "",
  ].join("\n"));

  const saved = writeMessageConfig(file, {
    messages: {
      request_resume_message: "请发一份最新简历，我这边进一步评估。",
      confirm_received_message: "简历收到，会尽快筛选。",
    },
  });
  const text = fs.readFileSync(file, "utf8");

  assert.equal(saved.messages.request_resume_message, "请发一份最新简历，我这边进一步评估。");
  assert.equal(saved.messages.confirm_received_message, "简历收到，会尽快筛选。");
  assert.match(text, /job_name: "AI应用实习生"/);
  assert.match(text, /request_resume_message: "请发一份最新简历，我这边进一步评估。"/);
  assert.match(text, /confirm_received_message: "简历收到，会尽快筛选。"/);
});

test("rejects empty message fields", () => {
  const file = tempConfigFile();

  assert.throws(() => writeMessageConfig(file, {
    messages: {
      request_resume_message: "",
      confirm_received_message: "简历收到。",
    },
  }), /empty_message:request_resume_message/);
});
