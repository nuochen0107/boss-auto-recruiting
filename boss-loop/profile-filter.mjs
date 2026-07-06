const EDUCATION_LEVELS = new Map([
  ["大专", 1],
  ["专科", 1],
  ["本科", 2],
  ["研究生", 3],
  ["硕士", 3],
  ["博士", 4],
]);

function numericOrNull(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clampIntegerOrNull(value, min, max) {
  const number = numericOrNull(value);
  if (number == null) return null;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function normalizeProfileFilter(input = {}) {
  let minAge = clampIntegerOrNull(input.minAge, 18, 45);
  let maxAge = clampIntegerOrNull(input.maxAge, 18, 45);
  const minEducation = clampIntegerOrNull(input.minEducation, 1, 4);

  if (minAge != null && maxAge != null && minAge > maxAge) {
    [minAge, maxAge] = [maxAge, minAge];
  }

  return { minAge, maxAge, minEducation };
}

export function parseCandidateProfile(text = "") {
  const source = String(text || "");
  const ageMatch = source.match(/(\d{1,2})\s*岁/);
  const educationSource = source
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => /\d{1,2}\s*岁/.test(line) && /博士|硕士|研究生|本科|大专|专科/.test(line)) || source;
  const educationMatches = [...educationSource.matchAll(/博士|硕士|研究生|本科|大专|专科/g)]
    .map(match => match[0])
    .sort((a, b) => (EDUCATION_LEVELS.get(b) || 0) - (EDUCATION_LEVELS.get(a) || 0));
  const education = educationMatches[0] || "";
  return {
    age: ageMatch ? Number(ageMatch[1]) : null,
    education,
    educationLevel: EDUCATION_LEVELS.get(education) || null,
  };
}

export function profileFilterDecision(profile = {}, filter = {}) {
  const normalized = normalizeProfileFilter(filter);
  const ageFilterEnabled = normalized.minAge != null || normalized.maxAge != null;
  if (ageFilterEnabled && profile.age == null) return { passed: false, reason: "age_missing" };
  if (normalized.minAge != null && profile.age < normalized.minAge) return { passed: false, reason: "age_below_min" };
  if (normalized.maxAge != null && profile.age > normalized.maxAge) return { passed: false, reason: "age_above_max" };

  if (normalized.minEducation != null && profile.educationLevel == null) {
    return { passed: false, reason: "education_missing" };
  }
  if (normalized.minEducation != null && profile.educationLevel < normalized.minEducation) {
    return { passed: false, reason: "education_below_min" };
  }

  return { passed: true, reason: "" };
}
