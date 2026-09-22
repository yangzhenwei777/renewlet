#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const APP_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SOURCE_ROOT = join(APP_ROOT, "src");
const SOURCE_EXTENSIONS = new Set([".jsx", ".tsx"]);
const EXCLUDED_LAYOUT_FILES = new Set([
  "admin-user-row.tsx",
  "subscription-advanced-date-range-fields.tsx",
  "subscription-advanced-filter.tsx",
]);
const VALID_BREAKPOINTS = new Set(["sm", "md", "lg"]);
const CONTROL_NAMES = new Set([
  "AIModelCombobox",
  "DateOnlyPickerField",
  "Input",
  "NumericInput",
  "SearchableSelect",
  "Select",
  "SubscriptionPaymentMethodSelect",
  "Textarea",
  "TimePicker",
  "input",
  "select",
  "textarea",
]);
const FIELD_COMPONENT_PATTERN = /(?:Field|SettingRow)$/;
const LOCAL_FIELD_ROW_PATTERN = /FieldRow$/;
const CONTROL_COMPONENT_PATTERN = /(?:Combobox|Input|Picker|Select|Switch|Textarea)$/;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name))) return [];
    if (EXCLUDED_LAYOUT_FILES.has(entry.name)) return [];
    return /\.(?:test|spec)\.[jt]sx$/.test(entry.name) ? [] : [path];
  }));
  return files.flat().sort();
}

function jsxName(node) {
  const tagName = node.tagName ?? node.openingElement?.tagName;
  return tagName ? tagName.getText() : null;
}

function jsxAttributes(node) {
  return node.attributes ?? node.openingElement?.attributes;
}

function findAttribute(node, name) {
  return jsxAttributes(node)?.properties.find((property) => (
    ts.isJsxAttribute(property) && property.name.text === name
  ));
}

function literalAttributeValue(attribute) {
  if (!attribute?.initializer) return null;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression) return null;
  const expression = attribute.initializer.expression;
  return ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)
    ? expression.text
    : null;
}

function collectStringLiterals(node, values = []) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    values.push(node.text);
    return values;
  }
  ts.forEachChild(node, (child) => collectStringLiterals(child, values));
  return values;
}

function classTokens(node) {
  const attribute = findAttribute(node, "className");
  if (!attribute?.initializer) return new Set();
  return new Set(collectStringLiterals(attribute.initializer).flatMap((value) => value.split(/\s+/).filter(Boolean)));
}

function isJsxNode(node) {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function isControlName(name) {
  return CONTROL_NAMES.has(name) || CONTROL_COMPONENT_PATTERN.test(name);
}

function isReadOnlyControl(node) {
  const name = jsxName(node);
  if (name !== "Input" && name !== "input") return false;
  const attribute = findAttribute(node, "readOnly");
  if (!attribute) return false;
  if (!attribute.initializer) return true;
  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword;
  }
  return literalAttributeValue(attribute) === "true";
}

function countDescendants(node, predicate) {
  let count = 0;
  function visit(child) {
    if (isJsxNode(child) && jsxName(child) === "FormFieldRow") return;
    if (isJsxNode(child) && predicate(child)) count += 1;
    ts.forEachChild(child, visit);
  }
  ts.forEachChild(node, visit);
  return count;
}

function countFieldGroups(node) {
  if (isJsxNode(node)) {
    const name = jsxName(node);
    if (name === "FormFieldRow") return 0;
    if (name === "FormField") return 1;
    if (name && FIELD_COMPONENT_PATTERN.test(name)) return 1;

    const labelCount = countDescendants(node, (child) => {
      const childName = jsxName(child);
      return childName === "Label" || childName === "label";
    });
    const controlCount = countDescendants(node, (child) => isControlName(jsxName(child) ?? ""));
    if (labelCount === 1 && controlCount > 0) return 1;
  }

  let count = 0;
  ts.forEachChild(node, (child) => {
    count += countFieldGroups(child);
  });
  return count;
}

function hasEditableControlAction(node) {
  const editableControls = countDescendants(node, (child) => (
    isControlName(jsxName(child) ?? "") && !isReadOnlyControl(child)
  ));
  const actions = countDescendants(node, (child) => {
    const name = jsxName(child);
    return name === "Button" || name === "button";
  });
  return editableControls > 0 && actions > 0;
}

function location(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function inspectSourceFile(file, content) {
  const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const violations = [];

  function report(node, message) {
    violations.push({ file: relative(APP_ROOT, file), message, ...location(sourceFile, node) });
  }

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node)
      && node.name
      && node.name.text !== "FormFieldRow"
      && LOCAL_FIELD_ROW_PATTERN.test(node.name.text)
    ) {
      report(node.name, "禁止声明本地 FieldRow；多列字段必须使用公共 FormFieldRow");
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text !== "FormFieldRow"
      && LOCAL_FIELD_ROW_PATTERN.test(node.name.text)
    ) {
      report(node.name, "禁止声明本地 FieldRow；多列字段必须使用公共 FormFieldRow");
    }

    if (isJsxNode(node)) {
      const name = jsxName(node);
      if (name === "FormFieldRow") {
        const alignAt = literalAttributeValue(findAttribute(node, "alignAt"));
        if (!alignAt || !VALID_BREAKPOINTS.has(alignAt)) {
          report(node, 'FormFieldRow 必须显式声明 alignAt="sm|md|lg"');
        }
      } else {
        const tokens = classTokens(node);
        const responsiveColumns = [...tokens].some((token) => /^(?:sm|md|lg):grid-cols-/.test(token));
        if (responsiveColumns) {
          const hasItemsEnd = [...tokens].some((token) => /^(?:(?:sm|md|lg):)?items-end$/.test(token));
          const fieldGroups = countFieldGroups(node);
          if (hasItemsEnd && fieldGroups > 0) {
            report(node, "含字段的响应式 grid 禁止使用 items-end");
          }
          if (fieldGroups >= 2) {
            report(node, "响应式多列字段必须由 FormFieldRow 统一 label/control/description 轨道");
          }
          if (fieldGroups > 0 && hasEditableControlAction(node)) {
            report(node, "响应式字段与行内动作必须使用 FormFieldRow 和 FormFieldRowAction");
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

const violations = [];
for (const file of await collectSourceFiles(SOURCE_ROOT)) {
  violations.push(...inspectSourceFile(file, await readFile(file, "utf8")));
}

if (violations.length > 0) {
  console.error("Form field layout violations found:");
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}:${violation.column} ${violation.message}`);
  }
  process.exit(1);
}

console.log("Form field layout check passed.");
