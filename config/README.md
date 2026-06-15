# 岗位路由配置

编辑 `jobs.json` 维护 Boss 岗位到飞书招聘岗位的映射。

```json
{
  "job_key": "ai_app_intern",
  "display_name": "AI应用实习生",
  "boss_job_names": ["AI应用实习生"],
  "feishu_hire_job_id": "填写飞书招聘岗位 ID",
  "enabled": true
}
```

- `job_key`：项目内部稳定标识，启用后不要随意修改。
- `display_name`：Dashboard 展示名称。
- `boss_job_names`：Boss 沟通列表可能出现的岗位名称或别名。
- `feishu_hire_job_id`：对应的飞书招聘岗位 ID；沟通和收简历阶段允许留空，同步阶段必须填写。
- `enabled`：是否参与识别和执行。

macOS App 使用：

```text
~/Library/Application Support/BossRecruiting/config/jobs.json
```

修改配置后需要重启 Dashboard 或 App。

日常流程的执行方式：

1. 沟通阶段按 `jobs.json` 中启用的岗位逐个切换 Boss 沟通页岗位筛选。
2. 收简历阶段使用 Boss 全局姓名搜索，并用姓名和岗位共同确认会话。
3. 下载后的简历保存到 `data/resumes/<job_key>/`。
