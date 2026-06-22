# 岗位路由配置

优先在 Dashboard 的“岗位配置”中维护 Boss 岗位到飞书招聘岗位的映射。
v1.0 交付包默认不内置岗位，HR 首次打开 App 后自行新增岗位。

如需手工排查，也可以直接编辑 `jobs.json`：

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
- `feishu_hire_job_id`：对应的飞书招聘岗位 ID；沟通和收简历阶段允许留空。留空岗位会参与 Boss 流程，但执行“全部岗位”飞书同步时会被跳过；只有明确同步该岗位时才必须填写。
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
4. 飞书同步只处理已配置 `feishu_hire_job_id` 的岗位，未配置岗位的简历留在本地和队列中等待后续路由。
