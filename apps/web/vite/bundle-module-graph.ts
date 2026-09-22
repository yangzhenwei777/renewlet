import { mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Plugin } from "vite";

/** 为压缩预算提供 chunk -> source modules 事实，不依赖易漂移的 chunk 名称。 */
export function bundleModuleGraphPlugin(repoRoot: string): Plugin {
  let graph: Record<string, string[]> = {};
  return {
    name: "renewlet-bundle-module-graph",
    generateBundle(_options, bundle) {
      graph = Object.fromEntries(
        Object.values(bundle)
          .filter((entry) => entry.type === "chunk")
          .map((chunk) => [
            chunk.fileName,
            Object.keys(chunk.modules)
              .map((id) => normalizeModuleId(repoRoot, id))
              .sort(),
          ]),
      );
    },
    writeBundle(options) {
      const outputRoot = typeof options.dir === "string" ? options.dir : resolve(repoRoot, "apps/web/dist");
      const metadataRoot = resolve(outputRoot, ".vite");
      mkdirSync(metadataRoot, { recursive: true });
      writeFileSync(resolve(metadataRoot, "module-graph.json"), JSON.stringify(graph, null, 2) + "\n");
    },
  };
}

function normalizeModuleId(repoRoot: string, id: string): string {
  const cleanId = id.replace(/^\0+/, "").split("?")[0] ?? id;
  return cleanId.startsWith(repoRoot) ? relative(repoRoot, cleanId).replaceAll("\\", "/") : cleanId;
}
