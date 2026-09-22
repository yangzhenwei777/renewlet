import { readFileSync } from "node:fs";
import { join } from "node:path";

export function checkCustomHeadHTMLDeployContract(repoRoot) {
  const expectedEnv = "RENEWLET_CUSTOM_HEAD_HTML";
  const removedEnv = ["RENEWLET", "CUSTOM", "HEAD", "SCRIPT"].join("_");
  const publicFiles = [
    ".env.example",
    "deploy/env.example",
    "docker-compose.yml",
    "docker-compose.ghcr.yml",
    "deploy/docker-compose.yml",
    "README.md",
    "README.zh-CN.md",
  ];
  const guardedFiles = [
    ...publicFiles,
    "apps/docker-server/cmd/renewlet/custom_head_html.go",
    "apps/web/vite/custom-head-html.ts",
    "apps/web/vite.config.ts",
  ];

  // 自定义 head HTML 同时影响 HTML 注入与 CSP；部署入口漏传会让文档配置静默无效，旧变量回流则会制造两套互斥契约。
  for (const relativePath of publicFiles) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    if (!content.includes(expectedEnv)) {
      throw new Error(`${relativePath} must document or pass through ${expectedEnv}.`);
    }
  }
  for (const relativePath of guardedFiles) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    if (content.includes(removedEnv)) {
      throw new Error(`${relativePath} must not restore removed custom head script env ${removedEnv}.`);
    }
  }
}
