import ts from "typescript";

const visibleAttributeNames = new Set([
  "alt",
  "title",
  "placeholder",
  "aria-label",
  "aria-braillelabel",
  "aria-brailleroledescription",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
]);
// 白名单只放行完整且独立的品牌/协议 token；包含这些 token 的产品句子仍必须进入 Lingui。
const allowedTokens = new Set([
  "Renewlet",
  "Cloudflare",
  "Docker",
  "PocketBase",
  "Telegram",
  "NotifyX",
  "Bark",
  "PushPlus",
  "DingTalk",
  "WeCom",
  "Discord",
  "ServerChan",
  "Apple",
  "Google",
  "GitHub",
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HTTP",
  "HTTPS",
  "JSON",
  "HTML",
  "SMTP",
  "URL",
  "Markdown",
  "UTC",
  "renewlet",
  "v",
  "auto",
  "sk-...",
]);

/** 静态扫描 JSX 可见文本；返回源码位置，调用方负责按生产文件范围汇总报告。 */
export function findFrontendI18nViolations(source, fileName = "source.tsx") {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  const violations = [];

  function report(node, text, kind) {
    const displayText = normalizeDisplayText(text);
    if (!displayText || isAllowedVisibleLiteral(displayText)) return;
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    violations.push({
      line: position.line + 1,
      column: position.character + 1,
      kind,
      text: displayText,
    });
  }

  function visit(node) {
    if (ts.isJsxText(node)) {
      report(node, node.getText(sourceFile), "JSX text");
    } else if (
      ts.isJsxExpression(node)
      && node.expression
      && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))
    ) {
      for (const text of staticExpressionTexts(node.expression, sourceFile)) {
        report(node, text, "JSX expression text");
      }
    } else if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile).toLowerCase();
      if (visibleAttributeNames.has(name)) {
        for (const text of staticJsxAttributeTexts(node.initializer, sourceFile)) {
          report(node, text, `${name} attribute`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function staticJsxAttributeTexts(initializer, sourceFile) {
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [initializer.text];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  return staticExpressionTexts(initializer.expression, sourceFile);
}

function staticExpressionTexts(expression, sourceFile) {
  // 只合并 AST 能证明的静态片段；identifier/call 可能来自用户数据或 Lingui，不能靠字符串猜测误报。
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isParenthesizedExpression(expression)) return staticExpressionTexts(expression.expression, sourceFile);
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticExpressionTexts(expression.left, sourceFile);
    const right = staticExpressionTexts(expression.right, sourceFile);
    if (left.length === 0) return right;
    if (right.length === 0) return left;
    return left.flatMap((leftText) => right.map((rightText) => `${leftText}${rightText}`));
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...staticExpressionTexts(expression.whenTrue, sourceFile),
      ...staticExpressionTexts(expression.whenFalse, sourceFile),
    ];
  }
  if (
    ts.isBinaryExpression(expression)
    && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]
      .includes(expression.operatorToken.kind)
  ) {
    return [
      ...staticExpressionTexts(expression.left, sourceFile),
      ...staticExpressionTexts(expression.right, sourceFile),
    ];
  }
  if (ts.isTemplateExpression(expression)) {
    const pieces = [expression.head.text];
    for (const span of expression.templateSpans) pieces.push(span.literal.text);
    return [pieces.join(" ")];
  }
  void sourceFile;
  return [];
}

function normalizeDisplayText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isAllowedVisibleLiteral(value) {
  if (!/[\p{L}\p{N}]/u.test(value)) return true;
  if (allowedTokens.has(value)) return true;
  if (/^(?:https?:\/\/|mailto:|tel:)[^\s]+$/i.test(value)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return true;
  if (/^(?:[^\s,@]+@[^\s,@]+\.[^\s,@]+)(?:,\s*[^\s,@]+@[^\s,@]+\.[^\s,@]+)+$/.test(value)) return true;
  if (/^Renewlet\s+<[^\s@]+@[^\s@]+\.[^\s@]+>$/.test(value)) return true;
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(value)) return true;
  if (/^#[0-9a-f]{6}$/i.test(value)) return true;
  if (/^(?=.*[xX]{4})[A-Za-z0-9_:+,.-]+$/.test(value)) return true;
  if (/^(?:[YMDHhms:\-/.\[\]{}()#%+*?=<>_]|\d)+$/.test(value)) return true;
  if (/^\.[a-z0-9]+$/i.test(value)) return true;
  return false;
}
