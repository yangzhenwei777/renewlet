import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  redactedRequestBody,
  redactedRequestHeaders,
  redactedRequestTarget,
  upstreamTransportDiagnosticMessage,
} from "./upstream-http";

const sourceDir = dirname(fileURLToPath(import.meta.url));

describe("Cloudflare upstream HTTP boundary", () => {
  it("redacts request URLs while preserving diagnostic target shape", () => {
    const target = redactedRequestTarget(
      "https://discord.com/api/webhooks/123/discord-secret?wait=true&token=telegram-secret&thread_id=456",
      ["discord-secret", "telegram-secret"],
    );

    expect(target).toBe("https://discord.com/api/webhooks/123/[redacted]?wait=true&token=%5Bredacted%5D&thread_id=456");
    expect(target).not.toContain("discord-secret");
    expect(target).not.toContain("telegram-secret");
  });

  it("redacts sensitive headers and recursive JSON body fields", () => {
    const headers = redactedRequestHeaders({
      authorization: "Bearer sk-secret",
      "content-type": "application/json",
      "x-api-key": "sk-secret",
    }, ["sk-secret"]);
    const body = redactedRequestBody(JSON.stringify({
      model: "gpt-test",
      apiKey: "sk-secret",
      nested: {
        password: "pass-secret",
        note: "safe text",
      },
    }), ["sk-secret", "pass-secret"]);

    expect(headers).toBe("{\"authorization\":\"[redacted]\",\"content-type\":\"application/json\",\"x-api-key\":\"[redacted]\"}");
    expect(body).toBe("{\"model\":\"gpt-test\",\"apiKey\":\"[redacted]\",\"nested\":{\"password\":\"[redacted]\",\"note\":\"safe text\"}}");
  });

  it("includes provider, method, redacted target, phase, cause code and body summary for transport failures", () => {
    const error = Object.assign(new TypeError("fetch failed for https://api.example.com/v1/messages?api_key=sk-secret"), {
      cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
    });
    const message = upstreamTransportDiagnosticMessage(
      "https://api.example.com/v1/messages?api_key=sk-secret&debug=true",
      {
        method: "POST",
        headers: { authorization: "Bearer sk-secret", accept: "application/json" },
        body: JSON.stringify({ token: "sk-secret", content: "hello" }),
      },
      { provider: "AI Provider", secrets: ["sk-secret"] },
      error,
      10_000,
      false,
    );

    expect(message).toContain("AI Provider POST request to https://api.example.com/v1/messages?api_key=%5Bredacted%5D&debug=true failed before response headers");
    expect(message).toContain("(UND_ERR_CONNECT_TIMEOUT)");
    expect(message).toContain("\"authorization\":\"[redacted]\"");
    expect(message).toContain("\"token\":\"[redacted]\"");
    expect(message).toContain("\"content\":\"hello\"");
    expect(message).not.toContain("sk-secret");
  });

  it("keeps product upstream fetches behind upstream-http", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(sourceDir)) {
      if (file.endsWith(".test.ts")) continue;
      const name = basename(file);
      const source = readFileSync(file, "utf8");
      source.split(/\r?\n/).forEach((line, index) => {
        if (!/(^|[^.\w$])fetch\s*\(/.test(line)) return;
        if (name === "upstream-http.ts") return;
        if (name === "index.ts" && /^\s*(?:async\s+)?fetch\s*\(/.test(line)) return;
        if (name === "media-icon-index.ts" && line.includes("env.ASSETS.fetch(")) return;
        offenders.push(`${relative(sourceDir, file)}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...sourceFiles(path));
      continue;
    }
    if (entry.endsWith(".ts")) files.push(path);
  }
  return files;
}
