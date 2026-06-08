const normalize = (value) => String(value || "").toLowerCase().replace(/\s+/g, "");

function includesAny(text, values) {
  return values.some((value) => text.includes(normalize(value)));
}

export function applyHardFilters(candidate, profile) {
  const text = normalize([
    candidate.raw_text,
    candidate.education,
    candidate.school,
    candidate.major,
    candidate.expected_job,
    candidate.expected_city,
    candidate.salary_expectation,
  ].filter(Boolean).join(" "));
  const reasons = [];
  const riskFlags = [];

  if (!text) reasons.push("候选人卡片信息为空");

  const cities = (profile.city || []).filter(Boolean);
  if (cities.length && candidate.expected_city && !includesAny(normalize(candidate.expected_city), cities)) {
    reasons.push(`期望城市不匹配：${candidate.expected_city}`);
  }

  const education = normalize(candidate.education || candidate.raw_text);
  const requirements = (profile.education_requirements || []).map(normalize);
  if (requirements.length && /大专|专科|高中|中专/.test(education) && !includesAny(education, requirements)) {
    reasons.push("学历未达到岗位要求");
  }

  const unrelated = /销售|客服|行政|人力资源|财务|会计|市场营销|主播|采购|物业/.test(text);
  const technical = /ai|人工智能|大模型|编程|开发|算法|python|java|go|javascript|项目|计算机|软件|数据/.test(text);
  if (unrelated && !technical) reasons.push("求职方向与 AI 应用开发明显不相关");

  for (const condition of profile.reject_conditions || []) {
    if (/城市/.test(condition) && reasons.some((reason) => reason.includes("城市"))) riskFlags.push(condition);
    if (/方向/.test(condition) && reasons.some((reason) => reason.includes("方向"))) riskFlags.push(condition);
  }

  return {
    passed: reasons.length === 0,
    reasons,
    risk_flags: [...new Set(riskFlags)],
  };
}
