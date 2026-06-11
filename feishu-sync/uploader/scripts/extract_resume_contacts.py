#!/usr/bin/env python3

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import fitz


PHONE_RE = re.compile(r"(?<!\d)(?:\+?86[-\s]?)?(1[3-9]\d[-\s]?\d{4}[-\s]?\d{4})(?!\d)")
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
ID_RE = re.compile(r"(?<!\d)(\d{17}[\dXx])(?!\d)")
DATE_RANGE_RE = re.compile(
    r"(?P<start_y>20\d{2}|19\d{2})(?:[./年-]\s*(?P<start_m>1[0-2]|0?[1-9])月?)?"
    r"\s*(?:-|--|~|—|–|至|到)\s*"
    r"(?:(?P<end_y>20\d{2}|19\d{2})(?:[./年-]\s*(?P<end_m>1[0-2]|0?[1-9])月?)?|(?P<present>至今|今|现在|Present|present))"
)
SECTION_ALIASES = {
    "education": ("教育背景", "教育经历", "学习经历"),
    "career": ("工作经历", "实习经历", "实践经历", "职业经历"),
    "project": ("项目经历", "项目经验"),
    "skill": ("专业技能", "工作技能", "相关技能", "技能特长", "技能清单", "个人能力"),
    "certificate": ("证书", "资格证书", "荣誉证书", "专业证书", "语言证书"),
    "award": ("荣誉奖项", "获奖经历", "个人奖项"),
    "self_evaluation": ("自我评价", "个人评价", "个人简介"),
}
STOP_SECTION_NAMES = tuple(name for names in SECTION_ALIASES.values() for name in names) + (
    "在校经历",
    "校园经历",
    "爱好",
)
DEGREE_MAP = (
    ("博士", 8),
    ("硕士", 7),
    ("研究生", 7),
    ("本科", 6),
    ("学士", 6),
    ("大专", 5),
    ("专科", 5),
    ("高中", 4),
    ("中专", 3),
)


def unique(seq):
    seen = set()
    out = []
    for item in seq:
      if item and item not in seen:
        seen.add(item)
        out.append(item)
    return out


def extract_text(pdf_path: Path) -> str:
    doc = fitz.open(str(pdf_path))
    try:
        return "\n".join(page.get_text("text") for page in doc)
    finally:
        doc.close()


def extract_layout_lines(pdf_path: Path):
    doc = fitz.open(str(pdf_path))
    try:
        lines = []
        for page_index, page in enumerate(doc):
            page_dict = page.get_text("dict")
            for block in page_dict.get("blocks", []):
                if block.get("type") != 0:
                    continue
                for line in block.get("lines", []):
                    spans = line.get("spans", [])
                    text = clean_line("".join(span.get("text", "") for span in spans))
                    if not text or is_noise_line(text):
                        continue
                    x0, y0, x1, y1 = line.get("bbox", (0, 0, 0, 0))
                    lines.append({
                        "page": page_index,
                        "x0": float(x0),
                        "y0": float(y0),
                        "x1": float(x1),
                        "y1": float(y1),
                        "text": text,
                    })
        return sorted(lines, key=lambda item: (item["page"], round(item["y0"], 1), item["x0"]))
    finally:
        doc.close()


def extract_ocr_text(pdf_path: Path):
    if os.environ.get("FEISHU_HIRE_DISABLE_OCR") == "1":
        return "", "disabled"

    tesseract = shutil.which("tesseract")
    vision_binary = os.environ.get("BOSS_VISION_OCR_BIN") or shutil.which("boss-vision-ocr")
    vision_ocr = shutil.which("swift")

    chunks = []
    try:
        doc = fitz.open(str(pdf_path))
        try:
            with tempfile.TemporaryDirectory(prefix="resume-ocr-") as tmpdir:
                for page_index, page in enumerate(doc):
                    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
                    image_path = Path(tmpdir) / f"page-{page_index + 1}.png"
                    pix.save(str(image_path))
                    page_text = ""
                    if tesseract:
                        page_text = run_tesseract(tesseract, image_path, "chi_sim+eng")
                        if not page_text:
                            page_text = run_tesseract(tesseract, image_path, "eng")
                    if not page_text and vision_binary:
                        page_text = run_vision_binary(vision_binary, image_path)
                    if not page_text and vision_ocr:
                        page_text = run_vision_ocr(vision_ocr, image_path)
                    if page_text:
                        chunks.append(page_text)
        finally:
            doc.close()
    except Exception as exc:  # OCR is best-effort; caller reports the status.
        return "", f"ocr_failed:{type(exc).__name__}"

    text = "\n".join(chunks)
    if normalized_lines(text):
        return text, "tesseract_ok" if tesseract else "vision_ok"
    if not tesseract and not vision_binary and not vision_ocr:
        return "", "ocr_engine_not_found"
    if not tesseract:
        return "", "vision_empty"
    return "", "empty"


def run_tesseract(tesseract: str, image_path: Path, lang: str) -> str:
    try:
        completed = subprocess.run(
            [tesseract, str(image_path), "stdout", "-l", lang],
            capture_output=True,
            check=False,
            text=True,
            timeout=90,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout


def run_vision_ocr(swift: str, image_path: Path) -> str:
    script = Path(__file__).with_name("ocr_vision.swift")
    if not script.exists():
        return ""
    try:
        completed = subprocess.run(
            [swift, str(script), str(image_path)],
            capture_output=True,
            check=False,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout


def run_vision_binary(binary: str, image_path: Path) -> str:
    try:
        completed = subprocess.run(
            [binary, str(image_path)],
            capture_output=True,
            check=False,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout


def choose_text_source(pdf_path: Path):
    layout_lines = extract_layout_lines(pdf_path)
    if layout_lines:
        text = layout_text(layout_lines)
        return text, [line["text"] for line in layout_lines], "layout_text", ""

    raw_lines = normalized_lines(extract_text(pdf_path))
    if has_enough_resume_text(raw_lines):
        text = "\n".join(raw_lines)
        return text, raw_lines, "plain_text", ""

    ocr_text, ocr_status = extract_ocr_text(pdf_path)
    ocr_lines = normalized_lines(ocr_text)
    if has_enough_resume_text(ocr_lines):
        text = "\n".join(ocr_lines)
        return text, ocr_lines, "ocr", ocr_status

    text = "\n".join(raw_lines)
    return text, raw_lines, "image_pdf_no_ocr", ocr_status


def has_enough_resume_text(lines) -> bool:
    if len(lines) >= 5:
        return True
    joined = "\n".join(lines)
    return bool(PHONE_RE.search(joined) or EMAIL_RE.search(joined) or any(section_kind(line) for line in lines))


def layout_text(lines) -> str:
    return "\n".join(line["text"] for line in lines)


def clean_line(line: str) -> str:
    line = re.sub(r"[\u2022⚫▪●·\uf06c]\s*", "", line)
    line = re.sub(r"\s+", " ", line).strip(" \t\r\n|")
    if re.fullmatch(r"[A-Za-z0-9_\-~]{24,}", line):
        return ""
    return line


def is_noise_line(line: str) -> bool:
    if line == "~":
        return True
    if re.fullmatch(r"[A-Za-z0-9_\-~]{24,}", line):
        return True
    return False


def normalized_lines(text: str):
    return [line for line in (clean_line(raw) for raw in text.splitlines()) if line]


def is_section_heading(line: str) -> bool:
    compact = re.sub(r"[\s:：]+", "", line)
    return compact in STOP_SECTION_NAMES


def section_kind(line: str):
    compact = re.sub(r"[\s:：]+", "", line)
    for kind, names in SECTION_ALIASES.items():
        if compact in names:
            return kind
    return None


def split_sections(lines):
    sections = []
    current = {"kind": "unknown", "title": "", "lines": []}
    for line in lines:
        kind = section_kind(line)
        remainder = ""
        if not kind:
            for possible_kind, names in SECTION_ALIASES.items():
                for name in names:
                    if line.startswith(f"{name}:") or line.startswith(f"{name}："):
                        kind = possible_kind
                        remainder = line[len(name) + 1 :].strip()
                        break
                if kind:
                    break
        if not kind and (
            is_section_heading(line)
            or any(line.startswith(f"{name}:") or line.startswith(f"{name}：") for name in STOP_SECTION_NAMES)
        ):
            kind = "ignore"
        if kind:
            if current["lines"]:
                sections.append(current)
            current = {"kind": kind, "title": line, "lines": []}
            if remainder:
                current["lines"].append(remainder)
            continue
        current["lines"].append(line)
    if current["lines"]:
        sections.append(current)
    return sections


def month_to_ms(year, month, default_month=1):
    if not year:
        return ""
    month = int(month or default_month)
    dt = datetime(int(year), month, 1, tzinfo=timezone.utc)
    return str(int(dt.timestamp() * 1000))


def ms_to_ym(value: str) -> str:
    timestamp = ms_to_int(value)
    if not timestamp:
        return ""
    return datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).strftime("%Y-%m")


def parse_date_range(text: str):
    match = DATE_RANGE_RE.search(text)
    if not match:
        return None
    return {
        "start_time": month_to_ms(match.group("start_y"), match.group("start_m")),
        "end_time": "" if match.group("present") else month_to_ms(match.group("end_y"), match.group("end_m")),
        "raw": match.group(0),
    }


def ms_to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def date_range_is_valid(date_range):
    if not date_range:
        return False
    start = ms_to_int(date_range.get("start_time"))
    end = ms_to_int(date_range.get("end_time"))
    return bool(start) and (not end or end >= start)


def degree_from_text(text: str):
    for keyword, value in DEGREE_MAP:
        if keyword in text:
            return value
    return None


def strip_date_range(text: str) -> str:
    return DATE_RANGE_RE.sub("", text).strip(" |-—–")


def clean_school(value: str) -> str:
    value = re.sub(r"[（(].*?[）)]", "", value)
    return value.strip(" |，,")


def parse_school_and_field(text: str, context):
    parts = [part for part in [text] + context if part]
    normalized = " ".join(parts)
    school_match = re.search(
        r"([\u4e00-\u9fa5A-Za-z·（）()]*?(?:大学|学院|学校|University|College|Institute)(?:[（(][^）)]*[）)])?)",
        normalized,
    )
    if school_match:
        school = clean_school(school_match.group(1))
        after = normalized[school_match.end():]
    else:
        school_line = next((part for part in parts if re.search(r"(大学|学院|学校|University|College|Institute)", part)), "")
        school = clean_school(school_line)
        after = normalized

    degree = degree_from_text(normalized)
    field = after
    field = re.sub(r"[（(].*?[）)]", "", field)
    field = re.sub(r"(博士|硕士|研究生|本科|学士|大专|专科|高中|中专|学位|学历|一本|二本|方向|GPA.*|核心课程.*|成绩.*)", " ", field)
    field = re.sub(r"\s+", " ", field).strip(" |，,")
    return school, field[:120], degree


def compact_desc(lines, limit=1600):
    text = "\n".join(line for line in lines if line and not is_section_heading(line)).strip()
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text[:limit]


def is_missing_project_name(value: str) -> bool:
    value = value.strip(" |，,")
    if not value:
        return True
    if value in ("-", "--", "—", "——", "无", "暂无"):
        return True
    normalized = value.strip("·.。:： ")
    if re.fullmatch(r"(?:\d+\s*个?月|至今|现在|Present|present)", normalized):
        return True
    return False


def clean_project_name(value: str) -> str:
    value = strip_date_range(value)
    value = re.sub(r"^\d+[、.]\s*", "", value)
    value = re.sub(r"^项目(?:名称|名)?[:：]?", "", value).strip(" |，,")
    value = value.strip("·.。:： ")
    if is_missing_project_name(value):
        return ""
    if parse_date_range(value) or is_section_heading(value):
        return ""
    if re.fullmatch(r"(?:项目|课题)?负责人|(?:项目|课题)?成员|(?:前端|后端|全栈|算法|测试)?开发(?:工程师)?", value):
        return ""
    if re.match(r"^(技术栈|技术架构|项目描述|项目职责|职责|主要工作|使用技术)[:：]", value):
        return ""
    if len(value) > 80:
        return ""
    return value


def infer_project_name(prelude, date_line: str, block):
    candidates = [strip_date_range(date_line)]

    for line in block[:6]:
        label_match = re.search(r"项目(?:名称|名)[:：]\s*(.+)", line)
        if label_match:
            candidates.insert(0, label_match.group(1))
        candidates.append(line)

    for line in prelude[-4:]:
        candidates.append(line)

    for candidate in candidates:
        name = clean_project_name(candidate)
        if name:
            return name[:120]
    return ""


def project_desc_lines(prelude, block, project_name: str):
    lines = []
    for line in prelude + block[1:]:
        clean_name = clean_project_name(line)
        if project_name and clean_name == project_name:
            continue
        if is_missing_project_name(line):
            continue
        lines.append(line)
    return lines


def is_project_title_line(lines, idx: int) -> bool:
    name = clean_project_name(lines[idx])
    if not name:
        return False
    if re.match(r"^(项目描述|项目职责|职责|主要工作|个人贡献|项目背景)[:：]", lines[idx]):
        return False
    next_line = lines[idx + 1] if idx + 1 < len(lines) else ""
    next_next_line = lines[idx + 2] if idx + 2 < len(lines) else ""
    detail_label_re = r"^(技术栈|技术架构|项目描述|项目职责|职责|主要工作|使用技术)[:：]"
    if re.match(detail_label_re, next_line):
        return True
    if clean_project_name(next_line) == "" and re.match(detail_label_re, next_next_line):
        return True
    return idx == 0 and len(lines) > 1


def split_project_blocks_without_dates(lines):
    title_indexes = [idx for idx in range(len(lines)) if is_project_title_line(lines, idx)]
    if len(title_indexes) <= 1:
        return [lines]
    blocks = []
    for pos, idx in enumerate(title_indexes):
        next_idx = title_indexes[pos + 1] if pos + 1 < len(title_indexes) else len(lines)
        blocks.append(lines[idx:next_idx])
    return blocks


def looks_like_bad_experience_text(text: str) -> bool:
    bad_keywords = (
        "奖学金",
        "三好学生",
        "学年获",
        "GPA",
        "核心课程",
        "班级排名",
        "专业排名",
        "学生会",
        "院团委",
        "校科协",
        "比赛",
        "大赛",
    )
    return any(keyword in text for keyword in bad_keywords)


def parse_education_sections(sections):
    items = []
    for section in sections:
        if section["kind"] != "education":
            continue
        lines = section["lines"]
        for idx, line in enumerate(lines):
            date_text = line
            date_range = parse_date_range(date_text)
            if not date_range and idx + 1 < len(lines):
                date_text = f"{line} {lines[idx + 1]}"
                date_range = parse_date_range(date_text)
            if not date_range or not date_range_is_valid(date_range):
                continue

            item = {
                "start_time": date_range["start_time"],
                "end_time": date_range["end_time"],
            }
            without_date = strip_date_range(date_text)
            context = lines[max(0, idx - 4):idx] + [without_date] + lines[idx + 1 : idx + 4]
            context_text = " ".join(context)

            if "|" in without_date:
                parts = [part.strip() for part in without_date.split("|") if part.strip()]
                if parts:
                    item["school"] = clean_school(parts[0])
                detail = " ".join(parts[1:])
            else:
                school, field, parsed_degree = parse_school_and_field(
                    without_date,
                    lines[max(0, idx - 4):idx] + lines[idx + 1 : idx + 3],
                )
                if school:
                    item["school"] = school
                detail = field
                if parsed_degree:
                    item["degree"] = parsed_degree

            degree = degree_from_text(context_text)
            if degree:
                item["degree"] = degree

            field = re.sub(r"[（(].*?[）)]", "", detail)
            field = re.sub(r"(博士|硕士|研究生|本科|学士|大专|专科|高中|中专|学位|学历|一本|二本|方向)", "", field)
            field = re.sub(r"(?:[~至到\-—–]\s*)?(?:20\d{2}|19\d{2})[年./-]\s*(?:1[0-2]|0?[1-9])月?", " ", field)
            field = field.replace("”", "").replace('"', "")
            field = field.strip(" |，,")
            if field:
                item["field_of_study"] = field[:120]

            if item.get("school") and not looks_like_bad_experience_text(item.get("school", "")):
                items.append(item)
    return dedupe_items(items, ("school", "field_of_study", "start_time"))


def parse_company_and_title(head: str):
    head = re.sub(r"^\d+[、.]\s*", "", head).strip()
    if "|" in head:
        parts = [part.strip() for part in head.split("|") if part.strip()]
        company = parts[0] if parts else ""
        title = parts[1] if len(parts) > 1 else ""
        return company[:120], title[:120]

    title = ""
    company = head
    title_match = re.search(r"(.+?)\s+([^\s]{2,30}(?:工程师|开发|实习生|助理|经理|专员|算法|分析师|研究员|顾问|负责人|部长))$", head)
    if title_match:
        company = title_match.group(1).strip()
        title = title_match.group(2).strip()
    return company[:120], title[:120]


def career_item_is_valid(item) -> bool:
    text = " ".join(str(value) for value in item.values())
    if not date_range_is_valid(item):
        return False
    if looks_like_bad_experience_text(text):
        return False
    company = item.get("company", "")
    if not company:
        return bool(item.get("desc"))
    if len(company) > 80:
        return False
    if any(keyword in company for keyword in ("项目名称", "联系电话", "电子邮箱", "教育背景", "自我介绍")):
        return False
    return True


def parse_career_sections(sections):
    items = []
    for section in sections:
        if section["kind"] != "career":
            continue
        lines = section["lines"]
        date_indexes = [idx for idx, line in enumerate(lines) if parse_date_range(line)]
        for pos, idx in enumerate(date_indexes):
            line = lines[idx]
            date_range = parse_date_range(line)
            if not date_range_is_valid(date_range):
                continue
            next_idx = date_indexes[pos + 1] if pos + 1 < len(date_indexes) else len(lines)
            block = lines[idx:next_idx]
            head = strip_date_range(line)
            item = {
                "start_time": date_range["start_time"],
                "end_time": date_range["end_time"],
                "career_type": 1 if "实习" in section["title"] or "实习" in " ".join(block[:3]) else 2,
            }

            if "|" in head:
                company, title = parse_company_and_title(head)
                if company:
                    item["company"] = company
                if title:
                    item["title"] = title
                desc_lines = block[1:]
            else:
                company, title = parse_company_and_title(head)
                if not company:
                    company = next((part for part in block[1:4] if part and not parse_date_range(part)), "")
                if company:
                    item["company"] = company[:120]
                if title:
                    item["title"] = title[:120]
                desc_start = 1
                if company and len(block) > 1 and block[1] == company:
                    desc_start = 2
                desc_lines = block[desc_start:]

            desc = compact_desc(desc_lines)
            if desc:
                item["desc"] = desc
            if career_item_is_valid(item):
                items.append(item)
    return dedupe_items(items, ("company", "title", "start_time"))


def parse_project_sections(sections):
    projects = []
    for section in sections:
        if section["kind"] != "project":
            continue
        lines = section["lines"]
        date_indexes = [idx for idx, line in enumerate(lines) if parse_date_range(line)]
        if not date_indexes and lines:
            for block in split_project_blocks_without_dates(lines):
                name = infer_project_name([], "", block)
                desc = compact_desc(project_desc_lines([], block, name), 1600)
                if not desc and not name:
                    continue
                project = {"desc": desc}
                if name:
                    project["name"] = name
                projects.append(project)
            continue
        for pos, idx in enumerate(date_indexes):
            line = lines[idx]
            date_range = parse_date_range(line)
            if not date_range_is_valid(date_range):
                continue
            prev_idx = date_indexes[pos - 1] + 1 if pos > 0 else 0
            next_idx = date_indexes[pos + 1] if pos + 1 < len(date_indexes) else len(lines)
            prelude = lines[prev_idx:idx]
            block = lines[idx:next_idx]
            name = infer_project_name(prelude, line, block)
            project = {
                "start_time": date_range["start_time"],
                "end_time": date_range["end_time"],
            }
            if name:
                project["name"] = name[:120]
            desc = compact_desc(project_desc_lines([], block, name))
            if desc:
                project["desc"] = desc
            if project.get("name") or project.get("desc"):
                projects.append(project)
    return dedupe_items(projects, ("name", "start_time"))


def parse_self_evaluation(sections):
    for section in sections:
        if section["kind"] == "self_evaluation":
            content = compact_desc(section["lines"], 1200)
            if content:
                return {"content": content}
    return None


def parse_basic_info(text: str, lines, pdf_path: Path):
    top_lines = [line for line in lines[:12] if line]
    name = ""
    filename_match = re.search(r"】([\u4e00-\u9fa5·]{2,6})\s", pdf_path.name)
    if filename_match:
        name = filename_match.group(1)
    if top_lines:
        for line in top_lines[:5]:
            candidate = re.split(r"[|｜:：,，\s]", line.strip())[0]
            if name:
                break
            if candidate in ("电话", "邮箱", "求职意向", "教育经历", "个人奖项"):
                continue
            if re.fullmatch(r"[\u4e00-\u9fa5·]{2,6}", candidate) and not section_kind(candidate):
                name = candidate
                break

    gender = ""
    gender_match = re.search(r"(?<![\u4e00-\u9fa5])(男|女)(?![\u4e00-\u9fa5])", " ".join(top_lines))
    if gender_match:
        gender = gender_match.group(1)

    age = None
    age_match = re.search(r"(?<!\d)(\d{2})\s*岁", " ".join(top_lines))
    if age_match:
        age = int(age_match.group(1))

    location = ""
    location_match = re.search(r"(?:现居|所在地|城市|地点)[:：]?\s*([\u4e00-\u9fa5]{2,10})", " ".join(top_lines))
    if location_match:
        location = location_match.group(1)

    return {
        "name": name,
        "phone": "",
        "email": "",
        "age": age,
        "gender": gender,
        "location": location,
        "work_years": None,
    }


def split_list_items(lines):
    items = []
    for line in lines:
        line = re.sub(r"^[\-\d、.]+\s*", "", line).strip()
        if not line or is_section_heading(line):
            continue
        parts = re.split(r"[；;]\s*", line)
        for part in parts:
            part = part.strip(" ，,。")
            if part:
                items.append(part)
    return unique(items)


def parse_skills(sections):
    skill_lines = []
    language_lines = []
    for section in sections:
        if section["kind"] != "skill":
            continue
        for line in section["lines"]:
            if re.search(r"(英语|CET|雅思|托福|普通话|日语|韩语|六级|四级)", line, re.I):
                language_lines.append(line)
            else:
                skill_lines.append(line)
    return {
        "technical": split_list_items(skill_lines),
        "soft": [],
        "languages": split_list_items(language_lines),
    }


def parse_named_list_sections(sections, kind):
    lines = []
    for section in sections:
        if section["kind"] == kind:
            lines.extend(section["lines"])
    return split_list_items(lines)


def extract_technologies(lines):
    tech_lines = []
    for line in lines:
        match = re.search(r"(?:技术栈|技术架构|使用技术|开发环境)[:：]\s*(.+)", line)
        if match:
            tech_lines.append(match.group(1))
    tokens = []
    for line in tech_lines:
        for token in re.split(r"[,，、/|｜+；;\s]+", line):
            token = token.strip(" .。:：")
            if len(token) >= 2:
                tokens.append(token)
    return unique(tokens)


def extract_achievements(lines):
    achievements = []
    for line in lines:
        if re.search(r"(提升|降低|减少|增长|达到|完成|实现|优化|准确率|成功率|用户|数据|%|％|\d+\+?)", line):
            achievements.append(line)
    return achievements[:20]


def feishu_education_to_schema(items):
    reverse_degree = {
        8: "博士",
        7: "硕士",
        6: "本科",
        5: "专科",
        4: "高中",
        3: "中专",
    }
    return [
        {
            "school": item.get("school", ""),
            "major": item.get("field_of_study", ""),
            "degree": reverse_degree.get(item.get("degree"), ""),
            "start_date": ms_to_ym(item.get("start_time", "")),
            "end_date": ms_to_ym(item.get("end_time", "")) if item.get("end_time") else "至今",
            "gpa": "",
            "courses": [],
        }
        for item in items
    ]


def feishu_career_to_schema(items):
    out = []
    for item in items:
        desc = item.get("desc", "")
        desc_lines = normalized_lines(desc)
        out.append({
            "company": item.get("company", ""),
            "position": item.get("title", ""),
            "start_date": ms_to_ym(item.get("start_time", "")),
            "end_date": ms_to_ym(item.get("end_time", "")) if item.get("end_time") else "至今",
            "description": desc,
            "achievements": extract_achievements(desc_lines),
            "technologies": extract_technologies(desc_lines),
        })
    return out


def feishu_projects_to_schema(items):
    out = []
    for item in items:
        desc = item.get("desc", "")
        desc_lines = normalized_lines(desc)
        role = next(
            (
                line
                for line in desc_lines[:4]
                if re.fullmatch(r"(?:项目|课题)?负责人|(?:项目|课题)?成员|核心开发|前端开发|后端开发|全栈开发|算法开发", line)
            ),
            "",
        )
        out.append({
            "name": item.get("name", ""),
            "role": role,
            "start_date": ms_to_ym(item.get("start_time", "")),
            "end_date": ms_to_ym(item.get("end_time", "")) if item.get("end_time") else ("至今" if item.get("start_time") else ""),
            "description": desc,
            "technologies": extract_technologies(desc_lines),
            "achievements": extract_achievements(desc_lines),
        })
    return out


def build_resume_structured(pdf_path: Path, text: str, lines, sections, education_list, career_list, project_list, self_evaluation):
    basic_info = parse_basic_info(text, lines, pdf_path)
    mobiles = unique([re.sub(r"\D", "", m.group(1)) for m in PHONE_RE.finditer(text)])
    emails = unique(EMAIL_RE.findall(text))
    if mobiles:
        basic_info["phone"] = mobiles[0]
    if emails:
        basic_info["email"] = emails[0]

    return {
        "basic_info": basic_info,
        "education": feishu_education_to_schema(education_list),
        "work_experience": feishu_career_to_schema(career_list),
        "projects": feishu_projects_to_schema(project_list),
        "skills": parse_skills(sections),
        "certificates": parse_named_list_sections(sections, "certificate"),
        "awards": parse_named_list_sections(sections, "award"),
        "self_assessment": (self_evaluation or {}).get("content", ""),
    }


def dedupe_items(items, keys):
    seen = set()
    out = []
    for item in items:
        key = tuple(item.get(name, "") for name in keys)
        if key in seen:
            continue
        seen.add(key)
        out.append({k: v for k, v in item.items() if v not in ("", None, [])})
    return out[:100]


def main() -> int:
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: extract_resume_contacts.py <pdf_path>"}), file=sys.stderr)
        return 2

    pdf_path = Path(sys.argv[1])
    if not pdf_path.exists():
        print(json.dumps({"error": f"file not found: {pdf_path}"}), file=sys.stderr)
        return 2

    text, lines, parser_mode, ocr_status = choose_text_source(pdf_path)
    sections = split_sections(lines)
    mobiles = unique([re.sub(r"\D", "", m.group(1)) for m in PHONE_RE.finditer(text)])
    emails = unique(EMAIL_RE.findall(text))
    ids = unique([m.group(1) for m in ID_RE.finditer(text)])
    education_list = parse_education_sections(sections)
    career_list = parse_career_sections(sections)
    project_list = parse_project_sections(sections)
    self_evaluation = parse_self_evaluation(sections)
    resume_structured = build_resume_structured(
        pdf_path,
        text,
        lines,
        sections,
        education_list,
        career_list,
        project_list,
        self_evaluation,
    )

    result = {
        "file": str(pdf_path),
        "mobile": mobiles[0] if mobiles else "",
        "mobile_candidates": mobiles,
        "mobile_country_code": "CN_1" if mobiles else "",
        "email": emails[0] if emails else "",
        "email_candidates": emails,
        "identification_type": 1 if ids else "",
        "identification_number": ids[0] if ids else "",
        "identification_candidates": ids,
        "education_list": education_list,
        "career_list": career_list,
        "project_list": project_list,
        "self_evaluation": self_evaluation,
        "resume_structured": resume_structured,
        "text_length": len(text),
        "parser_mode": parser_mode,
        "ocr_status": ocr_status,
    }

    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
