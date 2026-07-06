import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(new URL("../boss-loop/boss_lite_screen_and_greet.mjs", import.meta.url), "utf8");

function functionBody(name) {
  const start = source.indexOf(`async function ${name}()`);
  assert.notEqual(start, -1, `${name} exists`);
  const next = source.indexOf("\nasync function ", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test("recommend navigation uses fixed URL before fallback clicks", () => {
  const body = functionBody("gotoRecommend");
  const navigate = body.indexOf("/web/chat/recommend");
  const click = body.indexOf("clickSelector");

  assert.ok(navigate > -1, "gotoRecommend navigates to the recommend URL");
  assert.ok(click > -1, "gotoRecommend keeps a click fallback");
  assert.ok(navigate < click, "fixed URL navigation happens before fallback click");
});

test("chat navigation uses fixed URL before fallback clicks", () => {
  const body = functionBody("gotoChat");
  const navigate = body.indexOf("/web/chat/index");
  const click = body.indexOf("clickSelector");

  assert.ok(navigate > -1, "gotoChat navigates to the chat URL");
  assert.ok(click > -1, "gotoChat keeps a click fallback");
  assert.ok(navigate < click, "fixed URL navigation happens before fallback click");
});

test("profile filter reads only the top candidate profile text", () => {
  const body = functionBody("processInbound");

  assert.match(source, /profileText:/);
  assert.match(source, /base-info-single-top-detail/);
  assert.match(source, /base-info-single-detial/);
  assert.match(body, /parseCandidateProfile\(opened\.detail\.profileText \|\| ''\)/);
  assert.doesNotMatch(body, /parseCandidateProfile\(opened\.detail\.rightText \|\| ''\)/);
});
