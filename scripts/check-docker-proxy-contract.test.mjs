import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkDockerProxyContract } from "./check-docker-proxy-contract.mjs";

const envNames = ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy"];
const envExample = `# 推荐写法：使用大写变量。
# HTTP_PROXY="http://proxy.example:7890"
# HTTPS_PROXY="http://proxy.example:7890"
# NO_PROXY="localhost,127.0.0.1"
# 备选写法：也支持小写变量；不要同时配置两组，同时存在时 Go 优先读取大写。
# http_proxy="http://proxy.example:7890"
# https_proxy="http://proxy.example:7890"
# no_proxy="localhost,127.0.0.1"
`;
const compose = `services:
  web:
    image: renewlet:test
    environment:
${envNames.map((envName) => `      ${envName}: \${${envName}:-}`).join("\n")}
    restart: unless-stopped
`;
const readme = `# Renewlet

HTTP_PROXY="http://proxy.example:7890"
HTTPS_PROXY="http://proxy.example:7890"
NO_PROXY="localhost,127.0.0.1"

Use the uppercase names by default. The lowercase alternatives are \`http_proxy\`, \`https_proxy\`, and \`no_proxy\`. Do not set both forms; when both are present, Go uses the uppercase value.
`;
const readmeZh = `# Renewlet

HTTP_PROXY="http://proxy.example:7890"
HTTPS_PROXY="http://proxy.example:7890"
NO_PROXY="localhost,127.0.0.1"

默认使用大写变量。小写备选名为 \`http_proxy\`、\`https_proxy\` 和 \`no_proxy\`。不要同时配置大小写两组变量；两组同时存在时，Go 优先读取大写值。
`;

function writeFixtureFile(root, relativePath, content) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "renewlet-proxy-contract-"));
  writeFixtureFile(root, ".env.example", envExample);
  writeFixtureFile(root, "deploy/env.example", envExample);
  writeFixtureFile(root, "docker-compose.yml", compose);
  writeFixtureFile(root, "docker-compose.ghcr.yml", compose);
  writeFixtureFile(root, "deploy/docker-compose.yml", compose);
  writeFixtureFile(root, "README.md", readme);
  writeFixtureFile(root, "README.zh-CN.md", readmeZh);
  return root;
}

function withFixture(run) {
  const root = createFixture();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("accepts the complete Docker proxy contract", () => {
  withFixture((root) => assert.doesNotThrow(() => checkDockerProxyContract(root)));
});

test("rejects a missing proxy variable in either env example", () => {
  for (const relativePath of [".env.example", "deploy/env.example"]) {
    withFixture((root) => {
      const path = join(root, relativePath);
      writeFileSync(path, readFileSync(path, "utf8").replace(/^# no_proxy=.*$/m, ""));
      assert.throws(
        () => checkDockerProxyContract(root),
        new RegExp(`${relativePath.replaceAll(".", "\\.")}.*no_proxy`),
      );
    });
  }
});

test("rejects a missing or renamed Compose proxy pass-through", () => {
  for (const relativePath of ["docker-compose.yml", "docker-compose.ghcr.yml", "deploy/docker-compose.yml"]) {
    withFixture((root) => {
      const path = join(root, relativePath);
      writeFileSync(path, readFileSync(path, "utf8").replace(/^\s*HTTPS_PROXY:.*$/m, ""));
      assert.throws(
        () => checkDockerProxyContract(root),
        new RegExp(`${relativePath.replaceAll(".", "\\.")}.*HTTPS_PROXY`),
      );
    });
    withFixture((root) => {
      const path = join(root, relativePath);
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace("HTTP_PROXY: ${HTTP_PROXY:-}", "HTTP_PROXY: ${HTTPS_PROXY:-}"),
      );
      assert.throws(
        () => checkDockerProxyContract(root),
        new RegExp(`${relativePath.replaceAll(".", "\\.")}.*HTTP_PROXY`),
      );
    });
  }
});

test("does not accept proxy text outside the expected config boundary", () => {
  withFixture((root) => {
    const envPath = join(root, ".env.example");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(/^# no_proxy=.*$/m, "# no_proxy is also supported"),
    );
    assert.throws(() => checkDockerProxyContract(root), /\.env\.example.*no_proxy/);
  });

  withFixture((root) => {
    const composePath = join(root, "docker-compose.yml");
    const content = readFileSync(composePath, "utf8")
      .replace(/^\s*NO_PROXY:.*$/m, "")
      .concat("# NO_PROXY: ${NO_PROXY:-}\n");
    writeFileSync(composePath, content);
    assert.throws(() => checkDockerProxyContract(root), /docker-compose\.yml.*NO_PROXY/);
  });
});

test("rejects README proxy guidance with a missing exact lowercase alias", () => {
  for (const relativePath of ["README.md", "README.zh-CN.md"]) {
    withFixture((root) => {
      const path = join(root, relativePath);
      writeFileSync(path, readFileSync(path, "utf8").replace("`https_proxy`", "lowercase HTTPS proxy"));
      assert.throws(
        () => checkDockerProxyContract(root),
        new RegExp(`${relativePath.replaceAll(".", "\\.")}.*https_proxy`),
      );
    });
  }
});

test("rejects README proxy guidance that omits the precedence rule", () => {
  withFixture((root) => {
    const path = join(root, "README.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "Do not set both forms; when both are present, Go uses the uppercase value.",
        "",
      ),
    );
    assert.throws(() => checkDockerProxyContract(root), /README\.md.*no-mixing precedence rule/);
  });
});
