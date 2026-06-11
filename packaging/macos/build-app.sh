#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_DIR="$ROOT/dist"
BUILD_DIR="$ROOT/build/macos"
APP_NAME="Boss招聘助手"
APP_DIR="$DIST_DIR/$APP_NAME.app"
CONTENTS_DIR="$APP_DIR/Contents"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/runtime"
PROJECT_DIR="$RESOURCES_DIR/project"
NODE_VERSION="${NODE_VERSION:-v22.22.3}"
ARCH="$(uname -m)"

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
PYTHON_ENV=(env DYLD_LIBRARY_PATH="/opt/homebrew/opt/expat/lib")
if ! "${PYTHON_ENV[@]}" "$ROOT/.venv/bin/python3" -c "import fitz, PyInstaller" >/dev/null 2>&1; then
  echo "虚拟环境缺少 PyMuPDF 或 PyInstaller，请先执行：.venv/bin/pip install PyMuPDF pyinstaller" >&2
  exit 1
fi

rm -rf "$BUILD_DIR" "$APP_DIR"
mkdir -p "$BUILD_DIR" "$DIST_DIR" "$CONTENTS_DIR/MacOS" "$RUNTIME_DIR/bin" "$PROJECT_DIR" "$RESOURCES_DIR/defaults"

NODE_ARCHIVE="node-${NODE_VERSION}-darwin-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
if [ ! -f "$BUILD_DIR/$NODE_ARCHIVE" ]; then
  echo "下载 Node.js ${NODE_VERSION}..."
  curl -fL "$NODE_URL" -o "$BUILD_DIR/$NODE_ARCHIVE"
fi
tar -xzf "$BUILD_DIR/$NODE_ARCHIVE" -C "$BUILD_DIR"
cp "$BUILD_DIR/node-${NODE_VERSION}-darwin-arm64/bin/node" "$RUNTIME_DIR/bin/node"

echo "编译 macOS Vision OCR..."
swiftc "$ROOT/feishu-sync/uploader/scripts/ocr_vision.swift" \
  -O -o "$RUNTIME_DIR/bin/boss-vision-ocr"

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
/usr/bin/rsync -a \
  --exclude '.git' \
  --exclude '.venv' \
  --exclude '.env.local' \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude 'build' \
  --exclude 'dist' \
  --exclude 'packaging' \
  --exclude 'boss-loop/assets/default-config.yaml' \
  --exclude '.DS_Store' \
  "$ROOT/" "$PROJECT_DIR/"

cp "$ROOT/packaging/macos/default-config.yaml" "$RESOURCES_DIR/defaults/default-config.yaml"
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

cat >"$CONTENTS_DIR/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>Boss招聘助手</string>
  <key>CFBundleExecutable</key><string>BossRecruiting</string>
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
