export function createShutdownHandler({
  getProxyProcess,
  setProxyProcess,
  exit = process.exit,
  delayMs = 150,
} = {}) {
  return function shutdownApp() {
    const proxyProcess = getProxyProcess?.() || null;
    const proxyStopped = Boolean(proxyProcess && !proxyProcess.killed);
    if (proxyStopped) {
      try {
        proxyProcess.kill("SIGTERM");
      } catch {}
      setProxyProcess?.(null);
    }

    setTimeout(() => exit(0), delayMs);
    return { ok: true, shutting_down: true, proxy_stopped: proxyStopped };
  };
}
