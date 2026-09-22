import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 这是部署守卫所需的最小 SQL lexer：跳过注释，区分字符串与标识符，并保留 SQLite 的四种引用标识符。
// 直接对源码做正则会把示例/字符串误判为语句，也会漏掉带引号的危险表名。
function sqlTokens(sql) {
  const tokens = [];
  for (let index = 0; index < sql.length;) {
    const character = sql.charAt(index);
    const next = sql.charAt(index + 1);
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql.charAt(index) !== "\n") index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < sql.length && !(sql.charAt(index) === "*" && sql.charAt(index + 1) === "/")) index += 1;
      index += 2;
      continue;
    }
    const closingQuote = character === "[" ? "]" : character;
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      const kind = character === "'" ? "string" : "identifier";
      let value = "";
      index += 1;
      while (index < sql.length) {
        const quoted = sql.charAt(index);
        if (quoted === closingQuote) {
          if (sql.charAt(index + 1) === closingQuote && closingQuote !== "]") {
            value += closingQuote;
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += quoted;
        index += 1;
      }
      tokens.push({ kind, value: value.toUpperCase() });
      continue;
    }
    const word = sql.slice(index).match(/^[A-Za-z_][A-Za-z0-9_$]*/)?.[0]
      ?? sql.slice(index).match(/^\d+/)?.[0];
    if (word) {
      tokens.push({ kind: "word", value: word.toUpperCase() });
      index += word.length;
      continue;
    }
    tokens.push({ kind: "symbol", value: character });
    index += 1;
  }
  return tokens;
}

function tokenIs(token, value) {
  return token !== undefined && token.kind === "word" && token.value === value;
}

function identifierAfter(tokens, index) {
  // SQLite 允许 main."subscriptions" 这类 schema-qualified 标识符；守卫必须识别它，同时不误拦 attached schema。
  const first = tokens[index];
  if (!first || first.kind === "symbol") return { index, value: "" };
  if (tokens[index + 1]?.value === ".") {
    const second = tokens[index + 2];
    return second && second.kind !== "symbol"
      ? { index: index + 3, value: second.value, schema: first.value }
      : { index, value: "" };
  }
  return { index: index + 1, value: first.value };
}

function disablesForeignKeys(tokens, index) {
  // 覆盖 SQLite 接受的 OFF/FALSE/NO/0 写法，避免未来 migration 通过等价拼法绕过 D1 外键守卫。
  const identifier = identifierAfter(tokens, index + 1);
  if (identifier.value !== "FOREIGN_KEYS" || (identifier.schema && identifier.schema !== "MAIN")) return false;
  const operator = tokens[identifier.index]?.value;
  let valueIndex = operator === "=" || operator === "(" ? identifier.index + 1 : -1;
  if (tokens[valueIndex]?.value === "(") valueIndex += 1;
  if (tokens[valueIndex]?.value === "+" || tokens[valueIndex]?.value === "-") valueIndex += 1;
  const value = tokens[valueIndex]?.value ?? "";
  return ["OFF", "FALSE", "NO"].includes(value) || (/^\d+$/.test(value) && Number(value) === 0);
}

function dropsSubscriptions(tokens, index) {
  if (!tokenIs(tokens[index + 1], "TABLE")) return false;
  let identifierIndex = index + 2;
  if (tokenIs(tokens[identifierIndex], "IF") && tokenIs(tokens[identifierIndex + 1], "EXISTS")) {
    identifierIndex += 2;
  }
  const identifier = identifierAfter(tokens, identifierIndex);
  return identifier.value === "SUBSCRIPTIONS" && (!identifier.schema || identifier.schema === "MAIN");
}

function deletesSubscriptions(tokens, index) {
  if (!tokenIs(tokens[index + 1], "FROM")) return false;
  const identifier = identifierAfter(tokens, index + 2);
  return identifier.value === "SUBSCRIPTIONS" && (!identifier.schema || identifier.schema === "MAIN");
}

/** 0035 之后的 migration 不得再依赖 D1 无法关闭的外键开关，也不得直接删除 subscriptions 事实表。 */
export function checkCloudflareMigrationSafety(repoRoot) {
  const migrationsDir = join(repoRoot, "apps/worker/migrations");
  const migrations = readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const migration of migrations) {
    const sequence = Number.parseInt(migration.slice(0, 4), 10);
    if (sequence <= 35) continue;
    const tokens = sqlTokens(readFileSync(join(migrationsDir, migration), "utf8"));
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokenIs(tokens[index], "PRAGMA") && disablesForeignKeys(tokens, index)) {
        throw new Error(`${migration} must not disable D1 foreign keys; D1 migrations keep them enabled.`);
      }
      if (tokenIs(tokens[index], "DROP") && dropsSubscriptions(tokens, index)) {
        throw new Error(`${migration} must not drop subscriptions directly; use an upgrade path that preserves child facts.`);
      }
      if (tokenIs(tokens[index], "DELETE") && deletesSubscriptions(tokens, index)) {
        throw new Error(`${migration} must not delete from subscriptions directly; preserve subscription facts.`);
      }
    }
  }
}
