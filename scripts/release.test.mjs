import assert from "node:assert/strict";
import test from "node:test";
import { allowedNextVersions } from "./release.mjs";

test("allows standard patch and hotfix patch after 0.2.9", () => {
  assert.deepEqual(allowedNextVersions("0.2.9"), ["0.2.10", "0.2.91", "0.3.0", "1.0.0"]);
});

test("keeps next release choices based on the latest stable tag", () => {
  const allowed = allowedNextVersions("0.2.10");

  assert.deepEqual(allowed, ["0.2.11", "0.2.101", "0.3.0", "1.0.0"]);
  assert.equal(allowed.includes("0.2.91"), false);
});

test("allows standard and hotfix patch lines after an early minor patch", () => {
  assert.deepEqual(allowedNextVersions("0.3.2"), ["0.3.3", "0.3.21", "0.4.0", "1.0.0"]);
});

test("continues an existing hotfix patch line through standard patch increment", () => {
  const allowed = allowedNextVersions("0.3.21");

  assert.equal(allowed.includes("0.3.22"), true);
});

test("deduplicates standard and hotfix patch choices after patch zero", () => {
  assert.deepEqual(allowedNextVersions("0.1.0"), ["0.1.1", "0.2.0", "1.0.0"]);
});
