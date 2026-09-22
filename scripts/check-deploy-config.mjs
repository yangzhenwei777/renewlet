#!/usr/bin/env node
/**
 * 部署脚本契约检查。
 *
 * 触发时机：`pnpm check:deploy`、CI 质量门和发布前部署验证。
 * 前置依赖：Node.js；安装 Docker Compose v2 时会额外检查 compose config，未安装时跳过该部分。
 *
 * 架构位置：根 `check:deploy` 在 CI/本地检查一键部署脚本是否仍会生成必要密钥、
 * 保留已有配置，并在缺少 Docker 时给出可预测行为。
 *
 * 流程：
 *   临时目录 -> 假 docker -> 复制部署模板 -> 运行脚本 -> 检查 .env/compose
 *
 * 注意：这里会创建临时文件但不改仓库；每个临时目录都在 finally 清理。
 * 新增部署环境变量时要同步 env.example 和这些断言。
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkCloudflareDevRunner } from "./check-cloudflare-dev-runner.mjs";
import { checkCloudflareD1DeployContract } from "./check-cloudflare-d1-deploy-contract.mjs";
import { checkCloudflareMigrationSafety } from "./check-cloudflare-migration-safety.mjs";
import { checkCustomHeadHTMLDeployContract } from "./check-custom-head-html-deploy-contract.mjs";
import { checkDockerBuildContract } from "./check-docker-build-contract.mjs";
import { checkDockerProxyContract } from "./check-docker-proxy-contract.mjs";
import { checkSyncRenewletUpstream } from "./check-deploy-sync-upstream.mjs";
import { checkWorkflowContracts } from "./check-workflow-contracts.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deployScript = join(repoRoot, "deploy/docker-deploy.sh");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result;
}

function commandWorks(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0;
}

function parseEnvValue(path, key) {
  const content = readFileSync(path, "utf8");
  const line = content
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(`${key}=`));
  if (!line) {
    throw new Error(`Missing ${key} in ${path}`);
  }
  // 部署脚本允许双引号/单引号包裹值；测试只关心真实 secret 长度，不关心引用形式。
  return line.slice(key.length + 1).replace(/^['"]|['"]$/g, "");
}

function prepareFakeDocker(tempDir) {
  const binDir = join(tempDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const dockerPath = join(binDir, "docker");
  // 假 docker 只实现脚本启动所需的 `docker compose version`，任何额外调用都会让测试失败。
  writeFileSync(
    dockerPath,
    [
      "#!/usr/bin/env sh",
      'if [ "$1" = "compose" ] && [ "$2" = "version" ]; then',
      "  exit 0",
      "fi",
      'echo "unexpected docker invocation: $*" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  chmodSync(dockerPath, 0o755);
  return binDir;
}

function runDeployScript(tempDir) {
  const binDir = prepareFakeDocker(tempDir);
  return spawnSync("bash", [deployScript], {
    cwd: tempDir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

function checkGeneratedSecrets() {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-deploy-ok-"));
  try {
    copyFileSync(join(repoRoot, "deploy/docker-compose.yml"), join(tempDir, "docker-compose.yml"));
    copyFileSync(join(repoRoot, "deploy/env.example"), join(tempDir, ".env"));

    const result = runDeployScript(tempDir);
    if (result.status !== 0) {
      throw new Error(`docker-deploy.sh failed unexpectedly:\n${result.stderr || result.stdout}`);
    }

    const envPath = join(tempDir, ".env");
    const pbKey = parseEnvValue(envPath, "PB_ENCRYPTION_KEY");
    if (pbKey.length !== 32) {
      throw new Error(`Expected generated PB_ENCRYPTION_KEY length 32, got ${pbKey.length}`);
    }

    const cronSecret = parseEnvValue(envPath, "CRON_SECRET");
    if (cronSecret.length === 0) {
      throw new Error("Expected generated CRON_SECRET to be non-empty");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function checkInvalidExistingPBKeyIsRejected() {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-deploy-bad-"));
  try {
    copyFileSync(join(repoRoot, "deploy/docker-compose.yml"), join(tempDir, "docker-compose.yml"));

    const envPath = join(tempDir, ".env");
    const invalidEnv = [
      'PB_ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
      'CRON_SECRET="existing-cron-secret"',
      "",
    ].join("\n");
    writeFileSync(envPath, invalidEnv);

    const result = runDeployScript(tempDir);
    if (result.status === 0) {
      throw new Error("Expected docker-deploy.sh to reject invalid PB_ENCRYPTION_KEY");
    }
    if (!result.stderr.includes("PB_ENCRYPTION_KEY must be exactly 32 characters; got 44")) {
      throw new Error(`Expected clear PB_ENCRYPTION_KEY length error, got:\n${result.stderr}`);
    }
    // 错误 key 不能被脚本自动替换；已有部署一旦丢失原 key，历史加密数据将无法解密。
    if (readFileSync(envPath, "utf8") !== invalidEnv) {
      throw new Error("Invalid existing PB_ENCRYPTION_KEY was modified");
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function checkComposeConfig() {
  if (!commandWorks("docker", ["compose", "version"])) {
    console.warn("Skipping docker compose config checks because Docker Compose v2 is unavailable.");
    return;
  }

  run("docker", ["compose", "-f", "docker-compose.yml", "config"]);
  run("docker", ["compose", "-f", "deploy/docker-compose.yml", "--env-file", "deploy/env.example", "config"]);
  run("docker", ["compose", "-f", "docker-compose.ghcr.yml", "config"]);
}

function checkGoToolchainConsistency() {
  const goModPath = join(repoRoot, "apps/docker-server/go.mod");
  const goDirectives = [...readFileSync(goModPath, "utf8").matchAll(/^go\s+(\d+\.\d+\.\d+)\s*$/gm)];
  if (goDirectives.length !== 1) {
    throw new Error("apps/docker-server/go.mod must contain exactly one patch-level Go directive.");
  }
  const goVersion = goDirectives[0][1];

  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const dockerBuilder = /^FROM(?:\s+--platform=\S+)?\s+golang:(?<version>\d+\.\d+\.\d+)-\S+\s+AS\s+server-builder\s*$/m.exec(
    dockerfile,
  );
  if (!dockerBuilder?.groups?.version) {
    throw new Error("Dockerfile must keep a patch-pinned golang server-builder image.");
  }
  if (dockerBuilder.groups.version !== goVersion) {
    throw new Error(
      `Dockerfile Go version ${dockerBuilder.groups.version} must match go.mod ${goVersion}.`,
    );
  }

  const workflowDir = join(repoRoot, ".github/workflows");
  const workflowFiles = readdirSync(workflowDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  let setupGoCount = 0;

  // go.mod 是漏洞扫描、CI 构建和 Docker 发布的唯一 Go 版本源；漂移会把未修复的标准库带进成品。
  for (const workflowFile of workflowFiles) {
    const lines = readFileSync(join(workflowDir, workflowFile), "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const usesMatch = /^(?<indent>\s*)(?:-\s+)?uses:\s*actions\/setup-go@\S+\s*$/.exec(
        lines[index],
      );
      if (!usesMatch?.groups) {
        continue;
      }

      setupGoCount += 1;
      const usesIndent = usesMatch.groups.indent.length;
      let stepEnd = lines.length;
      for (let candidate = index + 1; candidate < lines.length; candidate += 1) {
        const nextStep = /^(?<indent>\s*)-\s+/.exec(lines[candidate]);
        if (nextStep?.groups && nextStep.groups.indent.length <= usesIndent) {
          stepEnd = candidate;
          break;
        }
      }

      const stepLines = lines.slice(index, stepEnd);
      const versionFileValues = stepLines.flatMap((line) => {
        const match = /^\s*go-version-file:\s*(?<value>.+?)\s*$/.exec(line);
        return match?.groups ? [match.groups.value.replace(/^['"]|['"]$/g, "")] : [];
      });
      if (stepLines.some((line) => /^\s*go-version:\s*/.test(line))) {
        throw new Error(`${workflowFile} setup-go step must not hardcode go-version.`);
      }
      if (
        versionFileValues.length !== 1 ||
        versionFileValues[0] !== "apps/docker-server/go.mod"
      ) {
        throw new Error(
          `${workflowFile} setup-go step must use go-version-file: apps/docker-server/go.mod.`,
        );
      }
    }
  }

  if (setupGoCount === 0) {
    throw new Error("At least one GitHub Actions workflow must configure actions/setup-go.");
  }
}

function checkDockerSelfUpdateLayout() {
  const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
  const containerInit = readFileSync(join(repoRoot, "apps/docker-server/cmd/container-init/main.go"), "utf8");
  const compose = readFileSync(join(repoRoot, "deploy/docker-compose.yml"), "utf8");
  const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release-publish.yml"), "utf8");

  // 页面内更新依赖 Dockerfile、静态 init、compose、release 资产四处同频；这里把布局当契约锁住。
  for (const snippet of [
    "/opt/renewlet/current/renewlet",
    "RENEWLET_SELF_UPDATE_ENABLED=true",
    "COPY --from=server-builder --chown=1000:1000 /out/renewlet /opt/renewlet/current/renewlet",
    'ENTRYPOINT ["/container-init"]',
  ]) {
    if (!dockerfile.includes(snippet)) {
      throw new Error(`Dockerfile must keep self-update layout snippet: ${snippet}`);
    }
  }
  for (const { pattern, label } of [
    { pattern: /stableBinaryPath\s*=\s*"\/renewlet"/, label: "stable /renewlet path" },
    { pattern: /renewletBinaryPath\s*=\s*"\/opt\/renewlet\/current\/renewlet"/, label: "replaceable binary path" },
    { pattern: /dataPath\s*=\s*"\/pb_data"/, label: "PocketBase data path" },
    { pattern: /backupPath\s*=\s*"\/opt\/renewlet\/backups"/, label: "self-update backup path" },
    { pattern: /os\.Symlink\(targetPath, linkPath\)/, label: "stable symlink creation" },
    { pattern: /os\.Lchown/, label: "symlink-safe ownership" },
    { pattern: /syscall\.Setgroups/, label: "all-thread supplementary group cleanup" },
    { pattern: /syscall\.Setgid/, label: "all-thread gid drop" },
    { pattern: /syscall\.Setuid/, label: "all-thread uid drop" },
    { pattern: /unix\.Exec/, label: "PID 1 exec" },
  ]) {
    if (!pattern.test(containerInit)) {
      throw new Error(`container-init must keep runtime ownership and exec contract: ${label}`);
    }
  }
  if (existsSync(join(repoRoot, "deploy/docker-entrypoint.sh"))) {
    throw new Error("The removed shell Docker entrypoint must not return alongside container-init.");
  }
  if (!compose.includes('test: [ "CMD", "/renewlet", "healthcheck" ]')) {
    throw new Error("Docker healthcheck must keep /renewlet as the stable entrypoint");
  }
  for (const snippet of [
    "Build Linux self-update binaries",
    "pnpm --filter @renewlet/client build",
    "renewlet_${{ needs.metadata.outputs.version }}_linux_amd64.tar.gz",
    "renewlet_${{ needs.metadata.outputs.version }}_linux_arm64.tar.gz",
    "sha256sum renewlet_${{ needs.metadata.outputs.version }}_linux_*.tar.gz > checksums.txt",
  ]) {
    if (!releaseWorkflow.includes(snippet)) {
      throw new Error(`release-publish.yml must keep self-update release asset snippet: ${snippet}`);
    }
  }
  // GitHub Release 仍交给 softprops；RC 前置清理只移除同 tag 残留 draft，避免首次发布撞 duplicate tag。
  for (const snippet of [
    "Cleanup stale draft release",
    "if: ${{ needs.metadata.outputs.is-stable != 'true' }}",
    "uses: actions/github-script@v9.0.0",
    "item.draft && item.tag_name === tag",
    "github.rest.repos.deleteRelease",
    "uses: softprops/action-gh-release@v3.0.2",
    "fail_on_unmatched_files: true",
  ]) {
    if (!releaseWorkflow.includes(snippet)) {
      throw new Error(`release-publish.yml must keep GitHub Release hygiene snippet: ${snippet}`);
    }
  }
}

function checkCloudflareDeployMigrationScript() {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const workerPackageJson = JSON.parse(readFileSync(join(repoRoot, "apps/worker/package.json"), "utf8"));
  const deployScript = packageJson.scripts?.deploy;
  const deployCloudflareScript = packageJson.scripts?.["deploy:cloudflare"];
  const buildCloudflareScript = packageJson.scripts?.["build:cloudflare"];
  const devScript = packageJson.scripts?.["dev:cloudflare"];
  const checkDeployScript = packageJson.scripts?.["check:deploy"];
  const migrationScript = packageJson.scripts?.["cloudflare:migrations:apply"];
  const localMigrationScript = packageJson.scripts?.["cloudflare:migrations:apply:local"];
  const routeParityScript = packageJson.scripts?.["check:route-parity"];
  const buildAllScript = packageJson.scripts?.["build:all"];
  const typecheckScript = packageJson.scripts?.typecheck;
  const typecheckAllScript = packageJson.scripts?.["typecheck:all"];
  const typecheckScriptsScript = packageJson.scripts?.["typecheck:scripts"];
  const checkCloudflareScript = packageJson.scripts?.["check:cloudflare"];
  const queuesEnsureScript = packageJson.scripts?.["cloudflare:queues:ensure"];
  const migrationRunnerScript = readFileSync(join(repoRoot, "scripts/apply-cloudflare-d1-migrations.mjs"), "utf8");

  // Deploy Button、自管 workflow 和正式发布只能委托同一个状态机，迁移顺序不能在入口层复制。
  if (deployScript !== "tsx scripts/cloudflare-deploy.ts deploy") {
    throw new Error("package.json deploy script must use the exclusive Cloudflare deployment orchestrator.");
  }
  if (deployCloudflareScript !== "pnpm build:cloudflare && pnpm deploy") {
    throw new Error("package.json deploy:cloudflare must rebuild production Cloudflare assets before deploy.");
  }
  if (buildCloudflareScript !== "VITE_RENEWLET_RUNTIME=cloudflare pnpm --filter @renewlet/client build && pnpm --filter @renewlet/cloudflare build") {
    throw new Error("package.json build:cloudflare must build both production Static Assets and the Worker bundle without local HTTP header rewrites.");
  }
  if (workerPackageJson.scripts?.build !== "wrangler deploy --dry-run --config ../../wrangler.jsonc --outdir dist") {
    throw new Error("apps/worker build must produce a real Wrangler dry-run bundle from the root deployment config.");
  }
  if (checkDeployScript !== "node scripts/check-deploy-config.mjs && pnpm test:scripts") {
    throw new Error("package.json check:deploy must include Cloudflare deployment helper tests.");
  }
  if (migrationScript !== "node scripts/apply-cloudflare-d1-migrations.mjs --remote") {
    throw new Error("package.json cloudflare:migrations:apply must use the retry-aware remote D1 migration helper.");
  }
  if (localMigrationScript !== "node scripts/apply-cloudflare-d1-migrations.mjs --local") {
    throw new Error("package.json cloudflare:migrations:apply:local must run migration, derived-state backfill, and foreign-key checks against local D1.");
  }
  if (routeParityScript !== "tsx scripts/check-product-route-parity.ts") {
    throw new Error("package.json check:route-parity must compare the Go and Worker runtime registries.");
  }
  if (!buildAllScript?.includes("pnpm build:client") || !buildAllScript.includes("pnpm --filter @renewlet/cloudflare build") || !buildAllScript.includes("pnpm build:server") || !buildAllScript.includes("pnpm build:website")) {
    throw new Error("package.json build:all must build client, Worker bundle, Go server, and website after shared/Worker typechecks.");
  }
  if (typecheckScript !== "pnpm typecheck:all") {
    throw new Error("package.json typecheck must use the complete monorepo type gate.");
  }
  if (typecheckScriptsScript !== "tsc --noEmit --project tsconfig.json") {
    throw new Error("package.json typecheck:scripts must compile every root TypeScript operations script.");
  }
  if (!typecheckAllScript?.includes("pnpm typecheck:scripts") || !typecheckAllScript.includes("pnpm --filter @renewlet/server typecheck")) {
    throw new Error("package.json typecheck:all must include root scripts and Go vet through the Docker server workspace.");
  }
  if (!checkCloudflareScript?.includes("pnpm typecheck:scripts")) {
    throw new Error("package.json check:cloudflare must typecheck the root Cloudflare operations scripts.");
  }
  if (queuesEnsureScript !== "tsx scripts/ensure-cloudflare-queues.ts") {
    throw new Error("package.json cloudflare:queues:ensure must keep the idempotent Queue creation helper.");
  }
  if (devScript !== "pnpm build:cloudflare && node scripts/prepare-cloudflare-local-headers.mjs && pnpm cloudflare:migrations:apply:local && node scripts/cloudflare-dev-hint.mjs && node scripts/cloudflare-dev-wrangler.mjs --test-scheduled") {
    throw new Error("package.json dev:cloudflare must prepare local HTTP headers, print the local Cron hint, apply the explicit proxy policy, and enable Wrangler scheduled middleware.");
  }
  // D1 远端 migration 偶发 7429/reset 时可以重试；权限、SQL 和 binding 错误仍必须保持失败。
  for (const snippet of [
    "D1 DB storage operation exceeded timeout",
    "\\[code:\\s*7429\\]",
    "Network connection lost",
    "A D1 target is required",
    "options.target === \"local\"",
    "checkCloudflareMigrationSafety(repoRoot)",
    "protect-cloudflare-calendar-feeds.ts",
    'calendarFeedProtectionArgs(options, "prepare")',
    'calendarFeedProtectionArgs(options, "restore")',
    "backfill-cloudflare-subscription-derived-state.ts",
    "PRAGMA foreign_key_check",
    "invalid Wrangler JSON",
    "found violations",
    "non-retryable error",
    "failed after",
  ]) {
    if (!migrationRunnerScript.includes(snippet)) {
      throw new Error(`apply-cloudflare-d1-migrations.mjs must keep retry boundary snippet: ${snippet}`);
    }
  }
}

function checkCloudflareObservabilityProfiles() {
  const generator = readFileSync(join(repoRoot, "scripts/generate-cloudflare-wrangler-config.ts"), "utf8");
  const configModule = readFileSync(join(repoRoot, "scripts/cloudflare-wrangler-config.ts"), "utf8");
  const template = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  const selfHostedWorkflow = readFileSync(join(repoRoot, ".github/workflows/cloudflare-worker.yml"), "utf8");
  const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release-publish.yml"), "utf8");

  // profile 由部署入口显式选择；模板/开发保持全采样，稳定发布必须降低日志与 trace 采样。
  for (const snippet of [
    '"CLOUDFLARE_OBSERVABILITY_PROFILE"',
    "development: { logs: 1, traces: 1 }",
    "production: { logs: 0.1, traces: 0.05 }",
  ]) {
    if (!generator.includes(snippet)) {
      throw new Error(`Cloudflare config generator must keep observability profile snippet: ${snippet}`);
    }
  }
  for (const snippet of ["createMaintenanceWranglerConfig", 'RENEWLET_MAINTENANCE_MODE: "true"', "consumers: []"]) {
    if (!configModule.includes(snippet)) {
      throw new Error(`Cloudflare config module must keep maintenance profile snippet: ${snippet}`);
    }
  }
  for (const snippet of ['"head_sampling_rate": 1', '"enabled": true']) {
    if (!template.includes(snippet)) {
      throw new Error(`wrangler.jsonc development observability must keep snippet: ${snippet}`);
    }
  }
  if (!selfHostedWorkflow.includes("CLOUDFLARE_OBSERVABILITY_PROFILE: development")) {
    throw new Error("Self-managed Cloudflare workflow must select the development observability profile.");
  }
  if (!releaseWorkflow.includes("CLOUDFLARE_OBSERVABILITY_PROFILE: production")) {
    throw new Error("Stable Cloudflare release must select the production observability profile.");
  }
}

function checkCloudflareStaticAssetHeadersContract() {
  const publicHeaders = readFileSync(join(repoRoot, "apps/web/public/_headers"), "utf8");
  const localHeadersScript = readFileSync(join(repoRoot, "scripts/prepare-cloudflare-local-headers.mjs"), "utf8");

  // 生产 Cloudflare HTTPS 入口继续使用强 CSP；只有 ignored 的 dist 文件能被本地 HTTP dev 放宽。
  for (const snippet of [
    "Content-Security-Policy:",
    "img-src 'self' data: blob: https:",
    "upgrade-insecure-requests",
  ]) {
    if (!publicHeaders.includes(snippet)) {
      throw new Error(`apps/web/public/_headers must keep production CSP snippet: ${snippet}`);
    }
  }
  if (publicHeaders.includes("img-src 'self' data: blob: http: https:")) {
    throw new Error("apps/web/public/_headers must not use the local HTTP img-src policy.");
  }
  for (const snippet of [
    "apps/web/dist/_headers",
    "upgrade-insecure-requests",
    "img-src 'self' data: blob: http: https:",
    "--check-production",
  ]) {
    if (!localHeadersScript.includes(snippet)) {
      throw new Error(`prepare-cloudflare-local-headers.mjs must keep local/production header guard snippet: ${snippet}`);
    }
  }
}

function checkCloudflareScheduledLocalRoute() {
  const wranglerConfig = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  const runWorkerFirst = /"run_worker_first"\s*:\s*\[([^\]]*)\]/s.exec(wranglerConfig)?.[1] ?? "";
  const assetsBlock = /"assets"\s*:\s*\{(?<body>[\s\S]*?)\n\s*\}/.exec(wranglerConfig)?.groups?.body ?? "";

  // Worker 通过 Static Assets binding 读取 seed 图标索引；不能把大 JSON 再打进 Worker bundle。
  if (!/"binding"\s*:\s*"ASSETS"/.test(assetsBlock)) {
    throw new Error('wrangler.jsonc assets.binding must stay "ASSETS" for built-in icon seed reads.');
  }
  // Wrangler 的 /cdn-cgi scheduled 测试入口在 Workers Static Assets 下会先打到 asset proxy；Renewlet 本地 Cron 固定走 /__scheduled。
  if (!runWorkerFirst.includes('"/__scheduled"')) {
    throw new Error('wrangler.jsonc assets.run_worker_first must include "/__scheduled" for local Cron testing.');
  }
}

function checkCloudflareQueueConfig() {
  const wranglerConfig = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  const queueEnsureScript = readFileSync(join(repoRoot, "scripts/ensure-cloudflare-queues.ts"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const packageBindings = packageJson.cloudflare?.bindings ?? {};

  // 图标索引 refresh 不能再走 HTTP 重活；Queue/DLQ 名和 consumer 串行度是 Cloudflare 稳定性的部署契约。
  for (const snippet of [
    '"binding": "MEDIA_ICON_INDEX_REFRESH_QUEUE"',
    '"queue": "renewlet-media-icon-index-refresh"',
    '"max_batch_size": 1',
    '"max_retries": 5',
    '"dead_letter_queue": "renewlet-media-icon-index-refresh-dlq"',
    '"max_concurrency": 1',
  ]) {
    if (!wranglerConfig.includes(snippet)) {
      throw new Error(`wrangler.jsonc must keep media icon Queue config snippet: ${snippet}`);
    }
  }
  if (!Object.hasOwn(packageBindings, "MEDIA_ICON_INDEX_REFRESH_QUEUE")) {
    throw new Error("package.json cloudflare.bindings must document MEDIA_ICON_INDEX_REFRESH_QUEUE.");
  }
  // Queue create 不是幂等 API；already taken 只能在二次 info 确认存在后视为 ready。
  for (const snippet of [
    'runWranglerQueueCommand("info", name)',
    'runWranglerQueueCommand("create", name)',
    "\\b11009\\b|already taken",
    "create conflicted but the queue could not be confirmed",
  ]) {
    if (!queueEnsureScript.includes(snippet)) {
      throw new Error(`ensure-cloudflare-queues.ts must keep idempotent Queue ensure snippet: ${snippet}`);
    }
  }
}

function checkCloudflareLocalDevNetworkAccess() {
  const wranglerConfig = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  const devBlock = /"dev"\s*:\s*\{(?<body>[^}]+)\}/s.exec(wranglerConfig)?.groups?.body ?? "";

  // 本地真机验收依赖 Wrangler 监听所有网卡；`--host` 是 upstream 配置，不能替代 dev.ip。
  if (!/"ip"\s*:\s*"0\.0\.0\.0"/.test(devBlock)) {
    throw new Error('wrangler.jsonc dev.ip must be "0.0.0.0" so pnpm dev:cloudflare is reachable by LAN IP.');
  }
  if (!/"port"\s*:\s*8787/.test(devBlock)) {
    throw new Error("wrangler.jsonc dev.port must stay 8787 so local Cloudflare URLs and hints remain stable.");
  }
  if (!/"local_protocol"\s*:\s*"http"/.test(devBlock)) {
    throw new Error('wrangler.jsonc dev.local_protocol must stay "http" for local Cloudflare development.');
  }
}

function checkCloudflareFreshD1Migrations() {
  const tempDir = mkdtempSync(join(tmpdir(), "renewlet-d1-migrations-"));
  try {
    // Deploy Button 会创建全新的 D1；历史 migration 必须能从 0001 顺序跑到最新，不能只验证已有生产库增量路径。
    run("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", tempDir], {
      env: {
        ...process.env,
        CI: "1",
      },
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function checkCloudflareDeployButtonVars() {
  const wranglerConfig = readFileSync(join(repoRoot, "wrangler.jsonc"), "utf8");
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const packageBindings = packageJson.cloudflare?.bindings ?? {};

  // Deploy Button 会把模板变量当成用户配置项；版本/commit/build time 必须由 workflow 注入。
  for (const name of ["RENEWLET_VERSION", "RENEWLET_COMMIT", "RENEWLET_BUILD_TIME"]) {
    if (wranglerConfig.includes(`"${name}"`)) {
      throw new Error(`wrangler.jsonc must not expose ${name} as a Deploy Button user variable.`);
    }
    if (Object.hasOwn(packageBindings, name)) {
      throw new Error(`package.json cloudflare.bindings must not expose ${name} as a Deploy Button field.`);
    }
  }
}

function checkCloudflareDeployButtonVersionFallback() {
  const workerSystem = readFileSync(join(repoRoot, "apps/worker/src/system.ts"), "utf8");

  // Deploy Button 不一定有 CI 版本变量；Worker 缺元信息时必须显示 package stable version，不能再合成 dev 后缀。
  for (const snippet of [
    "`${rootPackageJson.version}-dev",
    'rootPackageJson.version + "-dev',
    "rootPackageJson.version}-dev",
  ]) {
    if (workerSystem.includes(snippet)) {
      throw new Error(`Cloudflare system version fallback must not synthesize dev versions: ${snippet}`);
    }
  }
  for (const snippet of ["PLACEHOLDER_DEV_VERSION_PATTERN", "return rootPackageJson.version;"]) {
    if (!workerSystem.includes(snippet)) {
      throw new Error(`Cloudflare system version fallback must keep Deploy Button stable-version guard: ${snippet}`);
    }
  }
}

function checkCloudflareWorkflowBuildMetadata() {
  checkCloudflareD1DeployContract(repoRoot);
  const selfHostedWorkflow = readFileSync(join(repoRoot, ".github/workflows/cloudflare-worker.yml"), "utf8");
  const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release-publish.yml"), "utf8");

  // 自管 Cloudflare workflow 不是正式 Release，必须注入 packageVersion-dev+shortSha，避免生产界面暴露 0.0.0-dev。
  if (selfHostedWorkflow.includes("RENEWLET_VERSION: 0.0.0-dev")) {
    throw new Error("cloudflare-worker.yml must not deploy the 0.0.0-dev placeholder version.");
  }
  // 官方 main 是稳定发布线；自管分支部署不能绕过 Release Publish 的 production-cloudflare 审批门。
  for (const snippet of [
    "if: ${{ github.repository != 'zhiyingzzhou/renewlet' || github.ref == 'refs/heads/dev' }}",
    "      - dev",
    "      - main",
    "workflow_dispatch:",
  ]) {
    if (!selfHostedWorkflow.includes(snippet)) {
      throw new Error(`cloudflare-worker.yml must keep self-managed deployment guard: ${snippet}`);
    }
  }
  for (const snippet of [
    "PACKAGE_VERSION=\"$(node -p \"require('./package.json').version\")\"",
    "SHORT_SHA=\"${GITHUB_SHA::7}\"",
    "RENEWLET_VERSION=${PACKAGE_VERSION}-dev+${SHORT_SHA}",
    "RENEWLET_BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "CI_WRANGLER_MAINTENANCE_CONFIG: wrangler.maintenance.generated.jsonc",
    "Deploy Renewlet through the exclusive migration orchestrator",
    "pnpm deploy -- --config \"$CI_WRANGLER_CONFIG\" --maintenance-config \"$CI_WRANGLER_MAINTENANCE_CONFIG\"",
  ]) {
    if (!selfHostedWorkflow.includes(snippet)) {
      throw new Error(`cloudflare-worker.yml must keep build metadata snippet: ${snippet}`);
    }
  }
  for (const snippet of [
    "Validate stable release version",
    "RENEWLET_VERSION: ${{ needs.metadata.outputs.version }}",
    "RENEWLET_COMMIT: ${{ github.sha }}",
    "RENEWLET_BUILD_TIME: ${{ steps.build-time.outputs.value }}",
    "CI_WRANGLER_MAINTENANCE_CONFIG: wrangler.maintenance.generated.jsonc",
    "Deploy Renewlet through the exclusive migration orchestrator",
    "pnpm deploy -- --config \"$CI_WRANGLER_CONFIG\" --maintenance-config \"$CI_WRANGLER_MAINTENANCE_CONFIG\"",
  ]) {
    if (!releaseWorkflow.includes(snippet)) {
      throw new Error(`release-publish.yml must keep production Cloudflare metadata snippet: ${snippet}`);
    }
  }
}

function checkRuntimeReleaseSecretPathRemoved() {
  const removedHelper = join(repoRoot, "scripts/write-cloudflare-worker-secrets-file.mjs");
  const removedRuntimeReleaseSecretEnv = ["RENEWLET", "GITHUB", "TOKEN"].join("_");
  if (existsSync(removedHelper)) {
    throw new Error("Cloudflare Worker secrets helper must stay removed; release checks do not use runtime secret envs.");
  }

  const files = [
    ".env.example",
    "deploy/env.example",
    "docs/cloudflare-workers-deploy.md",
    "docs/cloudflare-workers-deploy.zh-CN.md",
    ".github/workflows/cloudflare-worker.yml",
    ".github/workflows/release-publish.yml",
  ];

  // 已发布 release notes 是历史记录，不能为了新 runtime 契约回写旧版本说明；这里仅守当前部署入口。
  for (const relativePath of files) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const snippet of [
      removedRuntimeReleaseSecretEnv,
      "write-cloudflare-worker-secrets-file",
      "worker-secrets",
      "--secrets-file",
    ]) {
      if (content.includes(snippet)) {
        throw new Error(`${relativePath} must not contain removed runtime release secret path: ${snippet}`);
      }
    }
  }
}

run("bash", ["-n", deployScript]);
checkGeneratedSecrets();
checkInvalidExistingPBKeyIsRejected();
checkGoToolchainConsistency();
checkDockerSelfUpdateLayout();
checkDockerBuildContract(repoRoot);
checkCustomHeadHTMLDeployContract(repoRoot);
checkDockerProxyContract(repoRoot);
checkCloudflareDeployMigrationScript();
checkCloudflareMigrationSafety(repoRoot);
checkCloudflareDevRunner(repoRoot);
checkCloudflareObservabilityProfiles();
checkCloudflareStaticAssetHeadersContract();
checkCloudflareScheduledLocalRoute();
checkCloudflareQueueConfig();
checkCloudflareLocalDevNetworkAccess();
checkCloudflareFreshD1Migrations();
checkCloudflareDeployButtonVars();
checkCloudflareDeployButtonVersionFallback();
checkCloudflareWorkflowBuildMetadata();
checkWorkflowContracts(repoRoot);
checkRuntimeReleaseSecretPathRemoved();
checkSyncRenewletUpstream(repoRoot);
checkComposeConfig();

console.log("Deployment configuration checks passed.");
