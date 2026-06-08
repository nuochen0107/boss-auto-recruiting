# Feishu Hire Resume Uploader

This tool connects the current OpenClaw/Boss resume download flow to Feishu Hire.

Default flow for Boss resumes:

1. Scan `/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes`.
2. Upload each local resume file to `POST /open-apis/hire/v1/attachments`.
3. Extract phone, email, identification, education history, work history, project history, skills, certificates, awards, and self-evaluation from the local resume text when available.
4. Reuse an existing Feishu Hire talent when phone, email, or identification is available in the manifest or extracted from the resume.
5. Otherwise create a Feishu Hire talent with `POST /open-apis/hire/v1/talents/combined_create`.
6. Attach the uploaded resume file as `resume_attachment_id`.
7. Create a job application with `POST /open-apis/hire/v1/applications`.
8. Optionally add the talent to a Feishu Hire talent pool.
9. Record uploaded files in `state.json` by content hash to avoid duplicate uploads.
10. Skip duplicate inferred candidate names by default, keeping the newest local file.

## Setup

Copy `.env.example` to a private env file and fill in values:

```bash
cp /Users/apple/ai-worker/feishu-hire-uploader/.env.example /Users/apple/ai-worker/feishu-hire-uploader/.env.local
```

Required Feishu permissions for the default flow:

```text
hire:attachment
hire:talent
hire:application
```

If you set `FEISHU_HIRE_TALENT_POOL_ID`, also request:

```text
hire:talent_folder
```

If you set `FEISHU_HIRE_CREATE_NOTE=1`, also request:

```text
hire:note
```

You also need `FEISHU_HIRE_JOB_ID`. You can get it from `GET /open-apis/hire/v1/jobs`.
For a fresh hiring round, prefer keeping `job_id` out of the manifest and letting this env var control the target position.

## Dry Run

Dry run scans files and writes no Feishu data:

```bash
set -a
source /Users/apple/ai-worker/feishu-hire-uploader/.env.local
set +a
node /Users/apple/ai-worker/feishu-hire-uploader/upload-resumes.mjs --dry-run
```

## Real Upload

Use `--apply` only after dry run looks correct:

```bash
set -a
source /Users/apple/ai-worker/feishu-hire-uploader/.env.local
set +a
node /Users/apple/ai-worker/feishu-hire-uploader/upload-resumes.mjs --apply
```

If you are reusing the same local resume folder for a new Feishu job, point `FEISHU_HIRE_UPLOAD_STATE` to a fresh file first. The uploader deduplicates by content hash and will skip files that already succeeded in the old state file.

## Optional Candidate Manifest

If OpenClaw can output candidate metadata, point `FEISHU_HIRE_CANDIDATE_MANIFEST` to a JSON array or JSONL file. Metadata is strongly recommended because Feishu Hire uses phone, email, or identification for talent uniqueness.

When a manifest is present, the uploader treats it as the source of truth and only processes files that have a matching manifest record. The recommended Boss queue keys are `candidate_id`, `external_id`, and `boss_status`.

For `talent_application` mode, the script parses local PDFs with PyMuPDF layout lines (`get_text("dict")`) instead of relying only on raw plain-text order. It uses coordinates to rebuild reading order, extracts contacts and resume sections, then validates education/work entries before creating or reusing the talent. The parser also follows the `openclaw/skills` `resume-parser` schema idea by writing a local `resume_structured` snapshot with `basic_info`, `education`, `work_experience`, `projects`, `skills`, `certificates`, `awards`, and `self_assessment`.

Only Feishu Hire official fields are sent to `combined_create` / `combined_update`: `basic_info`, `education_list`, `career_list`, `project_list`, and `self_evaluation`. Extra structured fields stay in local state for review and future mapping instead of being sent to unsupported API fields.

For the current Boss -> Feishu contract, upstream Boss data should stay minimal:

- Stable mapping keys:
  - `candidate_id`
  - `external_id`
  - `boss_status`
- Raw upstream context only:
  - `card_work_experience_text`
  - `card_education_experience_text`
- Local handoff:
  - `local_resume_path`
  - `resume_hash`
  - `resume_source_id`

The uploader does not rely on Boss-provided `education_list` or `career_list`; it prefers locally parsed PDF content. If a trusted manifest already contains structured lists, they are used only when local parsing does not produce a list. The parser intentionally drops low-confidence entries such as scholarship rows, campus roles, GPA/course rows, reversed date ranges, and project/award rows that look like work history.

Example JSONL:

```jsonl
{"filename":"Python_王力_河海大学_20260427.pdf","candidate_id":"王力__河海大学","external_id":"王力__河海大学","boss_status":"boss_completed","name":"王力","school":"河海大学","card_work_experience_text":"2025.11-2026.04 科大讯飞 · Python","card_education_experience_text":"2022-2026 河海大学 · 计算机科学与技术 · 本科","resume_source_id":"7115289562569591070","local_resume_path":"/Users/apple/Documents/boss-auto-lightweight-loop-python/resumes/Python_王力_河海大学_20260427.pdf"}
```

Useful manifest fields:

```text
candidate_id
external_id
boss_status
filename
name
school
card_work_experience_text
card_education_experience_text
mobile
mobile_code
mobile_country_code
email
identification
resume_source_id
talent_pool_id
folder_id_list
application_preferred_city_code_list
education_list
career_list
project_list
self_evaluation
resume_structured
```

Legacy compatibility:
`candidate_uid` and `boss_candidate_uid` are still accepted for older manifests, but new Boss queue exports should prefer `candidate_id` plus `external_id`.

For a new hiring round, keep `job_id` out of the manifest and set `FEISHU_HIRE_JOB_ID` in your env file instead.

When no manifest exists, the script infers the candidate name from the resume filename. Talent creation may fail if your Feishu Hire standard resume settings require phone or email.

If two files infer to the same candidate name, the script keeps only the newest file by default. To allow same-name uploads, set:

```bash
FEISHU_HIRE_ALLOW_DUPLICATE_NAMES=1
```

## Modes

Default:

```bash
FEISHU_HIRE_UPLOAD_MODE=talent_application
```

This uploads the resume, extracts contacts from the local PDF when possible, creates/reuses talent, creates a job application, and optionally adds the talent to a talent pool.

Contact enrichment for already-created talents:

```bash
FEISHU_HIRE_UPLOAD_MODE=talent_enrich node /Users/apple/ai-worker/feishu-hire-uploader/upload-resumes.mjs --apply
```

This reads the local PDF text, extracts contacts, and patches the existing talent with `combined_update`.

Talent only:

```bash
FEISHU_HIRE_UPLOAD_MODE=talent_basic node /Users/apple/ai-worker/feishu-hire-uploader/upload-resumes.mjs --apply
```

Legacy website delivery:

```bash
FEISHU_HIRE_UPLOAD_MODE=website_attachment node /Users/apple/ai-worker/feishu-hire-uploader/upload-resumes.mjs --apply
```
