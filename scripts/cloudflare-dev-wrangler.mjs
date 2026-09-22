#!/usr/bin/env node
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";

const SYSTEM_PROXY_OPT_IN = "RENEWLET_CLOUDFLARE_DEV_SYSTEM_PROXY";
const childEnv = wranglerDevEnv(process.env);
const child = spawn(wranglerBin(), ["dev", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 0;
});

function wranglerDevEnv(baseEnv) {
  if (hasProxyEnvironment(baseEnv) || process.platform !== "darwin" || baseEnv[SYSTEM_PROXY_OPT_IN] !== "1") {
    return baseEnv;
  }
  const systemProxy = macOsSystemProxy();
  if (!systemProxy) return baseEnv;
  const next = { ...baseEnv };
  if (systemProxy.http) {
    next.HTTP_PROXY = systemProxy.http;
    next.http_proxy = systemProxy.http;
  }
  if (systemProxy.https) {
    next.HTTPS_PROXY = systemProxy.https;
    next.https_proxy = systemProxy.https;
  }
  if (!next.NO_PROXY && !next.no_proxy) {
    next.NO_PROXY = "127.0.0.1,localhost,::1";
  }
  // 只说明来源，不打印代理值；本地代理地址可能暴露公司网络或带认证信息。
  console.log("Using macOS system proxy for Wrangler local dev upstream requests.");
  return next;
}

function hasProxyEnvironment(env) {
  return ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"].some((key) => Boolean(env[key]));
}

function macOsSystemProxy() {
  let output = "";
  try {
    output = execFileSync("scutil", ["--proxy"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const values = Object.fromEntries(output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    return match ? [[match[1], match[2]]] : [];
  }));
  const http = proxyUrl(values.HTTPEnable, values.HTTPProxy, values.HTTPPort);
  const https = proxyUrl(values.HTTPSEnable, values.HTTPSProxy, values.HTTPSPort) ?? http;
  return http || https ? { http, https } : null;
}

function proxyUrl(enabled, host, port) {
  if (enabled !== "1" || !host || !port) return null;
  return `http://${host}:${port}`;
}

function wranglerBin() {
  return process.platform === "win32" ? "wrangler.cmd" : "wrangler";
}
