import { callJsonLlm, hasConfiguredLlm, parseLlmJsonObject } from "./llm_config.mjs";

function validateScore(value) {
  if (!value || typeof value !== "object") throw new Error("score_must_be_object");
  const required = ["fit_score", "decision", "matched_reason", "reasons", "risk_flags", "suggested_message"];
  for (const key of required) if (!(key in value)) throw new Error(`score_missing_${key}`);
  const score = Number(value.fit_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("score_invalid_fit_score");
  if (!["greet", "skip", "review"].includes(value.decision)) throw new Error("score_invalid_decision");
  if (!Array.isArray(value.reasons) || !Array.isArray(value.risk_flags)) throw new Error("score_invalid_arrays");
  return {
    fit_score: Math.round(score),
    decision: value.decision,
    matched_reason: String(value.matched_reason || ""),
    reasons: value.reasons.map(String),
    risk_flags: value.risk_flags.map(String),
    suggested_message: String(value.suggested_message || ""),
  };
}

function parsePlainJson(text) {
  return validateScore(parseLlmJsonObject(text));
}

export async function judgeCandidate(candidate, profile) {
  if (!hasConfiguredLlm()) {
    return {
      fit_score: 0,
      decision: "review",
      matched_reason: "",
      reasons: ["未配置大模型 API Key，无法可靠自动评分"],
      risk_flags: ["llm_not_configured"],
      suggested_message: "",
      source: "no_llm",
    };
  }
  const prompt = `你是谨慎的招聘候选人评分器。依据岗位画像评估候选人。
只输出合法 JSON，不要 Markdown，不要解释。输出必须严格为：
{"fit_score":0,"decision":"greet|skip|review","matched_reason":"","reasons":[],"risk_flags":[],"suggested_message":""}
信息不足时 decision 必须为 review，禁止臆测。fit_score 范围 0-100。

岗位画像：
${JSON.stringify(profile)}

候选人：
${JSON.stringify(candidate)}`;
  const result = await callJsonLlm(prompt, { maxTokens: 2400 });
  return { ...parsePlainJson(result.content), source: "llm", provider: result.provider, model: result.model };
}
