import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function workflowTriggerBlock(content, trigger) {
  const match = new RegExp(`^  ${trigger}:\\n(?<body>(?:    .*(?:\\n|$))*)`, "m").exec(content);
  return match?.groups?.body ?? "";
}

export function checkWorkflowContracts(repoRoot) {
  const workflowsDir = join(repoRoot, ".github/workflows");
  const workflows = [
    { path: ".github/workflows/ci.yml", name: "CI" },
    { path: ".github/workflows/build-smoke.yml", name: "Build Smoke" },
    { path: ".github/workflows/playwright-e2e.yml", name: "Playwright E2E" },
  ];

  // main/release push 不跑分支质量门；合并前看 PR，发布看 tag，避免稳定版合入后和 Release Publish 重复。
  for (const workflow of workflows) {
    const content = readFileSync(join(repoRoot, workflow.path), "utf8");
    const pullRequestBlock = workflowTriggerBlock(content, "pull_request");
    const pushBlock = workflowTriggerBlock(content, "push");

    for (const snippet of ["      - dev", "      - main", '      - "release/**"']) {
      if (!pullRequestBlock.includes(snippet)) {
        throw new Error(`${workflow.name} pull_request trigger must keep branch snippet: ${snippet.trim()}`);
      }
    }
    if (!pushBlock.includes("      - dev")) {
      throw new Error(`${workflow.name} push trigger must keep branch snippet: dev`);
    }
    for (const blockedBranch of ["      - main", "release/"]) {
      if (pushBlock.includes(blockedBranch)) {
        throw new Error(`${workflow.name} push trigger must not include ${blockedBranch.trim()}; release checks run on PR and tag workflows.`);
      }
    }
  }

  const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release-publish.yml"), "utf8");
  for (const snippet of [
    "Validate stable tag source",
    "github.repository == 'zhiyingzzhou/renewlet' && steps.version.outputs.is-stable == 'true'",
    "git fetch origin main:refs/remotes/origin/main",
    "git merge-base --is-ancestor \"$TAG_SHA\" \"$MAIN_SHA\"",
  ]) {
    if (!releaseWorkflow.includes(snippet)) {
      throw new Error(`release-publish.yml must keep stable tag source guard: ${snippet}`);
    }
  }

  if (!readFileSync(join(repoRoot, ".github/workflows/build-smoke.yml"), "utf8").includes("workflow_dispatch:")) {
    throw new Error("Build Smoke must keep workflow_dispatch for manual no-secret build verification.");
  }

  const playwrightWorkflow = readFileSync(join(repoRoot, ".github/workflows/playwright-e2e.yml"), "utf8");
  for (const trigger of ["  schedule:", "  workflow_dispatch:"]) {
    if (!playwrightWorkflow.includes(trigger)) {
      throw new Error(`Playwright E2E must keep ${trigger.trim()} for main monitoring and manual verification.`);
    }
  }

  const overviewWorkflowPath = join(workflowsDir, "dockerhub-overview.yml");
  if (existsSync(overviewWorkflowPath)) {
    throw new Error("dockerhub-overview.yml must not exist; Docker Hub Overview is maintained through the official UI.");
  }

  // Docker 官方公开 OpenAPI 没有仓库描述写入口，页面元数据不得重新进入 Actions 或发布失败域。
  const unsupportedOverviewIntegrations = [
    "peter-evans/dockerhub-description",
    "scripts/dockerhub-overview.mjs",
    "hub.docker.com/v2/repositories",
  ];
  for (const entry of readdirSync(workflowsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.ya?ml$/.test(entry.name)) {
      continue;
    }
    const content = readFileSync(join(workflowsDir, entry.name), "utf8");
    for (const snippet of unsupportedOverviewIntegrations) {
      if (content.includes(snippet)) {
        throw new Error(`${entry.name} must not automate Docker Hub Overview through unsupported integration: ${snippet}`);
      }
    }
  }
}
