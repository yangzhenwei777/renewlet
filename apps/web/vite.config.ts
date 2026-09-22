import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin, type PluginOption } from "vite";
import {
  customHeadHTMLEnvName,
  parseCustomHeadHTML,
  transformCustomHeadHTML,
  trustedExtensionContentSecurityPolicy,
  updateCustomHeadHTMLStaticHeaders,
  type CustomHeadHTML,
} from "./vite/custom-head-html.js";
import { resolveClientBuildVersion } from "./vite/build-version.js";
import { bundleModuleGraphPlugin } from "./vite/bundle-module-graph.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");
const devProxyOptions = (target: string) => ({
  target,
  // 本地开发经 Vite 访问 Go API 时，公开/日历 bearer URL 需要保留浏览器看到的外部 origin。
  xfwd: true,
});

const customHeadHTMLPlugin = (customHeadHTML: CustomHeadHTML | undefined, options: { updateStaticHeaders: boolean }): Plugin => ({
  name: "renewlet-custom-head-html",
  // 正式 HTML entry hook 同时覆盖 dev 与 build；返回完整源码字符串才能保留任意 head 片段，不经 tag descriptor 重新序列化。
  transformIndexHtml(html) {
    return transformCustomHeadHTML(html, customHeadHTML);
  },
  writeBundle() {
    if (!customHeadHTML || !options.updateStaticHeaders) return;
    // Cloudflare 的 public/_headers 到 build 输出完成后才可改写；开发服务器的 CSP 由 server.headers 使用同一配置快照提供。
    const headersPath = path.resolve(rootDir, "dist/_headers");
    if (!existsSync(headersPath)) {
      throw new Error("Missing apps/web/dist/_headers. Cloudflare custom head HTML build needs Static Assets headers.");
    }
    const headers = readFileSync(headersPath, "utf8");
    const nextHeaders = updateCustomHeadHTMLStaticHeaders(headers, customHeadHTML);
    if (nextHeaders !== headers) writeFileSync(headersPath, nextHeaders);
  },
});

function contentSecurityPolicy(customHeadHTML: CustomHeadHTML | undefined): string {
  if (customHeadHTML) return trustedExtensionContentSecurityPolicy(false);

  const turnstileChallengeOrigin = "https://challenges.cloudflare.com";
  const scriptSources = ["'self'", "'unsafe-inline'", "'wasm-unsafe-eval'", turnstileChallengeOrigin];
  const connectSources = ["'self'", "https:", turnstileChallengeOrigin];
  return [
    "default-src 'self'",
    "script-src " + scriptSources.join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "connect-src " + connectSources.join(" "),
    "font-src 'self' data:",
    "frame-src " + turnstileChallengeOrigin,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const coreChunkGroups = [
  {
    name: "react-core",
    test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
    priority: 30,
  },
  {
    name: "router-core",
    test: /node_modules[\\/]react-router[\\/]/,
    priority: 20,
  },
  {
    name: "query-core",
    test: /node_modules[\\/]@tanstack[\\/](query-core|react-query)[\\/]/,
    priority: 10,
  },
];

export default defineConfig(async ({ command, mode }) => {
  const env = loadEnv(mode, repoRoot, "");
  const devProxyTarget = process.env["VITE_DEV_PROXY_TARGET"] ?? env["VITE_DEV_PROXY_TARGET"] ?? "http://127.0.0.1:3000";
  const renewletRuntime = process.env["VITE_RENEWLET_RUNTIME"] ?? env["VITE_RENEWLET_RUNTIME"];
  const clientBuildVersion = resolveClientBuildVersion(repoRoot, { ...env, ...process.env });
  const shouldInjectCustomHeadHTML = command === "serve" || renewletRuntime === "cloudflare";
  // Docker 在进程启动时冻结配置，Cloudflare Static Assets 则只能在构建期注入；修改 Cloudflare 变量后必须重新构建部署。
  const customHeadHTML = shouldInjectCustomHeadHTML
    ? parseCustomHeadHTML(process.env[customHeadHTMLEnvName] ?? env[customHeadHTMLEnvName])
    : undefined;

  const plugins: PluginOption[] = [
    customHeadHTMLPlugin(customHeadHTML, {
      updateStaticHeaders: command === "build" && renewletRuntime === "cloudflare",
    }),
    lingui({ failOnCompileError: true }),
    tailwindcss(),
    react(),
    bundleModuleGraphPlugin(repoRoot),
  ];
  if (process.env["ANALYZE"] === "1") {
    const { visualizer } = await import("rollup-plugin-visualizer");
    plugins.push(visualizer({
      filename: path.resolve(rootDir, "dist/bundle-report.html"),
      gzipSize: true,
      brotliSize: true,
      open: false,
    }));
  }

  return {
    plugins,
    // 这两个依赖只在 Dedicated Worker 内动态加载，HTML 入口扫描不可见；启动前预优化可避免运行中 reload 丢失导入弹窗状态。
    optimizeDeps: {
      include: ["jszip", "sql.js"],
    },
    worker: {
      plugins: () => [lingui({ failOnCompileError: true })],
    },
    resolve: {
      alias: {
        "@": path.resolve(rootDir, "src"),
      },
    },
    define: {
      __RENEWLET_CLIENT_BUILD_VERSION__: JSON.stringify(clientBuildVersion),
    },
    server: {
      port: 5173,
      headers: {
        "Content-Security-Policy": contentSecurityPolicy(customHeadHTML),
      },
      proxy: {
        "/api": devProxyOptions(devProxyTarget),
        "/calendar/renewals.ics": devProxyOptions(devProxyTarget),
        "/_": devProxyOptions(devProxyTarget),
      },
      allowedHosts: ["sh.cfhd.de"],
    },
    build: {
      target: "es2022",
      manifest: true,
      rolldownOptions: {
        output: {
          // Workers Static Assets 直接下发前端产物；按依赖边界拆主包，避免首屏 JS 重新越过 Vite 500KB 预警线。
          codeSplitting: {
            groups: coreChunkGroups,
          },
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  };
});
