# 国产大模型配置

项目会自动读取根目录的 `.env.local`。只需填写一组 OpenAI 兼容配置：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_KEY=你的密钥
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

修改配置后需要重启 Dashboard：

```bash
./start-control-panel.sh
```

## MiniMax Token/Coding Plan

```dotenv
LLM_PROVIDER=minimax
LLM_API_KEY=sk-cp-你的密钥
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_MODEL=MiniMax-M2.7
```

## 阿里云百炼按量 API

```dotenv
LLM_PROVIDER=dashscope
LLM_API_KEY=sk-你的百炼通用密钥
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_MODEL=qwen-plus
```

百炼 Coding Plan 专属 Key 不允许用于自定义应用后端，本项目应使用百炼按量 API Key。

## DeepSeek

经济型：

```dotenv
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-你的密钥
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-v4-flash
```

更高质量：

```dotenv
LLM_MODEL=deepseek-v4-pro
```

## 安全要求

- 不要把 Key 写入源码或 `default-config.yaml`。
- `.env.local` 已被 `.gitignore` 排除。
- 首次推送前运行 `git status --ignored` 检查敏感文件是否被忽略。
