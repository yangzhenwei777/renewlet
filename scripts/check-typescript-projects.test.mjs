import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { checkTypeScriptProjects } from "./check-typescript-projects.mjs";

const repository = resolve(import.meta.dirname, "..");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "renewlet-typescript-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of [
    "tsconfig.json", "tsconfig.scripts.json", "tsconfig.playwright.json",
    "packages/shared/tsconfig.json", "apps/worker/tsconfig.json",
    "apps/web/tsconfig.json", "apps/web/tsconfig.base.json",
    "apps/website/tsconfig.json", "apps/website/tsconfig.app.json", "apps/website/tsconfig.node.json",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(repository, file), join(root, file));
  }
  for (const source of [
    "scripts", "e2e", "playwright.config.ts", "playwright.cloudflare-check.config.ts",
    "packages/shared/src", "packages/shared/data", "apps/worker/src",
    "apps/web/src", "apps/web/vite", "apps/web/scripts", "apps/web/lingui.config.ts", "apps/web/vite.config.ts", "apps/web/vitest.config.ts",
    "apps/website/src", "apps/website/tests", "apps/website/scripts", "apps/website/vite.config.ts", "apps/website/playwright.config.ts",
  ]) symlinkSync(join(repository, source), join(root, source));
  return root;
}

function changeConfig(root, file, change) {
  const path = join(root, file);
  const { config, error } = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  assert.equal(error, undefined);
  change(config);
  writeFileSync(path, JSON.stringify(config));
}

test("the real solution checks every owned TypeScript source with isolated incremental caches", () => {
  checkTypeScriptProjects(repository);
});

test("removing scripts from the solution cannot turn the root gate into a successful no-op", (t) => {
  const root = fixture(t);
  changeConfig(root, "tsconfig.json", (config) => {
    config.references = config.references.filter((reference) => reference.path !== "./tsconfig.scripts.json");
  });
  assert.throws(() => checkTypeScriptProjects(root), /excludes tsconfig.scripts.json/);
});

test("a narrower include cannot silently drop browser regressions", (t) => {
  const root = fixture(t);
  changeConfig(root, "tsconfig.playwright.json", (config) => {
    config.exclude = ["e2e/subscriptions.spec.ts"];
  });
  assert.throws(() => checkTypeScriptProjects(root), /excludes .*subscriptions.spec.ts/);
});

test("website strictness and cache ownership cannot be relaxed", (t) => {
  const root = fixture(t);
  changeConfig(root, "apps/website/tsconfig.app.json", (config) => { config.compilerOptions.strict = false; });
  assert.throws(() => checkTypeScriptProjects(root), /must be strict/);
  changeConfig(root, "apps/website/tsconfig.app.json", (config) => { config.compilerOptions.strict = true; });
  changeConfig(root, "apps/website/tsconfig.node.json", (config) => {
    config.compilerOptions.tsBuildInfoFile = "./node_modules/.tmp/tsconfig.app.tsbuildinfo";
  });
  assert.throws(() => checkTypeScriptProjects(root), /with its own cache/);
});
