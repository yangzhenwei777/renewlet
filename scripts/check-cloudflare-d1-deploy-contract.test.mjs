import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkCloudflareD1DeployContract } from "./check-cloudflare-d1-deploy-contract.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contractFiles = [
  ".github/workflows/cloudflare-worker.yml",
  ".github/workflows/release-publish.yml",
  "package.json",
  "scripts/cloudflare-deploy.ts",
  "apps/worker/src/index.ts",
  "docs/cloudflare-workers-deploy.md",
  "docs/cloudflare-workers-deploy.zh-CN.md",
];

function withContractFixture(
  transform,
  run,
) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "renewlet-d1-deploy-contract-"));
  try {
    for (const relativePath of contractFiles) {
      const destination = join(fixtureRoot, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      const source = readFileSync(join(repoRoot, relativePath), "utf8");
      writeFileSync(destination, transform(relativePath, source), "utf8");
    }
    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("the repository keeps the complete D1 deployment contract", () => {
  assert.doesNotThrow(() => checkCloudflareD1DeployContract(repoRoot));
});

test("rejects cancellable deployments and workflow-owned migration writes", () => {
  withContractFixture(
    (relativePath, source) => relativePath === ".github/workflows/cloudflare-worker.yml"
      ? source.replace("cancel-in-progress: false", "cancel-in-progress: true")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /cancel-in-progress: false/,
    ),
  );

  withContractFixture(
    (relativePath, source) => relativePath === ".github/workflows/cloudflare-worker.yml"
      ? source.replace("pnpm deploy -- --config", "pnpm cloudflare:migrations:apply && pnpm deploy -- --config")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /must not duplicate orchestrator operation/,
    ),
  );
});

test("rejects missing failure containment and independent recovery commands", () => {
  withContractFixture(
    (relativePath, source) => relativePath === "scripts/cloudflare-deploy.ts"
      ? source.replaceAll("recordRecoveryHint", "missingRecoveryHint")
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /recordRecoveryHint/,
    ),
  );

  withContractFixture(
    (relativePath, source) => relativePath === "docs/cloudflare-workers-deploy.md"
      ? `${source}\n\nwrangler d1 time-travel restore DB --bookmark=unsafe\n`
      : source,
    (fixtureRoot) => assert.throws(
      () => checkCloudflareD1DeployContract(fixtureRoot),
      /outside the deployment orchestrator/,
    ),
  );
});
