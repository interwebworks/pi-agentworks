import assert from "node:assert/strict";
import test from "node:test";
import { parseInitialStoryTitles } from "../src/infrastructure/controller/parent-management-gateway.ts";

test("an ordinary launch task remains one controller-owned story", () => {
  assert.deepEqual(parseInitialStoryTitles("Ship the dashboard"), [
    "Ship the dashboard",
  ]);
});

test("an explicit numbered Stories list creates independent initial stories", () => {
  assert.deepEqual(
    parseInitialStoryTitles(
      "UI smoke test. Stories: (1) reconnaissance, (2) architecture check, (3) delivery check. Do not edit files.",
    ),
    ["reconnaissance", "architecture check", "delivery check"],
  );
});

test("a malformed explicit list fails closed to one story", () => {
  assert.deepEqual(parseInitialStoryTitles("Stories: reconnaissance"), [
    "Stories: reconnaissance",
  ]);
});
