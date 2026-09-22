#!/usr/bin/env node

/**
 * 图标索引生成脚本（内置多 provider）。
 *
 * 触发时机：维护者手动运行 `pnpm update:built-in-icons-index`，上游 registry 更新后再提交生成结果。
 * 前置依赖：Node.js fetch、可访问 TheSVG/selfh.st/Dashboard Icons 的网络，以及 shared media resolver 配置。
 * 副作用：重写前端运行时 seed 索引、Go embedded static seed 索引，以及 provider 级 GitHub 版本 metadata。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBuiltInIconIndex,
  canonicalBuiltInIconSeedMetadataJson,
  canonicalBuiltInIconIndexJson,
  canonicalBuiltInIconSearchIndexJson,
  countBuiltInIconProviders,
  createBuiltInIconSearchIndex,
  createBuiltInIconSeedMetadata,
} from "../packages/shared/src/built-in-icon-index-builder.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(__dirname, "../packages/shared/data/media-resolver-config.json");
const mediaResolverConfig = JSON.parse(await readFile(configPath, "utf8"));

const searchIndexOutputPaths = [
  path.resolve(__dirname, "../apps/web/public/built-in-icons/search-index.json.gz"),
  path.resolve(__dirname, "../apps/docker-server/internal/static/data/built-in-icons-search-index.json.gz"),
];
const detailIndexOutputPaths = [
  path.resolve(__dirname, "../apps/web/public/built-in-icons/detail-index.json.gz"),
  path.resolve(__dirname, "../apps/docker-server/internal/static/data/built-in-icons-detail-index.json.gz"),
];
const metadataOutputPaths = [
  path.resolve(__dirname, "../apps/web/public/built-in-icons/metadata.json"),
  path.resolve(__dirname, "../apps/docker-server/internal/static/data/built-in-icons-index-metadata.json"),
];
const FETCH_TIMEOUT_MS = 15_000;
const GITHUB_WEB_BASE = "https://github.com";
const GITHUB_ATOM_FEED_LIMIT_BYTES = 512 * 1024;

async function fetchJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 上游 registry 是生成期依赖；超时失败必须阻断索引更新，不能写入半截候选库。
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGitHubAtomFeed(owner, repo, feedPath, label) {
  const url = `${GITHUB_WEB_BASE}/${owner}/${repo}/${feedPath.replace(/^\/+|\/+$/g, "")}.atom`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = {
      accept: "application/atom+xml",
      "user-agent": "Renewlet-built-in-icon-index-generator",
    };
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`${label} HTTP ${response.status}`);
    }
    return await responseTextUpToLimit(response, label, GITHUB_ATOM_FEED_LIMIT_BYTES);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLatestRelease(owner, repo) {
  try {
    const release = parseGitHubReleaseAtomFeed(await fetchGitHubAtomFeed(owner, repo, "releases", `${owner}/${repo} latest release`));
    return {
      tagName: release.tagName,
      publishedAt: release.publishedAt,
    };
  } catch {
    return { tagName: null, publishedAt: null };
  }
}

async function fetchProviderVersion(providerConfig) {
  const { owner, repo, branch, latestRelease } = providerConfig.github;
  const commit = parseGitHubCommitAtomFeed(await fetchGitHubAtomFeed(owner, repo, `commits/${branch}`, `${owner}/${repo} commit`));
  const commitSha = commit.sha;
  const commitShortSha = commitSha.slice(0, 7);
  const release = latestRelease ? await fetchLatestRelease(owner, repo) : { tagName: null, publishedAt: null };
  return {
    sourceRef: commitSha,
    displayVersion: commitShortSha,
    commitSha,
    commitShortSha,
    commitDate: commit.updated,
    releaseTag: release.tagName,
    releasePublishedAt: release.publishedAt,
  };
}

async function responseTextUpToLimit(response, label, limitBytes) {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new Error(`${label} response too large`);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} response too large`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseGitHubCommitAtomFeed(text) {
  const entry = firstGitHubAtomEntry(text);
  const id = atomTagText(entry, "id");
  const sha = id.match(/\/([a-f0-9]{7,40})$/i)?.[1] ?? "";
  if (!sha) throw new Error("GitHub commit feed missing sha");
  return {
    sha,
    updated: atomTagText(entry, "updated") || null,
  };
}

function parseGitHubReleaseAtomFeed(text) {
  const entry = firstGitHubAtomEntry(text);
  const href = entry.match(/<link\b[^>]*\bhref="([^"]+)"/i)?.[1] ?? "";
  const rawTag = href.match(/\/releases\/tag\/([^/?#"]+)/i)?.[1] ?? "";
  const tagName = rawTag ? decodePathSegment(xmlText(rawTag)).trim() : "";
  return {
    tagName: tagName || null,
    publishedAt: atomTagText(entry, "updated") || null,
  };
}

function firstGitHubAtomEntry(text) {
  const entry = text.match(/<entry\b[\s\S]*?<\/entry>/i)?.[0] ?? "";
  if (!entry) throw new Error("GitHub Atom feed is empty");
  return entry;
}

function atomTagText(entry, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  return xmlText(entry.match(pattern)?.[1] ?? "").trim();
}

function xmlText(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

async function fetchProviderVersions(config) {
  const entries = await Promise.all(config.builtInProviders.map(async (providerConfig) => [
    providerConfig.provider,
    await fetchProviderVersion(providerConfig),
  ]));
  return Object.fromEntries(entries);
}

const icons = await buildBuiltInIconIndex(mediaResolverConfig, fetchJson);
const detailIndexJson = canonicalBuiltInIconIndexJson(icons);
const searchIndexJson = canonicalBuiltInIconSearchIndexJson(createBuiltInIconSearchIndex(icons));
const hash = createHash("sha256").update(detailIndexJson).digest("hex");
const providerVersions = await fetchProviderVersions(mediaResolverConfig);
const providerCounts = countBuiltInIconProviders(icons);
const detailIndexGzip = gzipSync(detailIndexJson);
const searchIndexGzip = gzipSync(searchIndexJson);
const metadataJson = canonicalBuiltInIconSeedMetadataJson(createBuiltInIconSeedMetadata(
  icons,
  hash,
  providerVersions,
));

for (const outputPath of searchIndexOutputPaths) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, searchIndexGzip);
}

for (const outputPath of detailIndexOutputPaths) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, detailIndexGzip);
}

for (const outputPath of metadataOutputPaths) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  // metadata 记录生成期真实 GitHub commit；当前版本展示只能读这里或刷新后的 provider 状态，不能手写来源词。
  await writeFile(outputPath, metadataJson, "utf8");
}

console.log(`Generated ${icons.length} built-in icons (${Object.entries(providerCounts).map(([provider, count]) => `${provider}:${count}`).join(", ")}) with search index ${searchIndexOutputPaths.map((item) => path.relative(process.cwd(), item)).join(", ")}, detail index ${detailIndexOutputPaths.map((item) => path.relative(process.cwd(), item)).join(", ")}, metadata ${metadataOutputPaths.map((item) => path.relative(process.cwd(), item)).join(", ")}`);
