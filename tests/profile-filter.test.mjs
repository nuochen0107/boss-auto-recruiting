import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeProfileFilter,
  parseCandidateProfile,
  profileFilterDecision,
} from "../boss-loop/profile-filter.mjs";

test("parses age and education from Boss right panel text", () => {
  const profile = parseCandidateProfile("李柳林 在线 19岁 27年应届生 本科 牛人分析\n成都东软学院 · 人工智能 · 本科");

  assert.equal(profile.age, 19);
  assert.equal(profile.education, "本科");
  assert.equal(profile.educationLevel, 2);
});

test("parses the highest education when profile text contains multiple degrees", () => {
  const profile = parseCandidateProfile("张三 在线 23岁\n2021-2025 南京大学 · 本科\n2025-2028 香港大学 · 硕士");

  assert.equal(profile.age, 23);
  assert.equal(profile.education, "硕士");
  assert.equal(profile.educationLevel, 3);
});

test("treats graduate student wording as master level", () => {
  const profile = parseCandidateProfile("张甲奇 23岁 河海大学工商管理专业研究生，可立即到岗");

  assert.equal(profile.age, 23);
  assert.equal(profile.education, "研究生");
  assert.equal(profile.educationLevel, 3);
});

test("prefers compact profile line over unrelated education words elsewhere", () => {
  const profile = parseCandidateProfile("田梓钰 在线 23岁 硕士\n岗位说明：博士优先\n2021-2025 某大学 · 本科");

  assert.equal(profile.age, 23);
  assert.equal(profile.education, "硕士");
  assert.equal(profile.educationLevel, 3);
});

test("profile filter skips candidates when enabled fields are missing", () => {
  const ageFilter = normalizeProfileFilter({ minAge: 18, maxAge: 45, minEducation: null });
  const educationFilter = normalizeProfileFilter({ minAge: null, maxAge: null, minEducation: 2 });

  assert.deepEqual(profileFilterDecision({ age: null, educationLevel: 2 }, ageFilter), {
    passed: false,
    reason: "age_missing",
  });
  assert.deepEqual(profileFilterDecision({ age: 22, educationLevel: null }, educationFilter), {
    passed: false,
    reason: "education_missing",
  });
});

test("profile filter enforces age range and minimum education", () => {
  const filter = normalizeProfileFilter({ minAge: 20, maxAge: 30, minEducation: 2 });

  assert.deepEqual(profileFilterDecision({ age: 19, educationLevel: 2 }, filter), {
    passed: false,
    reason: "age_below_min",
  });
  assert.deepEqual(profileFilterDecision({ age: 31, educationLevel: 2 }, filter), {
    passed: false,
    reason: "age_above_max",
  });
  assert.deepEqual(profileFilterDecision({ age: 24, educationLevel: 1 }, filter), {
    passed: false,
    reason: "education_below_min",
  });
  assert.deepEqual(profileFilterDecision({ age: 24, educationLevel: 3 }, filter), {
    passed: true,
    reason: "",
  });
});

test("normalizes dashboard profile filter values to safe bounds", () => {
  assert.deepEqual(normalizeProfileFilter({ minAge: 16, maxAge: 60, minEducation: "4" }), {
    minAge: 18,
    maxAge: 45,
    minEducation: 4,
  });
  assert.deepEqual(normalizeProfileFilter({ minAge: "", maxAge: "", minEducation: "" }), {
    minAge: null,
    maxAge: null,
    minEducation: null,
  });
});
