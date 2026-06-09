---
name: boss-auto-recruiting
description: Run the local Boss 直聘 recruitment scripts when the user asks to 打招呼、主动沟通、筛选候选人、收简历、上传飞书招聘 or run the complete Boss recruiting workflow. Always use the deployed scripts under /Users/apple/boss-auto-recruiting; never replace them with OpenClaw browser automation.
---

# Boss Auto Recruiting

This skill routes Boss recruiting requests to the existing local scripts.

## Mandatory routing

- For any Boss 招聘、打招呼、主动沟通、收简历 or 飞书招聘 request, use `exec` to run the scripts below.
- Do not use `openclaw browser`, the `browser` tool, snapshots, refs, direct JavaScript, or manual page refreshes.
- The scripts connect to the user's logged-in Chrome through the CDP proxy at `127.0.0.1:3456`.
- Run only one Boss workflow at a time. If a script reports a lock, captcha, login failure, platform warning, quota exhaustion, or paused state, stop and report it.
- Never claim success unless the script output or JSONL log confirms it.

## Scripts

```text
/Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs
/Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js
/Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs
```

Default job when the user does not provide one: `AI应用实习生`.

## Intent mapping

### Only greet recommended candidates

When the user asks to 打招呼 or 主动沟通, run only the recommendation stage:

```bash
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs \
  --job-name "AI应用实习生" \
  --max-greet-per-run 3 \
  --skip-chat
```

Replace `3` with the exact requested count. If no count is given, use `3`.
Do not add `--dry-run` when the user explicitly asks to send greetings.

### Dry-run greeting test

```bash
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs \
  --job-name "AI应用实习生" \
  --max-greet-per-run 3 \
  --skip-chat \
  --dry-run
```

### Process chat and request resumes

```bash
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs \
  --job-name "AI应用实习生" \
  --skip-recommend
```

### Collect visible resumes

```bash
node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js \
  --job-name "AI应用实习生"
```

### Upload collected resumes to Feishu Hire

```bash
node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply
```

### Complete workflow

Use one `exec` call so the phases remain serial:

```bash
set -e
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs --job-name "AI应用实习生"
node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js --job-name "AI应用实习生"
node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply
```

Only run the complete workflow when the user explicitly asks for the complete flow or names all three stages.

## Monitoring

If `exec` returns a running session, poll it with the `process` tool until it exits. Summarize the final JSON output.

Logs:

```text
/Users/apple/boss-auto-recruiting/data/briefs/boss-auto-lightweight-loop-run.jsonl
/Users/apple/boss-auto-recruiting/data/briefs/boss-auto-lightweight-loop-state.json
```

Before a real operation, the script itself checks the CDP connection, login state, captcha, quota, and task lock. Do not work around these checks.
