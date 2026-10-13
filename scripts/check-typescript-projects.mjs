import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const projectSources = new Map([
  ["packages/shared/tsconfig.json", ["packages/shared/src"]],
  ["apps/worker/tsconfig.json", ["apps/worker/src"]],
  ["apps/web/tsconfig.json", ["apps/web/src", "apps/web/vite", "apps/web/scripts", "apps/web"]],
  ["apps/website/tsconfig.app.json", ["apps/website/src", "apps/website/tests"]],
  ["apps/website/tsconfig.node.json", ["apps/website/scripts", "apps/website"]],
  ["tsconfig.scripts.json", ["scripts"]],
  ["tsconfig.playwright.json", ["e2e", "."]],
]);

function sourceFiles(root, directory) {
  // app/仓库根只拥有直属工具配置；递归范围由各运行面的源码目录显式定义。
  const recursive = ![".", "apps/web", "apps/website"].includes(directory);
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) return recursive ? sourceFiles(root, name) : [];
    return /\.(?:ts|tsx)$/.test(entry.name) ? [resolve(root, name)] : [];
  });
}

export function checkTypeScriptProjects(root) {
  const seen = new Set();
  const caches = new Set();
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: fail };
  function fail(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  function visit(configFile) {
    if (seen.has(configFile)) throw new Error(`Duplicate TypeScript project: ${configFile}`);
    seen.add(configFile);
    const config = ts.getParsedCommandLineOfConfigFile(resolve(root, configFile), {}, host);
    if (!config) throw new Error(`Missing TypeScript config: ${configFile}`);
    if (config.errors.length) fail(config.errors[0]);
    const directories = projectSources.get(configFile);
    if (directories) {
      const { strict, incremental, noEmit, tsBuildInfoFile } = config.options;
      if (!strict || !incremental || !noEmit || !tsBuildInfoFile || caches.has(tsBuildInfoFile)) {
        throw new Error(`${configFile} must be strict, noEmit and incremental with its own cache`);
      }
      caches.add(tsBuildInfoFile);
      const files = new Set(config.fileNames);
      for (const directory of directories) {
        for (const file of sourceFiles(root, directory)) {
          if (!files.has(file)) throw new Error(`${configFile} excludes ${file}`);
        }
      }
    } else if (config.fileNames.length || !config.projectReferences?.length) {
      throw new Error(`${configFile} must only coordinate project references`);
    }
    for (const reference of config.projectReferences ?? []) {
      const referencedFile = ts.resolveProjectReferencePath(reference);
      visit(referencedFile.slice(resolve(root).length + 1));
    }
  }
  // 根配置改成solution后，单独tsc -p会空跑；门禁必须同时保护build入口与真实源码覆盖。
  visit("tsconfig.json");
  for (const project of projectSources.keys()) {
    if (!seen.has(project)) throw new Error(`Root TypeScript solution excludes ${project}`);
  }
}
