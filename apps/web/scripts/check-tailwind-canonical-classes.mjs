#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { __unstable__loadDesignSystem } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";
import ts from "typescript";

const APP_ROOT = resolve(import.meta.dirname, "..");
const SOURCE_ROOT = join(APP_ROOT, "src");
const ENTRY_CSS = join(SOURCE_ROOT, "index.css");
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
// Tailwind IntelliSense 默认同样按 16px 换算；根字号变化时必须同步两侧，否则 px 类名会只在 IDE 中告警。
const ROOT_FONT_SIZE_PX = 16;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
    }),
  );
  return files.flat().sort();
}

function stringLiteralRanges(file, content) {
  const scriptKind = extname(file) === ".tsx" || extname(file) === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKind);
  const ranges = [];

  function visit(node) {
    if (ts.isStringLiteralLike(node)) {
      ranges.push({ start: node.getStart(sourceFile), end: node.end });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return ranges;
}

function isInsideStringLiteral(position, length, ranges) {
  let low = 0;
  let high = ranges.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (position < range.start) {
      high = middle - 1;
    } else if (position >= range.end) {
      low = middle + 1;
    } else {
      return position + length <= range.end;
    }
  }

  return false;
}

function sourceLocation(content, position) {
  const before = content.slice(0, position);
  const lineStart = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: position - lineStart,
  };
}

export async function loadProjectDesignSystem() {
  // 直接加载项目 CSS 的设计系统，确保检查结果随 Tailwind/theme 演进，不维护会漂移的 class 映射表。
  return __unstable__loadDesignSystem(await readFile(ENTRY_CSS, "utf8"), {
    base: SOURCE_ROOT,
  });
}

export function canonicalizeCandidate(designSystem, candidate) {
  const suggestions = designSystem.canonicalizeCandidates([candidate], { rem: ROOT_FONT_SIZE_PX });
  return suggestions.length === 1 ? suggestions[0] : candidate;
}

export async function findViolations() {
  const designSystem = await loadProjectDesignSystem();
  const scanner = new Scanner({});
  const canonicalByCandidate = new Map();
  const violations = [];

  for (const file of await collectSourceFiles(SOURCE_ROOT)) {
    const content = await readFile(file, "utf8");
    const ranges = stringLiteralRanges(file, content);
    const extension = extname(file).slice(1);
    const candidates = scanner.getCandidatesWithPositions({ file, content, extension });

    for (const { candidate, position } of candidates) {
      // Oxide 会扫描完整源码；只检查字符串字面量，避免把 `!container` 这类 JS 表达式误当作 utility。
      if (!isInsideStringLiteral(position, candidate.length, ranges)) continue;

      let canonical = canonicalByCandidate.get(candidate);
      if (canonical === undefined) {
        canonical = canonicalizeCandidate(designSystem, candidate);
        canonicalByCandidate.set(candidate, canonical);
      }
      if (canonical === candidate) continue;

      violations.push({
        file: relative(APP_ROOT, file),
        candidate,
        canonical,
        ...sourceLocation(content, position),
      });
    }
  }

  return violations;
}

async function main() {
  const violations = await findViolations();

  if (violations.length > 0) {
    console.error("Non-canonical Tailwind classes found:");
    for (const violation of violations) {
      console.error(
        `${violation.file}:${violation.line}:${violation.column} ${violation.candidate} -> ${violation.canonical}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log("Tailwind canonical class check passed.");
}

if (import.meta.main) {
  await main();
}
