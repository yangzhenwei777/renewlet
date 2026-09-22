// 导航约定测试扫描源码，防止内部页面误用原生 a 标签绕过 React Router 和 public route 清单。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const thisFile = fileURLToPath(import.meta.url);
const srcDir = path.resolve(path.dirname(thisFile), "..");

function collectTsxFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsxFiles(fullPath));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      files.push(fullPath);
    }
  }

  return files;
}

function isAnchorElement(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): boolean {
  return ts.isIdentifier(node.tagName) && node.tagName.text === "a";
}

function getLiteralHref(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string | undefined {
  for (const property of node.attributes.properties) {
    if (!ts.isJsxAttribute(property) || !ts.isIdentifier(property.name) || property.name.text !== "href") continue;
    const initializer = property.initializer;
    if (!initializer) return undefined;
    if (ts.isStringLiteral(initializer)) return initializer.text;
    if (!ts.isJsxExpression(initializer) || !initializer.expression) return undefined;
    if (ts.isStringLiteral(initializer.expression) || ts.isNoSubstitutionTemplateLiteral(initializer.expression)) {
      return initializer.expression.text;
    }
  }

  return undefined;
}

function isAllowedDocumentHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return true;
  if (href === "/_" || href.startsWith("/_/")) return true;
  if (href === "/api" || href.startsWith("/api/")) return true;
  if (/\/[^/]+\.[A-Za-z0-9]+$/.test(href)) return true;
  return false;
}

describe("navigation conventions", () => {
  it("keeps root-relative app navigation on the React Router Link wrapper", () => {
    const violations: string[] = [];

    for (const file of collectTsxFiles(srcDir)) {
      const sourceText = fs.readFileSync(file, "utf8");
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && isAnchorElement(node)) {
          const href = getLiteralHref(node);
          if (href && !isAllowedDocumentHref(href)) {
            const position = source.getLineAndCharacterOfPosition(node.getStart(source));
            const relativePath = path.relative(srcDir, file);
            violations.push(`${relativePath}:${position.line + 1}:${position.character + 1} <a href="${href}">`);
          }
        }

        ts.forEachChild(node, visit);
      };

      visit(source);
    }

    expect(violations).toEqual([]);
  });
});
