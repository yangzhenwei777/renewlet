import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function runIn(cwd, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed in ${cwd}: ${command} ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}

function writeText(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function initGitRepo(path) {
  mkdirSync(path, { recursive: true });
  runIn(path, "git", ["init", "-b", "main"]);
  runIn(path, "git", ["config", "user.name", "Renewlet Test"]);
  runIn(path, "git", ["config", "user.email", "renewlet-test@example.invalid"]);
}

function findJsonBinding(config, key, binding) {
  const match = Array.isArray(config[key])
    ? config[key].find((item) => item && typeof item === "object" && item.binding === binding)
    : undefined;
  if (!match) throw new Error(`Expected ${binding} in ${key}.`);
  return match;
}

function findJsonQueueProducer(config, binding) {
  return Array.isArray(config.queues?.producers)
    ? config.queues.producers.find((item) => item && typeof item === "object" && item.binding === binding)
    : undefined;
}

function findJsonQueueConsumer(config, queueName) {
  return Array.isArray(config.queues?.consumers)
    ? config.queues.consumers.find((item) => item && typeof item === "object" && item.queue === queueName)
    : undefined;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function preserveCloudflareGeneratedConfig(repoPath) {
  const config = readJson(join(repoPath, "wrangler.jsonc"));
  const d1 = findJsonBinding(config, "d1_databases", "DB");
  const r2 = findJsonBinding(config, "r2_buckets", "ASSETS_BUCKET");
  const queue = findJsonQueueProducer(config, "MEDIA_ICON_INDEX_REFRESH_QUEUE");
  const queueConsumer = queue?.queue ? findJsonQueueConsumer(config, queue.queue) : undefined;
  return {
    name: config.name,
    databaseName: d1.database_name,
    databaseId: d1.database_id,
    bucketName: r2.bucket_name,
    mediaIconIndexRefreshQueueName: queue?.queue,
    mediaIconIndexRefreshDeadLetterQueueName: queueConsumer?.dead_letter_queue,
    vars: config.vars && typeof config.vars === "object" && !Array.isArray(config.vars) ? config.vars : {},
  };
}

function applyCloudflareGeneratedConfig(repoPath, preserved) {
  const config = readJson(join(repoPath, "wrangler.jsonc"));
  const d1 = findJsonBinding(config, "d1_databases", "DB");
  const r2 = findJsonBinding(config, "r2_buckets", "ASSETS_BUCKET");
  const queue = findJsonQueueProducer(config, "MEDIA_ICON_INDEX_REFRESH_QUEUE");
  config.name = preserved.name;
  d1.database_name = preserved.databaseName;
  d1.database_id = preserved.databaseId;
  r2.bucket_name = preserved.bucketName;
  if (queue && preserved.mediaIconIndexRefreshQueueName) {
    const templateQueueName = queue.queue;
    queue.queue = preserved.mediaIconIndexRefreshQueueName;
    const consumer = findJsonQueueConsumer(config, templateQueueName) ?? findJsonQueueConsumer(config, preserved.mediaIconIndexRefreshQueueName);
    if (consumer) {
      consumer.queue = preserved.mediaIconIndexRefreshQueueName;
      if (preserved.mediaIconIndexRefreshDeadLetterQueueName) {
        consumer.dead_letter_queue = preserved.mediaIconIndexRefreshDeadLetterQueueName;
      }
    }
  }
  config.vars = {
    ...(config.vars && typeof config.vars === "object" && !Array.isArray(config.vars) ? config.vars : {}),
    ...preserved.vars,
  };
  writeFileSync(join(repoPath, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`);
}

function simulateSyncRenewletUpstream(generatedRepo, upstreamRepo, tempDir) {
  mkdirSync(tempDir, { recursive: true });
  const preserved = preserveCloudflareGeneratedConfig(generatedRepo);
  const workflowsBackup = join(tempDir, "workflows-backup");
  const workflowsPath = join(generatedRepo, ".github/workflows");
  if (existsSync(workflowsPath)) {
    cpSync(workflowsPath, workflowsBackup, { recursive: true });
  }

  const existingUpstream = spawnSync("git", ["remote", "get-url", "upstream"], {
    cwd: generatedRepo,
    encoding: "utf8",
  });
  if (existingUpstream.status === 0) {
    runIn(generatedRepo, "git", ["remote", "set-url", "upstream", upstreamRepo]);
  } else {
    runIn(generatedRepo, "git", ["remote", "add", "upstream", upstreamRepo]);
  }
  runIn(generatedRepo, "git", ["fetch", "upstream", "main"]);
  runIn(generatedRepo, "git", ["restore", "--source", "FETCH_HEAD", "--staged", "--worktree", ":/"]);

  if (existsSync(workflowsBackup)) {
    rmSync(workflowsPath, { recursive: true, force: true });
    mkdirSync(workflowsPath, { recursive: true });
    cpSync(workflowsBackup, workflowsPath, { recursive: true });
  }
  applyCloudflareGeneratedConfig(generatedRepo, preserved);

  runIn(generatedRepo, "git", ["add", "-A"]);
  const stagedDiff = spawnSync("git", ["diff", "--cached", "--quiet"], {
    cwd: generatedRepo,
    encoding: "utf8",
  });
  if (stagedDiff.status === 0) {
    return false;
  }
  if (stagedDiff.status !== 1) {
    throw new Error(`Expected git diff --cached --quiet status 0 or 1, got ${stagedDiff.status}: ${stagedDiff.stderr}`);
  }

  const upstreamSha = runIn(generatedRepo, "git", ["rev-parse", "--short=12", "FETCH_HEAD"]).stdout.trim();
  runIn(generatedRepo, "git", ["commit", "-m", `chore: sync Renewlet upstream ${upstreamSha}`]);
  return true;
}

function checkSyncRenewletUpstreamWorkflow(repoRoot) {
  const workflowPath = join(repoRoot, ".github/workflows/sync-renewlet-upstream.yml");
  if (!existsSync(workflowPath)) {
    throw new Error("sync-renewlet-upstream.yml must exist for one-click generated repositories.");
  }

  const content = readFileSync(workflowPath, "utf8");
  for (const snippet of [
    "name: Sync Renewlet Upstream",
    "workflow_dispatch:",
    "contents: write",
    "github.repository != 'zhiyingzzhou/renewlet'",
    "https://github.com/zhiyingzzhou/renewlet.git",
    "git restore --source",
    "git push origin \"HEAD:${target_branch}\"",
    "MEDIA_ICON_INDEX_REFRESH_QUEUE",
    "media_icon_index_refresh_queue_name",
    "media_icon_index_refresh_dead_letter_queue_name",
    "dead_letter_queue",
  ]) {
    if (!content.includes(snippet)) {
      throw new Error(`sync-renewlet-upstream.yml must keep snippet: ${snippet}`);
    }
  }
  const onBlock = /^on:\n(?<body>(?:  .*(?:\n|$))*)/m.exec(content)?.groups?.body ?? "";
  if (!onBlock.includes("  workflow_dispatch:")) {
    throw new Error("sync-renewlet-upstream.yml must keep workflow_dispatch as the only trigger.");
  }
  for (const forbiddenTrigger of ["  push:", "  pull_request:", "  workflow_run:", "  repository_dispatch:"]) {
    if (onBlock.includes(forbiddenTrigger)) {
      throw new Error(`sync-renewlet-upstream.yml must not include trigger: ${forbiddenTrigger.trim()}`);
    }
  }
  for (const forbidden of ["schedule:", "git merge", "git rebase", "--allow-unrelated-histories", "--force"]) {
    if (content.includes(forbidden)) {
      throw new Error(`sync-renewlet-upstream.yml must not contain: ${forbidden}`);
    }
  }
}

function checkSyncRenewletUpstreamBehavior() {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-sync-upstream-"));
  try {
    const upstreamRepo = join(tempDir, "renewlet-upstream");
    const generatedRepo = join(tempDir, "generated-repo");

    initGitRepo(upstreamRepo);
    writeText(
      join(upstreamRepo, "wrangler.jsonc"),
      `{
  "name": "renewlet",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "renewlet",
      "database_id": "00000000-0000-0000-0000-000000000000"
    }
  ],
  "r2_buckets": [
    {
      "binding": "ASSETS_BUCKET",
      "bucket_name": "renewlet-assets"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "MEDIA_ICON_INDEX_REFRESH_QUEUE",
        "queue": "renewlet-media-icon-index-refresh"
      }
    ],
    "consumers": [
      {
        "queue": "renewlet-media-icon-index-refresh",
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 5,
        "dead_letter_queue": "renewlet-media-icon-index-refresh-dlq",
        "max_concurrency": 1
      }
    ]
  },
  "vars": {
    "SETUP_ENABLED": "true",
    "NEW_DEFAULT": "from-upstream"
  }
}
`,
    );
    writeText(join(upstreamRepo, "upstream-file.txt"), "from upstream\n");
    writeText(join(upstreamRepo, ".github/workflows/release-publish.yml"), "name: Release Publish\n");
    runIn(upstreamRepo, "git", ["add", "."]);
    runIn(upstreamRepo, "git", ["commit", "-m", "upstream snapshot"]);

    initGitRepo(generatedRepo);
    writeText(
      join(generatedRepo, "wrangler.jsonc"),
      `{
  "name": "renewlet-user-worker",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "renewlet-user-db",
      "database_id": "11111111-2222-3333-4444-555555555555"
    }
  ],
  "r2_buckets": [
    {
      "binding": "ASSETS_BUCKET",
      "bucket_name": "renewlet-user-assets"
    }
  ],
  "queues": {
    "producers": [
      {
        "binding": "MEDIA_ICON_INDEX_REFRESH_QUEUE",
        "queue": "renewlet-user-icon-refresh"
      }
    ],
    "consumers": [
      {
        "queue": "renewlet-user-icon-refresh",
        "max_batch_size": 1,
        "max_batch_timeout": 5,
        "max_retries": 3,
        "dead_letter_queue": "renewlet-user-icon-refresh-dlq",
        "max_concurrency": 1
      }
    ]
  },
  "vars": {
    "SETUP_ENABLED": "false",
    "CUSTOM_USER_VAR": "keep-me"
  }
}
`,
    );
    writeText(join(generatedRepo, "generated-only.txt"), "remove me\n");
    writeText(join(generatedRepo, ".github/workflows/sync-renewlet-upstream.yml"), "name: Sync Renewlet Upstream\n");
    runIn(generatedRepo, "git", ["add", "."]);
    runIn(generatedRepo, "git", ["commit", "-m", "generated snapshot"]);

    if (!simulateSyncRenewletUpstream(generatedRepo, upstreamRepo, tempDir)) {
      throw new Error("Sync workflow simulation must create a commit when upstream changed.");
    }

    if (existsSync(join(generatedRepo, "generated-only.txt"))) {
      throw new Error("Sync workflow must remove files absent from upstream.");
    }
    if (!existsSync(join(generatedRepo, "upstream-file.txt"))) {
      throw new Error("Sync workflow must restore files from upstream.");
    }
    if (!existsSync(join(generatedRepo, ".github/workflows/sync-renewlet-upstream.yml"))) {
      throw new Error("Sync workflow must preserve the manual sync entrypoint.");
    }
    if (existsSync(join(generatedRepo, ".github/workflows/release-publish.yml"))) {
      throw new Error("Sync workflow must preserve generated repository workflows instead of importing upstream workflows.");
    }

    const wranglerConfig = readJson(join(generatedRepo, "wrangler.jsonc"));
    const d1 = findJsonBinding(wranglerConfig, "d1_databases", "DB");
    const r2 = findJsonBinding(wranglerConfig, "r2_buckets", "ASSETS_BUCKET");
    const queue = findJsonQueueProducer(wranglerConfig, "MEDIA_ICON_INDEX_REFRESH_QUEUE");
    const queueConsumer = queue?.queue ? findJsonQueueConsumer(wranglerConfig, queue.queue) : undefined;
    if (
      wranglerConfig.name !== "renewlet-user-worker" ||
      d1.database_name !== "renewlet-user-db" ||
      d1.database_id !== "11111111-2222-3333-4444-555555555555" ||
      r2.bucket_name !== "renewlet-user-assets" ||
      queue?.queue !== "renewlet-user-icon-refresh" ||
      queueConsumer?.dead_letter_queue !== "renewlet-user-icon-refresh-dlq" ||
      queueConsumer?.max_retries !== 5 ||
      wranglerConfig.vars.SETUP_ENABLED !== "false" ||
      wranglerConfig.vars.CUSTOM_USER_VAR !== "keep-me" ||
      wranglerConfig.vars.NEW_DEFAULT !== "from-upstream"
    ) {
      throw new Error("Sync workflow must preserve generated Wrangler resources, Queue names, and vars.");
    }

    const parents = runIn(generatedRepo, "git", ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(/\s+/);
    if (parents.length !== 2) {
      throw new Error("Sync workflow must create a normal single-parent commit.");
    }

    const mergeBase = spawnSync("git", ["merge-base", "HEAD", "refs/remotes/upstream/main"], {
      cwd: generatedRepo,
      encoding: "utf8",
    });
    if (mergeBase.status === 0) {
      throw new Error("Sync workflow must not merge unrelated upstream history.");
    }
    if (mergeBase.status !== 1) {
      throw new Error(`Expected no merge base, got git status ${mergeBase.status}: ${mergeBase.stderr}`);
    }

    const commitCount = runIn(generatedRepo, "git", ["rev-list", "--count", "HEAD"]).stdout.trim();
    if (simulateSyncRenewletUpstream(generatedRepo, upstreamRepo, join(tempDir, "noop"))) {
      throw new Error("Sync workflow simulation must no-op when upstream is already applied.");
    }
    const noOpCommitCount = runIn(generatedRepo, "git", ["rev-list", "--count", "HEAD"]).stdout.trim();
    if (commitCount !== noOpCommitCount) {
      throw new Error("Sync workflow no-op must not create a commit.");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function checkSyncRenewletUpstreamDocs(repoRoot) {
  const docs = ["docs/cloudflare-workers-deploy.md", "docs/cloudflare-workers-deploy.zh-CN.md"];
  for (const relativePath of docs) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const snippet of ["Sync Renewlet Upstream", "Run workflow", ".github/workflows/sync-renewlet-upstream.yml"]) {
      if (!content.includes(snippet)) {
        throw new Error(`${relativePath} must document manual upstream sync: ${snippet}`);
      }
    }
    for (const forbidden of [
      "upgrade-cloudflare-generated-repo.mjs",
      "node /tmp/renewlet-upgrade.mjs",
      "curl -fsSL https://raw.githubusercontent.com/zhiyingzzhou/renewlet/main/scripts",
      "git merge upstream/main",
      "--allow-unrelated-histories",
    ]) {
      if (content.includes(forbidden)) {
        throw new Error(`${relativePath} must not keep obsolete generated-repo upgrade flow: ${forbidden}`);
      }
    }
  }
}

export function checkSyncRenewletUpstream(repoRoot) {
  checkSyncRenewletUpstreamWorkflow(repoRoot);
  checkSyncRenewletUpstreamBehavior();
  checkSyncRenewletUpstreamDocs(repoRoot);
}
