// Worker 云备份测试保护 D1 provider 级配置脱敏、远端 checksum 和 scheduled 锁三条跨运行面安全边界。
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { CloudBackupProvider, CloudBackupSnapshotManifest } from "@renewlet/shared/schemas/cloud-backup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCloudBackup,
  deleteCloudBackup,
  downloadCloudBackup,
  listCloudBackups,
  runDueCloudBackups,
  testCloudBackupConfig,
  updateCloudBackupConfig,
} from "./cloud-backup";
import { sanitizeSettingsForCloudBackup } from "./cloud-backup-sanitize";
import { CloudBackupRemoteError, sha256Hex, type CloudBackupRemoteClient } from "./cloud-backup-remote";
import { deleteCloudBackupFromTargets, type CloudBackupTarget } from "./cloud-backup-snapshot-resolve";
import { readSuccessData } from "./api-test-helpers";
import { HttpError } from "./http";
import type { CloudBackupTargetRow, Env, UserRow } from "./types";

const authUser = userRow();

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getCustomConfig: vi.fn(),
  getSettings: vi.fn(),
  listSubscriptions: vi.fn(),
  nowIso: vi.fn(),
  toApiSubscription: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getAsset: dbMocks.getAsset,
    getCustomConfig: dbMocks.getCustomConfig,
    getSettings: dbMocks.getSettings,
    listSubscriptions: dbMocks.listSubscriptions,
    nowIso: dbMocks.nowIso,
    toApiSubscription: dbMocks.toApiSubscription,
  };
});

type FakeD1Query = {
  sql: string;
  params: unknown[];
  method: "all" | "first" | "run";
};

function fakeEnv(handler: (query: FakeD1Query) => unknown | Promise<unknown>): Env {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              all: async () => await handler({ sql, params, method: "all" }),
              first: async () => await handler({ sql, params, method: "first" }),
              run: async () => await handler({ sql, params, method: "run" }),
            } as D1PreparedStatement;
          },
        } as D1PreparedStatement;
      },
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  } as Env;
}

function fakeEnvForRows(rows: CloudBackupTargetRow[], onQuery?: (query: FakeD1Query) => D1Result | undefined): Env {
  return fakeEnv((query) => {
    const override = onQuery?.(query);
    if (override) return override;
    const { sql, params, method } = query;
    if (method === "all" && sql.includes("FROM cloud_backup_targets") && sql.includes("schedule_enabled = 1")) {
      return d1All(rows.filter((row) => row.schedule_enabled === 1));
    }
    if (method === "all" && sql.includes("FROM cloud_backup_targets") && sql.includes("WHERE user_id = ?")) {
      return d1All(rows.filter((row) => row.user_id === String(params[0])).sort((left, right) => right.updated_at.localeCompare(left.updated_at)));
    }
    if (method === "all" && sql.includes("FROM exchange_rate_snapshots")) return d1All([]);
    if (method === "first" && sql.includes("FROM cloud_backup_targets")) {
      return rows.find((row) => row.user_id === String(params[0]) && row.provider === params[1]) ?? null;
    }
    if (method === "first" && sql.includes("FROM users")) return authUser;
    if (method === "run" && sql.includes("INSERT INTO cloud_backup_targets")) {
      upsertTargetRow(rows, params);
      return d1Run(1);
    }
    if (method === "run" && sql.includes("SET locked_until")) return d1Run(1);
    if (method === "run" && sql.includes("SET last_backup_at")) return d1Run(1);
    if (method === "run" && sql.includes("SET next_run_at_utc")) return d1Run(1);
    if (method === "run" && sql.includes("SET last_status")) return d1Run(1);
    throw new Error(`unexpected ${method} query: ${sql}`);
  });
}

function d1All<T>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function d1Run(changes = 0): D1Result {
  return { results: [], success: true, meta: { changes } } as unknown as D1Result;
}

function authorizedRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`https://renewlet.test${path}`, {
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
      "x-renewlet-locale": "en-US",
      ...init.headers,
    },
    ...init,
  });
}

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "usr_cloud",
    email: "cloud@example.com",
    name: "Cloud User",
    role: "admin",
    banned: 0,
    ban_reason: "",
    password_hash: "hash",
    reset_token_hash: null,
    reset_token_expires_at: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function cloudBackupRow(provider: "webdav" | "s3", overrides: Partial<CloudBackupTargetRow> = {}): CloudBackupTargetRow {
  return {
    user_id: "usr_cloud",
    provider,
    config_json: JSON.stringify(provider === "webdav"
      ? {
          webdav: {
            url: "https://dav.example.com/remote.php/dav/files/alice",
            username: "alice",
            path: "renewlet",
          },
        }
      : {
          s3: {
            endpoint: "https://r2.example.com",
            region: "auto",
            bucket: "renewlet",
            prefix: "snapshots",
            accessKeyId: "access-key",
          },
        }),
    credential_json: JSON.stringify(provider === "webdav" ? { webdavPassword: "saved-secret" } : { s3SecretAccessKey: "secret-key" }),
    schedule_enabled: 0,
    schedule_frequency: "daily",
    schedule_time: "03:00",
    schedule_weekday: "monday",
    retention: 7,
    last_backup_at: null,
    last_status: "idle",
    last_error: null,
    locked_until: null,
    next_run_at_utc: null,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function s3CloudBackupRow(overrides: Partial<{
  endpoint: string;
  bucket: string;
}> = {}): CloudBackupTargetRow {
  return cloudBackupRow("s3", {
    config_json: JSON.stringify({
      s3: {
        endpoint: overrides.endpoint ?? "https://r2.example.com",
        region: "auto",
        bucket: overrides.bucket ?? "renewlet",
        prefix: "snapshots",
        accessKeyId: "access-key",
      },
    }),
  });
}

function upsertTargetRow(rows: CloudBackupTargetRow[], params: unknown[]) {
  const userId = String(params[0]);
  const provider = params[1] as "webdav" | "s3";
  const index = rows.findIndex((row) => row.user_id === userId && row.provider === provider);
  const previous = index >= 0 ? rows[index]! : cloudBackupRow(provider, { user_id: userId });
  const next: CloudBackupTargetRow = {
    ...previous,
    user_id: userId,
    provider,
    config_json: String(params[2]),
    credential_json: String(params[3]),
    schedule_enabled: Number(params[4]),
    schedule_frequency: params[5] as "daily" | "weekly",
    schedule_time: String(params[6]),
    schedule_weekday: params[7] as CloudBackupTargetRow["schedule_weekday"],
    retention: Number(params[8]),
    next_run_at_utc: params[9] === null ? null : String(params[9]),
    last_status: previous.last_status || "idle",
    last_error: previous.last_error,
    created_at: previous.created_at || String(params[10]),
    updated_at: String(params[11]),
  };
  if (index >= 0) rows[index] = next;
  else rows.push(next);
}

function cloudBackupManifestForTest(id: string, content: Uint8Array, sha256: string): CloudBackupSnapshotManifest {
  return {
    kind: "renewlet-cloud-backup-snapshot",
    schemaVersion: 1,
    id,
    filename: `${id}.zip`,
    createdAt: "2026-06-09T00:00:00.000Z",
    sizeBytes: content.length,
    sha256,
    exportKind: "renewlet-export",
    exportSchemaVersion: 1,
  };
}

function fakeCloudBackupTarget(provider: CloudBackupProvider, manifests: CloudBackupSnapshotManifest[], deletedProviders: CloudBackupProvider[]): CloudBackupTarget {
  const client: CloudBackupRemoteClient = {
    test: async () => undefined,
    list: async () => manifests,
    upload: async () => undefined,
    download: async () => {
      throw new CloudBackupRemoteError("CLOUD_BACKUP_DOWNLOAD_FAILED", {
        rawResponseText: "not implemented",
      });
    },
    delete: async () => {
      deletedProviders.push(provider);
    },
  };
  return { provider, client };
}

function fetchCallFromArgs(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  return {
    href: input instanceof URL ? input.toString() : request?.url ?? String(input),
    method: init?.method ?? request?.method ?? "GET",
    headers: new Headers(init?.headers ?? request?.headers),
  };
}

function stubRemoteSuccessFetch(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const { href, method } = fetchCallFromArgs(url, init);
    calls.push(`${method} ${href}`);
    if (method === "MKCOL") return new Response("", { status: 201 });
    if (method === "PROPFIND") return new Response(emptyWebDAVMultiStatus(), { status: 207 });
    if (href.includes("list-type=2")) return new Response(`<?xml version="1.0"?><ListBucketResult></ListBucketResult>`, { status: 200 });
    if (method === "HEAD") return new Response(null, { status: 200 });
    return new Response("", { status: 200 });
  }));
  return calls;
}

// WebDAV SDK 会解析 PROPFIND 结构而不是正则捞 href；成功 fixture 必须像真实服务一样返回 collection propstat。
function emptyWebDAVMultiStatus(): string {
  return `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/alice/renewlet/</d:href><d:propstat><d:prop><d:displayname>renewlet</d:displayname><d:resourcetype><d:collection/></d:resourcetype><d:getcontentlength>0</d:getcontentlength><d:getlastmodified>Wed, 10 Jun 2026 00:00:00 GMT</d:getlastmodified></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;
}

beforeEach(() => {
  authMocks.requireAuth.mockReset().mockResolvedValue({ user: authUser, session: { id: "ses" } });
  dbMocks.getAsset.mockReset().mockResolvedValue(null);
  dbMocks.getCustomConfig.mockReset().mockResolvedValue({ categories: [], statuses: [], paymentMethods: [], currencies: [] });
  dbMocks.getSettings.mockReset().mockResolvedValue(createDefaultAppSettings());
  dbMocks.listSubscriptions.mockReset().mockResolvedValue([]);
  dbMocks.nowIso.mockReset().mockReturnValue("2026-06-09T00:00:00.000Z");
  dbMocks.toApiSubscription.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Cloudflare cloud backup", () => {
  it("stores credentials write-only and returns only credentialSet", async () => {
    const rows: CloudBackupTargetRow[] = [];
    const env = fakeEnvForRows(rows);

    const response = await updateCloudBackupConfig(authorizedRequest("/api/app/cloud-backup/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "webdav",
        webdav: {
          url: "https://dav.example.com/remote.php/dav/files/alice",
          username: "alice",
          path: "renewlet",
        },
        credentials: { webdavPassword: "plain-secret" },
        policy: {
          scheduleEnabled: true,
          scheduleFrequency: "daily",
          scheduleTime: "02:15",
          scheduleWeekday: "monday",
          retention: 7,
        },
      }),
    }), env);
    const body = await readSuccessData<{ config: Record<string, unknown> }>(response);

    expect(rows[0]?.credential_json).toContain("plain-secret");
    expect(rows[0]?.schedule_time).toBe("02:15");
    expect(body.config["credentialSet"]).toBe(true);
    expect(body.config["credentialSetByProvider"]).toEqual({ webdav: true, s3: false });
    expect(JSON.stringify(body)).not.toContain("plain-secret");
    expect(body.config).not.toHaveProperty("credentials");
  });

  it("saves WebDAV and S3 target policies without clearing the other provider", async () => {
    const rows: CloudBackupTargetRow[] = [];
    const env = fakeEnvForRows(rows);

    await updateCloudBackupConfig(authorizedRequest("/api/app/cloud-backup/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "webdav",
        webdav: {
          url: "https://dav.example.com/remote.php/dav/files/alice",
          username: "alice",
          path: "renewlet",
        },
        credentials: { webdavPassword: "webdav-secret" },
        policy: {
          scheduleEnabled: true,
          scheduleFrequency: "daily",
          scheduleTime: "02:15",
          scheduleWeekday: "monday",
          retention: 5,
        },
      }),
    }), env);
    const response = await updateCloudBackupConfig(authorizedRequest("/api/app/cloud-backup/config", {
      method: "PUT",
      body: JSON.stringify({
        provider: "s3",
        s3: {
          endpoint: "https://r2.example.com",
          region: "auto",
          bucket: "renewlet",
          prefix: "snapshots",
          accessKeyId: "access",
        },
        credentials: { webdavPassword: "ignored-webdav-secret", s3SecretAccessKey: "s3-secret" },
        policy: {
          scheduleEnabled: true,
          scheduleFrequency: "weekly",
          scheduleTime: "04:30",
          scheduleWeekday: "friday",
          retention: 9,
        },
      }),
    }), env);
    const body = await readSuccessData<{
      config: {
        credentialSetByProvider: unknown;
        s3?: Record<string, unknown>;
        policyByProvider: Record<"webdav" | "s3", { scheduleTime: string; scheduleWeekday: string; retention: number }>;
      };
    }>(response);

    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.provider === "webdav")?.credential_json).toContain("webdav-secret");
    expect(rows.find((row) => row.provider === "s3")?.credential_json).toContain("s3-secret");
    expect(JSON.stringify(rows.find((row) => row.provider === "s3"))).not.toContain("ignored-webdav-secret");
    expect(body.config.credentialSetByProvider).toEqual({ webdav: true, s3: true });
    expect(body.config.s3).not.toHaveProperty("addressingStyle");
    expect(body.config.policyByProvider.webdav).toMatchObject({ scheduleTime: "02:15", retention: 5 });
    expect(body.config.policyByProvider.s3).toMatchObject({ scheduleTime: "04:30", scheduleWeekday: "friday", retention: 9 });
  });

  it("creates manual snapshots only for the requested provider", async () => {
    const rows = [cloudBackupRow("webdav"), s3CloudBackupRow()];
    const env = fakeEnvForRows(rows);
    const calls = stubRemoteSuccessFetch();

    const response = await createCloudBackup(authorizedRequest("/api/app/cloud-backups", {
      method: "POST",
      body: JSON.stringify({ provider: "s3" }),
    }), env);
    const body = await readSuccessData<{ snapshots: Array<{ provider: string }> }>(response);

    expect(response.status).toBe(201);
    expect(body.snapshots.map((snapshot) => snapshot.provider)).toEqual(["s3"]);
    expect(calls.some((call) => call.includes("r2.example.com"))).toBe(true);
    expect(calls.some((call) => call.includes("dav.example.com"))).toBe(false);
  });

  it("strips external notification secrets from cloud backup settings", () => {
    const sanitized = sanitizeSettingsForCloudBackup({
      ...createDefaultAppSettings(),
      discordWebhookUrl: "https://discord.com/api/webhooks/123/secret",
      discordBotUsername: "Renewlet",
      discordBotAvatarUrl: "https://cdn.example.com/avatar.png",
      pushplusToken: "push-token",
      dingtalkWebhookUrl: "https://oapi.dingtalk.com/robot/send?access_token=ding-token",
      dingtalkSecret: "SECsecret",
      dingtalkKeyword: "自定义关键词",
      dingtalkTitleTemplate: "自定义标题",
      dingtalkContentTemplate: "自定义正文",
    });

    expect(sanitized).not.toHaveProperty("discordWebhookUrl");
    expect(sanitized).not.toHaveProperty("discordBotUsername");
    expect(sanitized).not.toHaveProperty("discordBotAvatarUrl");
    expect(sanitized).not.toHaveProperty("pushplusToken");
    expect(sanitized).not.toHaveProperty("dingtalkWebhookUrl");
    expect(sanitized).not.toHaveProperty("dingtalkSecret");
    expect(sanitized).not.toHaveProperty("dingtalkKeyword");
    expect(sanitized).not.toHaveProperty("dingtalkTitleTemplate");
    expect(sanitized).not.toHaveProperty("dingtalkContentTemplate");
    expect(JSON.stringify(sanitized)).not.toContain("secret");
    expect(JSON.stringify(sanitized)).not.toContain("push-token");
    expect(JSON.stringify(sanitized)).not.toContain("ding-token");
    expect(JSON.stringify(sanitized)).not.toContain("SECsecret");
    expect(JSON.stringify(sanitized)).not.toContain("自定义标题");
    expect(JSON.stringify(sanitized)).not.toContain("自定义正文");
  });

  it("returns a cloud backup provider error when manual snapshot provider is missing", async () => {
    const env = fakeEnvForRows([cloudBackupRow("webdav")]);

    await expect(createCloudBackup(authorizedRequest("/api/app/cloud-backups", {
      method: "POST",
      body: JSON.stringify({}),
    }), env)).rejects.toMatchObject({
      status: 400,
      code: "CLOUD_BACKUP_PROVIDER_INVALID",
      details: {
        rawResponseText: expect.stringContaining("\"provider\":\"webdav\""),
      },
    });
  });

  it("rejects downloaded snapshots when the sidecar checksum does not match", async () => {
    const env = fakeEnvForRows([cloudBackupRow("webdav")]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href } = fetchCallFromArgs(url, init);
      if (href.endsWith(".manifest.json")) {
        return new Response(JSON.stringify({
          kind: "renewlet-cloud-backup-snapshot",
          schemaVersion: 1,
          id: "renewlet-export-v1-20260609T000000Z-abcd1234",
          filename: "renewlet-export-v1-20260609T000000Z-abcd1234.zip",
          createdAt: "2026-06-09T00:00:00.000Z",
          sizeBytes: 4,
          sha256: "a".repeat(64),
          exportKind: "renewlet-export",
          exportSchemaVersion: 1,
        }), { status: 200 });
      }
      if (href.endsWith(".zip")) return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
      return new Response("not found", { status: 404 });
    }));

    await expect(downloadCloudBackup(
      authorizedRequest("/api/app/cloud-backups/renewlet-export-v1-20260609T000000Z-abcd1234/download?provider=webdav"),
      env,
      "renewlet-export-v1-20260609T000000Z-abcd1234",
    )).rejects.toMatchObject({
      code: "CLOUD_BACKUP_CHECKSUM_FAILED",
    });
  });

  it("downloads without provider by trying configured targets and returning the first valid snapshot", async () => {
    const id = "renewlet-export-v1-20260609T111742Z-fcf646df";
    const content = new Uint8Array([1, 2, 3, 4]);
    const manifest = cloudBackupManifestForTest(id, content, await sha256Hex(content));
    const env = fakeEnvForRows([cloudBackupRow("webdav"), s3CloudBackupRow()]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href } = fetchCallFromArgs(url, init);
      if (href.includes("dav.example.com")) {
        return new Response("<d:error>missing</d:error>", { status: 404, statusText: "Not Found", headers: { "content-type": "application/xml" } });
      }
      if (href.includes(".manifest.json") || href.endsWith(encodeURIComponent(`${id}.manifest.json`))) {
        return new Response(JSON.stringify(manifest), { status: 200 });
      }
      if (href.includes(".zip")) return new Response(content, { status: 200 });
      return new Response("unexpected", { status: 500 });
    }));

    const response = await downloadCloudBackup(
      authorizedRequest(`/api/app/cloud-backups/${id}/download`),
      env,
      id,
    );

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
  });

  it("returns all provider attempts when download without provider fails", async () => {
    const id = "renewlet-export-v1-20260609T111742Z-fcf646df";
    const env = fakeEnvForRows([cloudBackupRow("webdav"), s3CloudBackupRow()]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href } = fetchCallFromArgs(url, init);
      if (href.includes("dav.example.com")) {
        return new Response("<d:error>missing</d:error>", { status: 404, statusText: "Not Found", headers: { "content-type": "application/xml" } });
      }
      return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403, statusText: "Forbidden", headers: { "content-type": "application/xml" } });
    }));

    let error: HttpError | null = null;
    try {
      await downloadCloudBackup(authorizedRequest(`/api/app/cloud-backups/${id}/download`), env, id);
    } catch (caught) {
      error = caught as HttpError;
    }

    expect(error).toMatchObject({
      status: 400,
      code: "CLOUD_BACKUP_DOWNLOAD_FAILED",
      details: {
        rawResponseText: expect.stringContaining("webdav: CLOUD_BACKUP_WEBDAV_NOT_FOUND"),
      },
    } satisfies Partial<HttpError>);
    const rawResponseText = (error?.details as { rawResponseText?: string } | undefined)?.rawResponseText ?? "";
    expect(rawResponseText).toContain("s3: CLOUD_BACKUP_S3_GET_FAILED");
    expect(JSON.stringify(error?.details)).toContain("AccessDenied");
  });

  it("returns structured details for an invalid explicit provider", async () => {
    const id = "renewlet-export-v1-20260609T111742Z-fcf646df";
    const env = fakeEnvForRows([]);

    await expect(downloadCloudBackup(
      authorizedRequest(`/api/app/cloud-backups/${id}/download?provider=dropbox`),
      env,
      id,
    )).rejects.toMatchObject({
      status: 400,
      code: "CLOUD_BACKUP_PROVIDER_INVALID",
      details: {
        rawResponseText: "Use provider=webdav or provider=s3.",
      },
    });
  });

  it("requires provider for delete without provider when the snapshot exists in multiple targets", async () => {
    const id = "renewlet-export-v1-20260609T111742Z-fcf646df";
    const content = new Uint8Array([1, 2, 3, 4]);
    const manifest = cloudBackupManifestForTest(id, content, await sha256Hex(content));
    const deletedProviders: CloudBackupProvider[] = [];
    const targets = [
      fakeCloudBackupTarget("webdav", [manifest], deletedProviders),
      fakeCloudBackupTarget("s3", [manifest], deletedProviders),
    ];

    let error: CloudBackupRemoteError | null = null;
    try {
      await deleteCloudBackupFromTargets(targets, id);
    } catch (caught) {
      if (caught instanceof CloudBackupRemoteError) error = caught;
      else throw caught;
    }
    expect(error).toMatchObject({
      code: "CLOUD_BACKUP_PROVIDER_REQUIRED",
      details: {
        rawResponseText: expect.stringContaining("Snapshot may exist in multiple cloud backup targets."),
      },
    } satisfies Partial<CloudBackupRemoteError>);
    expect(deletedProviders).toEqual([]);
  });

  it("requires provider when listing snapshots", async () => {
    const env = fakeEnvForRows([cloudBackupRow("webdav"), s3CloudBackupRow()]);

    let error: HttpError | null = null;
    try {
      await listCloudBackups(authorizedRequest("/api/app/cloud-backups"), env);
    } catch (caught) {
      error = caught as HttpError;
    }

    expect(error).toMatchObject({
      status: 400,
      code: "CLOUD_BACKUP_PROVIDER_REQUIRED",
      details: {
        rawResponseText: "Use provider=webdav or provider=s3.",
      },
    } satisfies Partial<HttpError>);
  });

  it("lists snapshots only for the requested provider", async () => {
    const env = fakeEnvForRows([cloudBackupRow("webdav"), s3CloudBackupRow()]);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { href, method } = fetchCallFromArgs(url, init);
      calls.push(`${method} ${href}`);
      if (href.includes("dav.example.com")) {
        if (method === "MKCOL") return new Response("", { status: 201 });
        if (method === "PROPFIND") return new Response(emptyWebDAVMultiStatus(), { status: 207 });
      }
      return new Response(`<Error><Code>AccessDenied</Code></Error>`, { status: 403, statusText: "Forbidden" });
    }));

    const response = await listCloudBackups(authorizedRequest("/api/app/cloud-backups?provider=webdav"), env);
    const body = await readSuccessData<{ snapshots: unknown[] }>(response);

    expect(response.status).toBe(200);
    expect(body.snapshots).toEqual([]);
    expect(calls.some((call) => call.includes("dav.example.com"))).toBe(true);
    expect(calls.some((call) => call.includes("r2.example.com"))).toBe(false);
  });

  it("returns upstream S3 response details when listing requested S3 snapshots fails", async () => {
    const env = fakeEnvForRows([s3CloudBackupRow()]);
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const { headers, href } = fetchCallFromArgs(url, init);
      expect(headers.get("authorization")).toBeNull();
      expect(new URL(href).searchParams.get("X-Amz-Signature")).toBeTruthy();
      return new Response(`<Error><Code>AccessDenied</Code><Message>access-key secret-key missing list permission</Message></Error>`, {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "content-type": "application/xml",
          authorization: "should-not-echo",
          "set-cookie": "session=secret-key",
          "x-amz-security-token": "secret-key",
        },
      });
    }));

    let error: HttpError | null = null;
    try {
      await listCloudBackups(authorizedRequest("/api/app/cloud-backups?provider=s3"), env);
    } catch (caught) {
      error = caught as HttpError;
    }

    expect(error).toMatchObject({
      status: 400,
      code: "CLOUD_BACKUP_LIST_FAILED",
      details: {
        rawResponseText: expect.stringContaining("AccessDenied"),
      },
    } satisfies Partial<HttpError>);
    expect(JSON.stringify(error?.details)).not.toContain("access-key");
    expect(JSON.stringify(error?.details)).not.toContain("secret-key");
    expect(JSON.stringify(error?.details)).not.toContain("should-not-echo");
    expect(JSON.stringify(error?.details)).not.toContain("X-Amz-Signature");
  });

  it("returns local SDK raw details when S3 test fails before an upstream response exists", async () => {
    const env = fakeEnvForRows([]);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new RangeError("Value out of range. Must be between -2147483648 and 2147483647 (inclusive).");
    }));

    let error: HttpError | null = null;
    try {
      await testCloudBackupConfig(authorizedRequest("/api/app/cloud-backup/test", {
        method: "POST",
        body: JSON.stringify({
          provider: "s3",
          s3: {
            endpoint: "https://storage.example.com",
            region: "us-east-1",
            bucket: "renewlet",
            prefix: "snapshots",
            accessKeyId: "access-key",
          },
          credentials: { s3SecretAccessKey: "secret-key" },
          policy: {
            scheduleEnabled: false,
            scheduleFrequency: "daily",
            scheduleTime: "03:00",
            scheduleWeekday: "monday",
            retention: 7,
          },
        }),
      }), env);
    } catch (caught) {
      error = caught as HttpError;
    }

    expect(error).toMatchObject({
      status: 400,
      code: "CLOUD_BACKUP_TEST_FAILED",
      details: {
        rawResponseText: expect.stringContaining("Value out of range"),
      },
    } satisfies Partial<HttpError>);
    const details = error?.details as { rawResponseText?: string | null } | undefined;
    expect(details?.rawResponseText).toContain("S3");
    expect(details?.rawResponseText).toContain("https://renewlet.storage.example.com/");
    expect(JSON.stringify(error?.details)).not.toContain("secret-key");
    expect(JSON.stringify(error?.details)).not.toContain("X-Amz-Signature");
  });

  it("rejects S3 test payloads without a signing region before remote access", async () => {
    const env = fakeEnvForRows([]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(testCloudBackupConfig(authorizedRequest("/api/app/cloud-backup/test", {
      method: "POST",
      body: JSON.stringify({
        provider: "s3",
        s3: {
          endpoint: "https://storage.example.com",
          region: "",
          bucket: "renewlet",
          prefix: "snapshots",
          accessKeyId: "access-key",
        },
        credentials: { s3SecretAccessKey: "secret-key" },
        policy: {
          scheduleEnabled: false,
          scheduleFrequency: "daily",
          scheduleTime: "03:00",
          scheduleWeekday: "monday",
          retention: 7,
        },
      }),
    }), env)).rejects.toMatchObject({
      status: 400,
      code: "INVALID_PAYLOAD",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs due scheduled backups independently per provider while building one ZIP per user", async () => {
    const rows: CloudBackupTargetRow[] = [
      cloudBackupRow("webdav", {
        schedule_enabled: 1,
        schedule_time: "03:00",
        last_backup_at: "2026-06-08T00:00:00.000Z",
      }),
      {
        ...s3CloudBackupRow(),
        schedule_enabled: 1,
        schedule_frequency: "weekly",
        schedule_time: "03:00",
        schedule_weekday: "wednesday",
        last_backup_at: "2026-06-02T19:00:00.000Z",
      },
    ];
    let lockUpdates = 0;
    let successUpdates = 0;
    const env = fakeEnvForRows(rows, ({ sql, method }) => {
      if (method === "run" && sql.includes("SET locked_until")) {
        lockUpdates += 1;
        return d1Run(1);
      }
      if (method === "run" && sql.includes("SET last_backup_at")) {
        successUpdates += 1;
        return d1Run(1);
      }
      return undefined;
    });
    const calls = stubRemoteSuccessFetch();
    dbMocks.getSettings.mockResolvedValue({ ...createDefaultAppSettings(), timezone: "Asia/Shanghai" });

    await runDueCloudBackups(env, new Date("2026-06-10T19:01:00.000Z"));

    expect(lockUpdates).toBe(2);
    expect(successUpdates).toBe(2);
    expect(dbMocks.listSubscriptions).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.startsWith("PUT "))).toHaveLength(4);
    expect(calls.some((call) => call.includes("dav.example.com"))).toBe(true);
    expect(calls.some((call) => call.includes("r2.example.com"))).toBe(true);
  });
});
