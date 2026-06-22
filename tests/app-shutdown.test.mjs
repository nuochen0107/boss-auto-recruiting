import assert from "node:assert/strict";
import test from "node:test";
import { createShutdownHandler } from "../dashboard/app-shutdown.mjs";

test("shutdown handler kills only the owned proxy process and calls exit", async () => {
  const events = [];
  const proxyProcess = {
    killed: false,
    kill(signal) {
      events.push(["kill", signal]);
      this.killed = true;
    },
  };
  const handler = createShutdownHandler({
    getProxyProcess: () => proxyProcess,
    setProxyProcess: (value) => events.push(["setProxy", value]),
    exit: (code) => events.push(["exit", code]),
    delayMs: 0,
  });

  const result = handler();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(result, { ok: true, shutting_down: true, proxy_stopped: true });
  assert.deepEqual(events, [["kill", "SIGTERM"], ["setProxy", null], ["exit", 0]]);
});

test("shutdown handler is safe when no owned proxy process exists", async () => {
  const events = [];
  const handler = createShutdownHandler({
    getProxyProcess: () => null,
    setProxyProcess: (value) => events.push(["setProxy", value]),
    exit: (code) => events.push(["exit", code]),
    delayMs: 0,
  });

  const result = handler();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(result, { ok: true, shutting_down: true, proxy_stopped: false });
  assert.deepEqual(events, [["exit", 0]]);
});
