import { fileURLToPath } from "node:url";
import path from "node:path";
import babel from "@rolldown/plugin-babel";
import { linguiCatalogs } from "./vite/lingui-catalogs.ts";
import { defineConfig } from "vitest/config";
import { resolveClientBuildVersion } from "./vite/build-version.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");

export default defineConfig({
  // Vitest 使用 SSR transform；直接启用同一 Compiler，避免官方 client-only preset 跳过组件回归。
  plugins: [linguiCatalogs(), babel({ plugins: [["babel-plugin-react-compiler", { compilationMode: "annotation" }]] })],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
  define: {
    __RENEWLET_CLIENT_BUILD_VERSION__: JSON.stringify(resolveClientBuildVersion(repoRoot)),
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.{test,spec}.{ts,tsx}",
      "vite/**/*.{test,spec}.ts",
      "scripts/**/*.{test,spec}.mjs",
    ],
    clearMocks: true,
    restoreMocks: true,
    // jsdom/Radix 弹层测试在默认吃满 CPU worker 时会互相争抢事件循环，固定低并发让全量前端基线稳定可复现。
    maxWorkers: 2,
    testTimeout: 10_000,
  },
});
