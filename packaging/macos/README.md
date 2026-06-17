# macOS 应用打包

目标产物是 Apple 芯片 macOS 应用 `Boss招聘助手.app`。

应用内置：

- Boss 招聘助手 App 图标
- Node.js 运行时
- PyMuPDF 简历解析器
- 基于 macOS Vision 的中英文 OCR
- Dashboard、Boss 自动化和飞书同步代码

目标电脑只需安装 Google Chrome。Node、Python、PyMuPDF、Tesseract 和
Xcode Command Line Tools 都不需要安装。

## 构建

构建电脑需要项目现有 `.venv`，并安装 PyInstaller：

```bash
.venv/bin/pip install PyMuPDF pyinstaller
INCLUDE_LOCAL_CONFIG=1 ./packaging/macos/build-app.sh
```

`INCLUDE_LOCAL_CONFIG=1` 会把当前
`feishu-sync/uploader/.env.local` 放入应用包，适合公司内部受控分发。
不传这个变量则不会打包飞书密钥。

产物：

```text
dist/Boss招聘助手.app
dist/Boss招聘助手-macOS-arm64.zip
```

## 目标电脑使用

1. 解压并把 App 拖到“应用程序”。
2. 首次打开若被 macOS 阻止，在“系统设置 -> 隐私与安全性”中允许打开。
3. 打开 Chrome，登录 Boss 直聘招聘端。
4. 打开 `chrome://inspect/#remote-debugging` 并启用远程调试。
5. 双击“Boss招聘助手”，浏览器会打开 `http://127.0.0.1:8787`。

运行数据位于：

```text
~/Library/Application Support/BossRecruiting
```

其中 `config/jobs.json` 保存 Boss 岗位到飞书岗位的路由，
`config/feishu.env` 保存飞书配置，`data/resumes/<job_key>` 按岗位保存简历，
`logs` 保存面板和浏览器连接日志。
