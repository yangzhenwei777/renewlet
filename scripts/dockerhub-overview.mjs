#!/usr/bin/env node
/**
 * Docker Hub Overview 手工维护辅助脚本。
 *
 * 触发时机：维护者通过 Docker Hub 官方 UI 更新 Overview；输入是仓库 README.md，输出是所有相对资源都改成 GitHub 绝对 URL 的 Markdown。
 * 参数：`--ref` 指向 tag/branch/commit，`--output` 写文件，`--check` 只验证没有残留相对引用。
 *
 * 注意：脚本不访问网络，只做文本转换；Docker Hub 没有仓库上下文，未转换的相对图片会在镜像页全部失效。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const githubBaseUrl = "https://github.com/zhiyingzzhou/renewlet";
const rawBaseUrl = "https://raw.githubusercontent.com/zhiyingzzhou/renewlet";
const defaultRef = "main";

function usage() {
  console.log(`Usage:
  node scripts/dockerhub-overview.mjs [--ref <git-ref>] [--output <path>] [--check]`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { ref: defaultRef, output: "", check: false };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];

    if (value === "--help" || value === "-h") {
      usage();
      process.exit(0);
    }

    if (value === "--check") {
      args.check = true;
      continue;
    }

    if (value === "--ref" || value === "--output") {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) {
        fail(`${value} requires a value.`);
      }
      args[value.slice(2)] = next;
      index += 1;
      continue;
    }

    fail(`Unknown argument: ${value}`);
  }

  return args;
}

function isAbsoluteOrAnchor(value) {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//") || value.startsWith("#");
}

function normalizeRepoPath(value) {
  return value.replace(/^\.?\//, "");
}

function rawUrl(value, ref) {
  return `${rawBaseUrl}/${ref}/${normalizeRepoPath(value)}`;
}

function blobUrl(value, ref) {
  return `${githubBaseUrl}/blob/${ref}/${normalizeRepoPath(value)}`;
}

function convertImageUrl(value, ref) {
  return isAbsoluteOrAnchor(value) ? value : rawUrl(value, ref);
}

function convertLinkUrl(value, ref) {
  return isAbsoluteOrAnchor(value) ? value : blobUrl(value, ref);
}

function convertHtmlAttributes(markdown, ref) {
  // README 里同时存在 HTML img/a 和 Markdown 链接；两套语法必须都转，否则 Docker Hub 只会坏一半资源。
  return markdown
    .replace(/(\s+src=)(["'])([^"']+)\2/g, (match, prefix, quote, value) => `${prefix}${quote}${convertImageUrl(value, ref)}${quote}`)
    .replace(/(\s+href=)(["'])([^"']+)\2/g, (match, prefix, quote, value) => `${prefix}${quote}${convertLinkUrl(value, ref)}${quote}`);
}

function convertMarkdownImages(markdown, ref) {
  return markdown.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, alt, value) => {
    return `![${alt}](${convertImageUrl(value, ref)})`;
  });
}

function convertMarkdownLinks(markdown, ref) {
  return markdown.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (match, label, value) => {
    return `[${label}](${convertLinkUrl(value, ref)})`;
  });
}

function dockerhubOverview(source, ref) {
  // Docker Hub 不具备 GitHub 仓库上下文；所有公开资源必须在同步前改成绝对 URL。
  return convertMarkdownLinks(convertMarkdownImages(convertHtmlAttributes(source, ref), ref), ref);
}

function collectRelativeReferences(markdown) {
  const problems = [];
  const htmlAttributePattern = /\s+(src|href)=(["'])([^"']+)\2/g;
  const markdownLinkPattern = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

  for (const match of markdown.matchAll(htmlAttributePattern)) {
    const [, attribute, , value] = match;
    if (!isAbsoluteOrAnchor(value)) {
      problems.push(`${attribute}=${value}`);
    }
  }

  for (const match of markdown.matchAll(markdownLinkPattern)) {
    const [, bang, label, value] = match;
    if (!isAbsoluteOrAnchor(value)) {
      problems.push(`${bang ? "image" : "link"} ${label}: ${value}`);
    }
  }

  return problems;
}

const args = parseArgs(process.argv.slice(2));
const readmePath = join(repoRoot, "README.md");
const source = readFileSync(readmePath, "utf8");
const overview = dockerhubOverview(source, args.ref);
const problems = collectRelativeReferences(overview);

if (problems.length > 0) {
  fail(`Docker Hub overview still contains relative references:\n${problems.join("\n")}`);
}

if (args.output) {
  // 供官方 UI 粘贴的文件通常写入临时目录；父目录不存在时由脚本负责创建。
  mkdirSync(dirname(resolve(repoRoot, args.output)), { recursive: true });
  writeFileSync(resolve(repoRoot, args.output), overview);
}

if (args.check) {
  console.log("Docker Hub overview references are absolute.");
} else if (!args.output) {
  process.stdout.write(overview);
}
