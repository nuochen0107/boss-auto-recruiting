export function normalizeRunOptions(input = {}) {
  const dailyTarget = clampInteger(input.dailyTarget, 1, 200, 20);
  const batchSize = clampInteger(input.batchSize, 1, 50, 50);
  const batchIntervalMinutes = clampNumber(input.batchIntervalMinutes, 0, 1440, 30);
  const mode = input.mode === "real-run" ? "real-run" : "dry-run";
  return {
    jobId: String(input.jobId || input.jobProfileId || "ai_app_intern"),
    dailyTarget,
    batchSize,
    batchIntervalMinutes,
    mode,
  };
}

export function buildBatchPlan(dailyTarget, batchSize) {
  const plan = [];
  let remaining = dailyTarget;
  while (remaining > 0) {
    const target = Math.min(batchSize, remaining);
    plan.push({ number: plan.length + 1, target });
    remaining -= target;
  }
  return plan;
}

function clampInteger(value, min, max, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
