const DEFAULT_SERVICE_URL = "http://127.0.0.1:8787";
const serviceUrl = document.getElementById("serviceUrl");
const notice = document.getElementById("notice");

function show(message) {
  notice.textContent = message;
}

function normalize(value) {
  const url = new URL(String(value || DEFAULT_SERVICE_URL).trim().replace(/\/+$/, ""));
  if (url.protocol !== "http:") throw new Error("本地服务地址必须使用 http://");
  return url.origin;
}

async function render() {
  const stored = await chrome.storage.local.get({ serviceUrl: DEFAULT_SERVICE_URL });
  serviceUrl.value = stored.serviceUrl || DEFAULT_SERVICE_URL;
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ serviceUrl: normalize(serviceUrl.value) });
    show("已保存");
  } catch (error) {
    show(`保存失败：${error.message || error}`);
  }
});

document.getElementById("resetBtn").addEventListener("click", async () => {
  await chrome.storage.local.set({ serviceUrl: DEFAULT_SERVICE_URL });
  await render();
  show("已恢复默认");
});

render().catch((error) => show(`加载失败：${error.message || error}`));
