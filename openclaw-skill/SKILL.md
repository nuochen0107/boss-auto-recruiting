---
name: boss-auto-recruiting
description: |
  Boss 直聘自动化招聘全流程 skill。
  当用户说“帮我完成 Boss 招聘全流程”“跑一下 Boss 招聘流程”“执行 Boss 自动招聘”等类似请求时，
  自动依次执行：
  1. 推荐页打招呼 + 聊天页筛选 + 发送求简历消息
  2. 收取候选人简历附件
  3. 同步到飞书招聘

  本 skill 只负责触发和监控本地已部署脚本，不在 skill 内实现浏览器自动化逻辑。
---

# Boss Auto Recruiting

## 定位

本 skill 负责**触发和监控**已部署在本地的 Boss 自动招聘工作流脚本。

当用户输入类似下面的消息时，应执行完整流程：

- 帮我完成 Boss 招聘全流程
- 跑一下 Boss 自动招聘
- 执行 Boss 招聘流程
- 帮我打招呼、收简历并同步飞书招聘
- 完成 Boss 招聘闭环
- 帮我处理 Boss 候选人并同步到飞书

完整流程必须按顺序串行执行：

1. 推荐页打招呼 + 聊天页筛选 + 发送求简历消息
2. 收取候选人发送的简历附件
3. 同步到飞书招聘

不要并发执行三个脚本。

---

## 脚本清单

所有 Boss 主流程脚本位于：

`/Users/apple/boss-auto-recruiting/boss-loop/`

| 脚本 | 作用 | 典型命令 |
|------|------|----------|
| `boss_lite_screen_and_greet.mjs` | 推荐页打招呼 + 聊天页筛选 + 发求简历消息 | `node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs --job-name Python` |
| `collect_visible_resumes.js` | 收取候选人发送的简历附件 | `node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js --job-name Python` |
| `sync-to-feishu.mjs` | 同步到飞书招聘 | `node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply` |

飞书招聘同步由独立 skill `feishu-hire-sync` 的脚本处理，不要在本 skill 内直接调用飞书 API。

---

## 用户意图识别

### 完整流程触发

当用户表达“完整 Boss 招聘流程”“Boss 招聘全流程”“打招呼、收简历、同步飞书”等意图时，应默认执行完整流程。

示例用户消息：

```text
帮我完成 Boss 招聘全流程，岗位是 Python
```

```text
跑一下 AI 应用开发实习生的 Boss 招聘全流程
```

```text
帮我打招呼、收简历并同步飞书招聘
```

### 单步执行触发

仅当用户明确指定某一步时，才单独执行对应脚本。

例如：

- 只帮我打招呼
- 只收取简历
- 只同步飞书招聘
- 跳过推荐页，只处理聊天页

---

## 用户参数识别

如果用户消息中包含岗位名，例如：

- 帮我完成 Boss 招聘全流程，岗位是 Python
- 跑一下 AI 应用开发实习生的招聘流程
- 帮我处理 Java 后端岗位

则提取岗位名，并传入 `--job-name`。

例如岗位名为 `AI应用开发实习生` 时：

```bash
--job-name "AI应用开发实习生"
```

如果用户没有提供岗位名，则使用配置文件里的默认 `job_name`，不要追问，直接执行。

配置文件路径：

`/Users/apple/boss-auto-recruiting/boss-loop/assets/default-config.yaml`

---

## 完整流程执行方式

当用户请求“完成 Boss 招聘全流程”时，必须用 `bash` + `background:true` 启动一个串行任务。

三个脚本必须串行执行，前一个脚本执行成功后，才能执行下一个脚本。

### 默认完整流程：用户提供岗位名

如果用户提供了岗位名，例如 `Python`，执行：

```bash
bash background:true command:"set -e
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs --job-name \"Python\"
node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js --job-name \"Python\"
node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply"
```

### 默认完整流程：用户没有提供岗位名

如果用户没有提供岗位名，可以省略 `--job-name`，让脚本读取默认配置：

```bash
bash background:true command:"set -e
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs
node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js
node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply"
```

### 跳过推荐页的完整流程

当用户说“只处理聊天页”“跳过推荐页”“不要推荐页打招呼”时，第一步增加 `--skip-recommend`：

```bash
bash background:true command:"set -e
node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs --job-name \"Python\" --skip-recommend
node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js --job-name \"Python\"
node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply"
```

---

## 单步执行方式

仅当用户明确要求单步执行时，才单独运行某个阶段。

### 只执行打招呼 / 筛选 / 求简历

```bash
bash background:true command:"node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs --job-name \"Python\""
```

### 只执行聊天页筛选 / 求简历，跳过推荐页

```bash
bash background:true command:"node /Users/apple/boss-auto-recruiting/boss-loop/boss_lite_screen_and_greet.mjs --job-name \"Python\" --skip-recommend"
```

### 只执行收取简历

```bash
bash background:true command:"node /Users/apple/boss-auto-recruiting/boss-loop/collect_visible_resumes.js --job-name \"Python\""
```

### 只执行飞书招聘同步

```bash
bash background:true command:"node /Users/apple/boss-auto-recruiting/feishu-sync/sync-to-feishu.mjs --apply"
```

---

## 监控与结果汇报

启动后台任务后，必须获取 `sessionId`，并用 `process` tool 持续查看实时输出。

脚本执行完成后，需要向用户汇报：

1. 第一阶段：推荐页打招呼 / 聊天页筛选 / 求简历消息发送结果
2. 第二阶段：简历附件收取结果
3. 第三阶段：飞书招聘同步结果
4. 是否出现异常
5. 下一步建议

运行日志路径：

`/Users/apple/boss-auto-recruiting/data/briefs/boss-auto-lightweight-loop-run.jsonl`

状态文件路径：

`/Users/apple/boss-auto-recruiting/data/briefs/boss-auto-lightweight-loop-state.json`

---

## 异常处理规则

完整流程中任何一步失败，都必须停止后续步骤。

`set -e` 用于保证前一个脚本失败时，后续脚本不会继续执行。

常见异常：

- `paused_captcha_detected`：Boss 出现验证码，需要人工处理
- `paused_login_required`：Boss 登录过期，需要重新扫码
- `paused_send_failed`：连续发送失败，可能是页面异常、网络异常或发送按钮识别失败
- `paused_boss_contact_quota_exhausted`：Boss 沟通额度耗尽
- `lock_exists`：已有任务正在运行，不能并发执行
- 退出码非 0：脚本异常退出

如果出现异常，应向用户汇报：

```text
Boss 招聘流程已暂停。

暂停阶段：第 X 步
暂停原因：xxx
建议处理：xxx
```

不要继续执行后续脚本。

---

## 前置依赖

执行前默认假设以下条件已满足：

- `web-access` CDP Proxy 已在 `localhost:3456` 运行
- Boss 直聘网页已登录
- 配置文件已设置默认 `job_name`
- 没有其他 Boss 自动化脚本正在运行
- 飞书招聘同步配置已完成

如果脚本返回登录、验证码或 lock 错误，再提示用户处理。

---

## 安全红线

- 不要并发执行多个 Boss 自动招聘流程
- 不要在高峰期 9:00-18:00 高频重复运行
- 首次测试新配置时，建议用户使用 `--dry-run`
- 不要在 skill 内直接实现浏览器点击、解析或飞书 API 调用逻辑
- 不要在本 skill 内直接调用飞书 API，同步飞书招聘必须通过 `feishu-hire-sync` 脚本完成

---

## 用户可直接发送的示例消息

用户可以直接发送：

```text
帮我完成 Boss 招聘全流程，岗位是 Python
```

或者：

```text
帮我完成 Boss 招聘全流程，岗位是 AI应用开发实习生
```

或者在没有岗位名时发送：

```text
帮我完成 Boss 招聘全流程
```

此时应自动读取配置文件中的默认岗位名，并依次执行三个脚本。
