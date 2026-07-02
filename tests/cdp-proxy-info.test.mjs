import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../deps/web-access/scripts/cdp-proxy.mjs", import.meta.url), "utf8");

function routeBody(routeMarker) {
  const start = source.indexOf(routeMarker);
  assert.notEqual(start, -1, `${routeMarker} exists`);
  const next = source.indexOf("\n    else if (pathname ===", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("/info includes the target browserContextId for download routing", () => {
  const body = routeBody("else if (pathname === '/info')");

  assert.match(body, /Target\.getTargets/, "/info looks up target metadata");
  assert.match(body, /browserContextId/, "/info returns browserContextId");
});
