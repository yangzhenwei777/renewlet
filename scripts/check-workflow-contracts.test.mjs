import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkWorkflowContracts } from "./check-workflow-contracts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function workflowFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "renewlet-workflow-contracts-"));
  const fixtureWorkflows = join(fixtureRoot, ".github/workflows");
  mkdirSync(join(fixtureRoot, ".github"), { recursive: true });
  cpSync(join(repoRoot, ".github/workflows"), fixtureWorkflows, { recursive: true });
  return fixtureRoot;
}

function withWorkflowFixture(run) {
  const fixtureRoot = workflowFixture();
  try {
    run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

test("accepts the current workflow contract", () => {
  withWorkflowFixture((fixtureRoot) => {
    assert.doesNotThrow(() => checkWorkflowContracts(fixtureRoot));
  });
});

test("rejects unsupported Docker Hub Overview integrations in every workflow", async (t) => {
  const integrations = [
    "uses: peter-evans/dockerhub-description@v5",
    "run: node scripts/dockerhub-overview.mjs --ref main",
    "run: curl -X PATCH https://hub.docker.com/v2/repositories/zhiyingzzhou/renewlet",
  ];

  for (const integration of integrations) {
    await t.test(integration, () => {
      withWorkflowFixture((fixtureRoot) => {
        writeFileSync(
          join(fixtureRoot, ".github/workflows/unsupported-overview.yaml"),
          `name: Unsupported Overview\njobs:\n  sync:\n    steps:\n      - ${integration}\n`,
        );

        assert.throws(
          () => checkWorkflowContracts(fixtureRoot),
          /must not automate Docker Hub Overview through unsupported integration/,
        );
      });
    });
  }
});

test("rejects restoring the retired Docker Hub Overview workflow", () => {
  withWorkflowFixture((fixtureRoot) => {
    writeFileSync(
      join(fixtureRoot, ".github/workflows/dockerhub-overview.yml"),
      "name: Docker Hub Overview\n",
    );

    assert.throws(
      () => checkWorkflowContracts(fixtureRoot),
      /dockerhub-overview\.yml must not exist/,
    );
  });
});
