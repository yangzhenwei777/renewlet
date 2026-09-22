import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROXY_ENV_GROUPS = [
  { recommended: "HTTP_PROXY", alternative: "http_proxy" },
  { recommended: "HTTPS_PROXY", alternative: "https_proxy" },
  { recommended: "NO_PROXY", alternative: "no_proxy" },
];

const ENV_EXAMPLE_FILES = [".env.example", "deploy/env.example"];
const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.ghcr.yml",
  "deploy/docker-compose.yml",
];
const README_CONTRACTS = [
  {
    relativePath: "README.md",
    recommendation: "Use the uppercase names by default.",
    precedence: "Do not set both forms; when both are present, Go uses the uppercase value.",
  },
  {
    relativePath: "README.zh-CN.md",
    recommendation: "默认使用大写变量。",
    precedence: "不要同时配置大小写两组变量；两组同时存在时，Go 优先读取大写值。",
  },
];
const ENV_GUIDANCE = [
  "# 推荐写法：使用大写变量。",
  "# 备选写法：也支持小写变量；不要同时配置两组，同时存在时 Go 优先读取大写。",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasEnvAssignment(content, envName) {
  const pattern = new RegExp(`^\\s*(?:#\\s*)?${escapeRegExp(envName)}\\s*=`, "m");
  return pattern.test(content);
}

function leadingWhitespaceLength(line) {
  return /^\s*/.exec(line)?.[0].length ?? 0;
}

function findMappingLine(lines, key, start, parentIndent, relativePath, parentPath) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}:\\s*(?:#.*)?$`);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const indent = leadingWhitespaceLength(line);
    if (indent <= parentIndent) {
      break;
    }
    if (pattern.test(line)) {
      return { index, indent };
    }
  }
  throw new Error(`${relativePath} must define ${parentPath}.${key}.`);
}

function composeWebEnvironmentLines(content, relativePath) {
  const lines = content.split(/\r?\n/);
  const servicesIndex = lines.findIndex((line) => /^services:\s*(?:#.*)?$/.test(line));
  if (servicesIndex < 0) {
    throw new Error(`${relativePath} must define services.`);
  }

  const web = findMappingLine(lines, "web", servicesIndex + 1, 0, relativePath, "services");
  const environment = findMappingLine(
    lines,
    "environment",
    web.index + 1,
    web.indent,
    relativePath,
    "services.web",
  );
  const block = [];
  for (let index = environment.index + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (leadingWhitespaceLength(line) <= environment.indent) {
      break;
    }
    block.push(line.trim());
  }
  return block;
}

function composeValuesFor(lines, envName) {
  const pattern = new RegExp(`^${escapeRegExp(envName)}:\\s*(.+?)\\s*$`);
  const values = [];
  for (const line of lines) {
    const match = pattern.exec(line);
    if (!match) {
      continue;
    }
    const value = match[1].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, "$1$2");
    values.push(value);
  }
  return values;
}

function checkEnvExamples(repoRoot, envNames) {
  for (const relativePath of ENV_EXAMPLE_FILES) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    for (const guidance of ENV_GUIDANCE) {
      if (!content.includes(guidance)) {
        throw new Error(`${relativePath} must explain the recommended and alternative proxy forms.`);
      }
    }
    for (const envName of envNames) {
      if (!hasEnvAssignment(content, envName)) {
        throw new Error(`${relativePath} must list Docker upstream proxy env ${envName} as an environment assignment.`);
      }
    }
  }
}

function checkComposeFiles(repoRoot, envNames) {
  for (const relativePath of COMPOSE_FILES) {
    const content = readFileSync(join(repoRoot, relativePath), "utf8");
    const environmentLines = composeWebEnvironmentLines(content, relativePath);
    for (const envName of envNames) {
      const expected = `\${${envName}:-}`;
      const values = composeValuesFor(environmentLines, envName);
      if (values.length !== 1 || values[0] !== expected) {
        throw new Error(
          `${relativePath} must pass through Docker upstream proxy env ${envName} as ${envName}: ${expected}.`,
        );
      }
    }
  }
}

function checkReadmes(repoRoot) {
  for (const contract of README_CONTRACTS) {
    const content = readFileSync(join(repoRoot, contract.relativePath), "utf8");
    for (const { recommended, alternative } of PROXY_ENV_GROUPS) {
      if (!hasEnvAssignment(content, recommended)) {
        throw new Error(`${contract.relativePath} must show recommended Docker upstream proxy env ${recommended}.`);
      }
      if (!content.includes(`\`${alternative}\``)) {
        throw new Error(`${contract.relativePath} must document Docker upstream proxy alias ${alternative}.`);
      }
    }
    if (!content.includes(contract.recommendation) || !content.includes(contract.precedence)) {
      throw new Error(
        `${contract.relativePath} must recommend uppercase proxy envs and document the no-mixing precedence rule.`,
      );
    }
  }
}

/** 校验 Go 运行时代理变量在 env 示例、Compose 透传和用户文档三层保持同步。 */
export function checkDockerProxyContract(repoRoot) {
  const envNames = PROXY_ENV_GROUPS.flatMap(({ recommended, alternative }) => [
    recommended,
    alternative,
  ]);
  checkEnvExamples(repoRoot, envNames);
  checkComposeFiles(repoRoot, envNames);
  checkReadmes(repoRoot);
}
