import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildArtifactHash, performanceBuildSchema } from "./browser-performance";

// 只由生产性能模式调用；复用正式 build 的类型/CSP/包体门，不把诊断 sourcemap 构建混入基线。
const root = resolve(__dirname, "..");
const reportPath = resolve(root, "tmp/performance-build.json");
mkdirSync(resolve(root, "tmp"), { recursive: true });
writeFileSync(reportPath, JSON.stringify({ version: 1, status: "running" }) + "\n");
const startedAt = performance.now();
const result = spawnSync("pnpm", ["--filter", "@renewlet/client", "build"], { cwd: root, stdio: "inherit" });
const durationMs = performance.now() - startedAt;

if (result.error || result.status !== 0) {
  const error = result.error?.message ?? `Client build exited with ${result.signal ?? result.status}`;
  writeFileSync(reportPath, JSON.stringify({ version: 1, status: "failed", durationMs, error }, null, 2) + "\n");
  throw new Error(error);
}

try {
  const report = performanceBuildSchema.parse({
    version: 1, status: "passed", durationMs,
    artifactHash: buildArtifactHash(resolve(root, "apps/web/dist")),
    bundle: JSON.parse(readFileSync(resolve(root, "apps/web/dist/.vite/bundle-budget.json"), "utf8")),
  });
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
} catch (error) {
  writeFileSync(reportPath, JSON.stringify({ version: 1, status: "failed", durationMs, error: error instanceof Error ? error.message : String(error) }, null, 2) + "\n");
  throw error;
}
