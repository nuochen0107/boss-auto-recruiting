import { applyHardFilters } from "./hard_filters.mjs";
import { judgeCandidate } from "./llm_judge.mjs";

function renderGreeting(template, profile, score) {
  return String(template || "")
    .replaceAll("{{job_name}}", profile.job_name || "")
    .replaceAll("{{matched_reason}}", score.matched_reason || "AI应用开发");
}

export async function scoreCandidate(candidate, profile, threshold = profile.score_threshold_default || 70) {
  const hard = applyHardFilters(candidate, profile);
  if (!hard.passed) {
    return {
      fit_score: 0,
      decision: "skip",
      matched_reason: "",
      reasons: hard.reasons,
      risk_flags: hard.risk_flags,
      suggested_message: "",
      source: "hard_filter",
      hard_filters_passed: false,
    };
  }

  try {
    const judged = await judgeCandidate(candidate, profile);
    const decision = judged.decision === "greet" && judged.fit_score >= Number(threshold)
      ? "greet"
      : judged.decision === "greet"
        ? "skip"
        : judged.decision;
    return {
      ...judged,
      decision,
      suggested_message: judged.suggested_message || renderGreeting(profile.greeting_template, profile, judged),
      hard_filters_passed: true,
    };
  } catch (error) {
    return {
      fit_score: 0,
      decision: "review",
      matched_reason: "",
      reasons: ["大模型评分失败，禁止自动打招呼"],
      risk_flags: ["llm_judge_failed"],
      suggested_message: "",
      source: "llm_error",
      hard_filters_passed: true,
      error: String(error.message || error),
    };
  }
}
