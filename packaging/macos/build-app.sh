#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_DIR="$ROOT/dist"
BUILD_DIR="$ROOT/build/macos"
CACHE_DIR="$ROOT/build/cache"
APP_NAME="Boss招聘助手"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/runtime"
PROJECT_DIR="$RESOURCES_DIR/project"
APP_ICON_SOURCE="$ROOT/packaging/macos/assets/AppIcon.icns"
NODE_VERSION="${NODE_VERSION:-v22.22.3}"
ARCH="$(uname -m)"
OCR_CACHE="$CACHE_DIR/boss-vision-ocr-arm64"

if [ "$ARCH" != "arm64" ]; then
  echo "当前构建脚本只支持 Apple 芯片 Mac，检测到：$ARCH" >&2
  exit 1
fi

for command in curl tar swiftc; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "构建电脑缺少 $command。构建电脑需要 Xcode Command Line Tools，使用 App 的电脑不需要。" >&2
    exit 1
  fi
done

if [ ! -x "$ROOT/.venv/bin/python3" ]; then
  echo "缺少项目虚拟环境：$ROOT/.venv" >&2
  exit 1
fi
PYTHON_ENV=(
  env
  DYLD_LIBRARY_PATH="/opt/homebrew/opt/expat/lib"
  PYINSTALLER_CONFIG_DIR="$BUILD_DIR/pyinstaller-config"
)
if ! "${PYTHON_ENV[@]}" "$ROOT/.venv/bin/python3" -c "import fitz, PyInstaller" >/dev/null 2>&1; then
  echo "虚拟环境缺少 PyMuPDF 或 PyInstaller，请先执行：.venv/bin/pip install PyMuPDF pyinstaller" >&2
  exit 1
fi

NODE_ARCHIVE="node-${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
mkdir -p "$CACHE_DIR"
if [ ! -f "$CACHE_DIR/$NODE_ARCHIVE" ] && [ -f "$BUILD_DIR/$NODE_ARCHIVE" ]; then
  cp "$BUILD_DIR/$NODE_ARCHIVE" "$CACHE_DIR/$NODE_ARCHIVE"
fi
if [ ! -x "$OCR_CACHE" ] && [ -x "$RUNTIME_DIR/bin/boss-vision-ocr" ]; then
  cp "$RUNTIME_DIR/bin/boss-vision-ocr" "$OCR_CACHE"
fi

rm -rf "$BUILD_DIR" "$APP_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR" "$CONTENTS_DIR/MacOS" "$RUNTIME_DIR/bin" "$PROJECT_DIR" "$RESOURCES_DIR/defaults"

if [ ! -f "$CACHE_DIR/$NODE_ARCHIVE" ]; then
  echo "下载 Node.js ${NODE_VERSION}..."
  curl -fL "$NODE_URL" -o "$CACHE_DIR/$NODE_ARCHIVE"
fi
tar -xzf "$CACHE_DIR/$NODE_ARCHIVE" -C "$BUILD_DIR"
cp "$BUILD_DIR/node-${NODE_VERSION}-darwin-arm64/bin/node" "$RUNTIME_DIR/bin/node"

echo "编译 macOS Vision OCR..."
mkdir -p "$BUILD_DIR/swift-module-cache"
if swiftc "$ROOT/feishu-sync/uploader/scripts/ocr_vision.swift" \
  -module-cache-path "$BUILD_DIR/swift-module-cache" \
  -target arm64-apple-macos13.0 \
  -O -o "$RUNTIME_DIR/bin/boss-vision-ocr"; then
  cp "$RUNTIME_DIR/bin/boss-vision-ocr" "$OCR_CACHE"
elif [ -x "$OCR_CACHE" ]; then
  echo "Swift 编译环境不可用，改用已验证的本地 OCR 构建缓存。"
  cp "$OCR_CACHE" "$RUNTIME_DIR/bin/boss-vision-ocr"
else
  echo "无法编译 macOS Vision OCR，且不存在可用的本地构建缓存。" >&2
  exit 1
fi

echo "打包 PyMuPDF 简历解析器..."
"${PYTHON_ENV[@]}" "$ROOT/.venv/bin/python3" -m PyInstaller \
  --noconfirm \
  --clean \
  --onefile \
  --name resume-extractor \
  --distpath "$RUNTIME_DIR/bin" \
  --workpath "$BUILD_DIR/pyinstaller-work" \
  --specpath "$BUILD_DIR" \
  "$ROOT/feishu-sync/uploader/scripts/extract_resume_contacts.py"

echo "复制应用代码..."
for directory in boss-loop config dashboard orchestrator feishu-sync; do
  /usr/bin/rsync -a \
    --exclude '.env.local' \
    --exclude 'data' \
    --exclude '__pycache__' \
    --exclude '*.pyc' \
    --exclude '.DS_Store' \
    "$ROOT/$directory/" "$PROJECT_DIR/$directory/"
done

mkdir -p "$PROJECT_DIR/deps/web-access/scripts"
/usr/bin/rsync -a \
  --exclude '.env.local' \
  --exclude '.DS_Store' \
  "$ROOT/deps/web-access/scripts/" "$PROJECT_DIR/deps/web-access/scripts/"

cp "$ROOT/packaging/macos/default-config.yaml" "$RESOURCES_DIR/defaults/default-config.yaml"
cp "$ROOT/config/jobs.json" "$RESOURCES_DIR/defaults/jobs.json"
cp "$APP_ICON_SOURCE" "$RESOURCES_DIR/AppIcon.icns"
cp "$ROOT/packaging/macos/default-config.yaml" "$PROJECT_DIR/boss-loop/assets/default-config.yaml"
cp "$ROOT/packaging/macos/launcher.sh" "$CONTENTS_DIR/MacOS/BossRecruiting"
chmod 755 "$CONTENTS_DIR/MacOS/BossRecruiting" "$RUNTIME_DIR/bin/"*

if [ "${INCLUDE_LOCAL_CONFIG:-0}" = "1" ] && [ -f "$ROOT/feishu-sync/uploader/.env.local" ]; then
  /usr/bin/sed -E \
    -e '/^(RESUME_DIR|FEISHU_HIRE_CANDIDATE_MANIFEST|FEISHU_HIRE_UPLOAD_STATE|FEISHU_HIRE_SYNC_STATE|FEISHU_HIRE_SYNC_STATE_FILE|FEISHU_HIRE_SYNC_RESUME_DIR)=/d' \
    "$ROOT/feishu-sync/uploader/.env.local" >"$RESOURCES_DIR/defaults/feishu.env"
  chmod 600 "$RESOURCES_DIR/defaults/feishu.env"
  echo "已将当前飞书配置写入应用包。请仅在公司内部安全分发。"
fi

echo "校验应用包完整性..."
required_files=(
  "$RUNTIME_DIR/bin/node"
  "$RUNTIME_DIR/bin/resume-extractor"
  "$RUNTIME_DIR/bin/boss-vision-ocr"
  "$PROJECT_DIR/dashboard/server.mjs"
  "$PROJECT_DIR/orchestrator/legacy_pipeline_runner.mjs"
  "$PROJECT_DIR/orchestrator/recommend_greet_runner.mjs"
  "$PROJECT_DIR/boss-loop/boss_lite_screen_and_greet.mjs"
  "$PROJECT_DIR/boss-loop/collect_visible_resumes.js"
  "$PROJECT_DIR/feishu-sync/sync-to-feishu.mjs"
  "$PROJECT_DIR/feishu-sync/uploader/upload-resumes.mjs"
  "$PROJECT_DIR/config/job-router.cjs"
  "$PROJECT_DIR/deps/web-access/scripts/cdp-proxy.mjs"
  "$RESOURCES_DIR/AppIcon.icns"
  "$RESOURCES_DIR/defaults/default-config.yaml"
  "$RESOURCES_DIR/defaults/jobs.json"
)
for file in "${required_files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "应用包缺少运行文件：$file" >&2
    exit 1
  fi
done

"$RUNTIME_DIR/bin/node" --check "$PROJECT_DIR/dashboard/server.mjs"
"$RUNTIME_DIR/bin/node" --check "$PROJECT_DIR/orchestrator/legacy_pipeline_runner.mjs"
"$RUNTIME_DIR/bin/node" --check "$PROJECT_DIR/orchestrator/recommend_greet_runner.mjs"
"$RUNTIME_DIR/bin/node" -e \
  "const r=require(process.argv[1]); const c=r.loadJobsConfig(process.argv[2]); if (!Array.isArray(c.jobs)) process.exit(1)" \
  "$PROJECT_DIR/config/job-router.cjs" "$PROJECT_DIR"

cat >"$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Boss招聘助手</string>
  <key>CFBundleExecutable</key><string>BossRecruiting</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.nuochen.boss-recruiting</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Boss招聘助手</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

/usr/bin/codesign --force --deep --sign - "$APP_DIR"
ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$DIST_DIR/$APP_NAME-macOS-arm64.zip"

echo
echo "构建完成："
echo "  $APP_DIR"
echo "  $DIST_DIR/$APP_NAME-macOS-arm64.zip"
echo
echo "目标电脑不需要安装 Node、Python、PyMuPDF、Tesseract 或 Xcode Command Line Tools。"
