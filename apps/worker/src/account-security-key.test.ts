// Worker 账号安全密钥测试保护 R2 条件写、isolate 缓存和损坏 fail closed，不让登录热路径退化成每次远程读。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountSecurityKeyRing, resetAccountSecurityKeyRingForTest } from "./account-security-key";
import type { Env } from "./types";

describe("Cloudflare account security key ring", () => {
  beforeEach(() => {
    resetAccountSecurityKeyRingForTest();
  });

  it("creates the installation key in R2 and caches the derived key ring", async () => {
    const bucket = createR2Bucket();
    const env = envFixture(bucket);

    await accountSecurityKeyRing(env);
    await accountSecurityKeyRing(env);

    expect(bucket.get).toHaveBeenCalledTimes(1);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.objects.size).toBe(1);
  });

  it("reads the winner object when the first conditional R2 put loses a race", async () => {
    const key = storedKeyJSON(7);
    const bucket = createR2Bucket({
      failFirstPutWith: key,
    });
    const env = envFixture(bucket);

    await accountSecurityKeyRing(env);

    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.get).toHaveBeenCalledTimes(2);
    expect(bucket.objects.get("system/account-security/key.v1.json")).toBe(key);
  });

  it("fails closed when the stored key object is malformed", async () => {
    const bucket = createR2Bucket({
      initial: "{\"version\":1,\"key\":\"bad\"}\n",
    });
    const env = envFixture(bucket);

    await expect(accountSecurityKeyRing(env)).rejects.toThrow("invalid account security key");
  });
});

function envFixture(bucket: ReturnType<typeof createR2Bucket>): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: bucket as unknown as R2Bucket,
  };
}

function createR2Bucket(options: { initial?: string; failFirstPutWith?: string } = {}) {
  const objects = new Map<string, string>();
  if (options.initial) objects.set("system/account-security/key.v1.json", options.initial);
  let putCalls = 0;
  return {
    objects,
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      return body ? r2Object(body) : null;
    }),
    put: vi.fn(async (key: string, value: string) => {
      putCalls += 1;
      if (putCalls === 1 && options.failFirstPutWith) {
        objects.set(key, options.failFirstPutWith);
        return null;
      }
      objects.set(key, value);
      return { key };
    }),
  };
}

function r2Object(body: string): Pick<R2ObjectBody, "arrayBuffer"> {
  return {
    arrayBuffer: vi.fn(async () => {
      const bytes = textEncoder.encode(body);
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }),
  };
}

function storedKeyJSON(seed: number): string {
  return `${JSON.stringify({ version: 1, key: base64Url(new Uint8Array(32).fill(seed)) })}\n`;
}

function base64Url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

const textEncoder = new TextEncoder();
