# Boss 招聘助手 Chrome 插件测试版

这是“插件入口 + 本地 App 执行”的测试版。插件不直接操作 Boss 页面 DOM，而是调用本地 Dashboard API，让现有 Node/CDP 链路继续负责岗位切换、打招呼、收简历和飞书同步。

## 安装

1. 打开 Chrome，进入 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`chrome-extension/`。
5. 固定插件图标。

## 使用前提

1. 先启动 `Boss招聘助手.app`，确认本地控制面板能打开。
2. 使用开启远程调试的 Chrome 登录 Boss 直聘招聘端。
3. 点击插件图标，确认本地服务显示“已连接”。
4. 选择岗位和模式，再启动“沟通页打招呼”“收取简历”等任务。

## 当前能力

- 打开本地 Dashboard。
- 读取本地 `config/jobs.json` 中的启用岗位。
- 分开展示推荐页任务和日常流程状态。
- 启动既有推荐页打招呼任务。
- 启动既有日常流程：沟通页打招呼、收简历、飞书同步。
- 暂停当前日常流程和推荐页任务。

## 实时调试

开发时不要反复打包 zip。直接把源码目录加载到 Chrome，改完刷新插件即可。

### 只调试插件界面

1. 打开 Chrome，进入 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目里的 `chrome-extension/` 目录。
5. 修改 `chrome-extension/popup/` 或 `chrome-extension/shared/` 下的源码。
6. 回到 `chrome://extensions`，在“Boss 招聘助手测试版”卡片上点击刷新图标。
7. 再点击浏览器右上角插件图标，查看最新效果。

如果要看报错：

1. 打开 `chrome://extensions`。
2. 找到“Boss 招聘助手测试版”。
3. 点击“检查视图”里的 popup 链接；如果没有显示，先点一次插件图标让 popup 打开。
4. 在 DevTools 的 Console 和 Network 面板查看错误和 API 请求。

### 调试本地 Dashboard API

如果改的是 `dashboard/server.mjs`、`orchestrator/` 或本地 API 逻辑，需要重启本地 Dashboard。开发期可以从源码启动，不必重新打包 `.app`：

```bash
BOSS_DATA_ROOT="$HOME/Library/Application Support/BossRecruiting/data" \
BOSS_CONFIG_ROOT="$HOME/Library/Application Support/BossRecruiting/config" \
BOSS_CONFIG_FILE="$HOME/Library/Application Support/BossRecruiting/config/default-config.yaml" \
BOSS_JOBS_FILE="$HOME/Library/Application Support/BossRecruiting/config/jobs.json" \
FEISHU_ENV_FILE="$HOME/Library/Application Support/BossRecruiting/config/feishu.env" \
BOSS_DASHBOARD_HOST=127.0.0.1 \
BOSS_DASHBOARD_PORT=8787 \
node dashboard/server.mjs
```

保持插件里的服务地址为 `http://127.0.0.1:8787`。这样插件访问的就是当前源码启动的 Dashboard。

### 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 插件显示“未连接” | 先启动 `Boss招聘助手.app`，或用上面的命令从源码启动 Dashboard。 |
| 修改插件后不生效 | 到 `chrome://extensions` 点击插件卡片上的刷新图标，然后重新打开 popup。 |
| 修改 API 后还是旧逻辑 | 关闭旧的 `Boss招聘助手.app` 或旧的源码服务，再重新运行 `node dashboard/server.mjs`。 |
| 按钮不可点 | 推荐任务或日常流程正在运行。先点“暂停流程”，或等待当前任务结束后重新打开插件。 |
| 真实执行前没有反应 | popup 会弹确认框；如果被浏览器遮挡，先检查 Chrome 是否阻止了弹窗或 popup 是否已关闭。 |

## 限制

- 插件本身不包含 Node、CDP Proxy、飞书密钥或本地文件访问能力。
- 必须先运行本地 App/Dashboard。
- 这是复用原链路的交付入口，不是纯插件离线执行版本。
