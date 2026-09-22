// Worker 系统更新测试保护 Cloudflare 只读升级契约，避免前端误暴露 Docker 页面内更新入口。
import rootPackageJson from "../../../package.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { systemRestart, systemUpdate, systemUpdateStatus, systemVersion } from "./system";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({
  role: "admin" as "admin" | "user",
}));

vi.mock("./auth", () => ({
  requireAuth: vi.fn(async () => ({
    user: { id: "usr_current", email: "current@example.com", name: "Current", role: authMocks.role, banned: 0 },
    session: { id: "ses_current" },
  })),
  requireAdmin: vi.fn(async () => {
    if (authMocks.role !== "admin") {
      throw Object.assign(new Error("Administrator permission required"), { status: 403 });
    }
    return {
      user: { id: "usr_admin", email: "admin@example.com", name: "Admin", role: "admin", banned: 0 },
      session: { id: "ses_admin" },
    };
  }),
}));

describe("Cloudflare system update contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    authMocks.role = "admin";
  });

  it("returns deploy-only version capability", async () => {
    const fetchMock = mockLatestRelease("1.2.3");

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), envFixture());

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      checkSucceeded: true,
      hasUpdate: false,
      build: {
        version: "1.2.3",
        commit: "504c1681822ac60f0caafdb0b1ba731853c9169d",
        buildType: "cloudflare",
      },
    });
    expect(body["releaseInfo"]).toMatchObject({
      tagName: "v1.2.3",
      version: "1.2.3",
      htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.2.3",
      assets: [],
    });
    expect(body).not.toHaveProperty("runtime");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://github.com/zhiyingzzhou/renewlet/releases.atom");
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get("accept")).toBe("application/atom+xml");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-github-api-version")).toBeNull();
  });

  it("treats deploy button builds without metadata as the package stable version", async () => {
    mockLatestRelease(rootPackageJson.version);

    const env = envFixture();
    delete env.RENEWLET_VERSION;
    delete env.RENEWLET_COMMIT;

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: rootPackageJson.version,
      latestVersion: rootPackageJson.version,
      checkSucceeded: true,
      hasUpdate: false,
      deployment: "cloudflare",
      build: {
        version: rootPackageJson.version,
        commit: "",
        buildType: "cloudflare",
      },
    });
    expect(body["releaseInfo"]).toMatchObject({
      tagName: `v${rootPackageJson.version}`,
      version: rootPackageJson.version,
    });
  });

  it("does not expose placeholder dev versions to deploy button users", async () => {
    mockLatestRelease(rootPackageJson.version);

    const env = envFixture({
      RENEWLET_VERSION: "0.0.0-dev",
      RENEWLET_COMMIT: "504c1681822ac60f0caafdb0b1ba731853c9169d",
    });

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: rootPackageJson.version,
      latestVersion: rootPackageJson.version,
      checkSucceeded: true,
      hasUpdate: false,
      deployment: "cloudflare",
      build: {
        version: rootPackageJson.version,
        commit: "504c1681822ac60f0caafdb0b1ba731853c9169d",
        buildType: "cloudflare",
      },
    });
    expect(String(body["currentVersion"])).not.toContain("-dev");
  });

  it("falls back to the stable package version when dev suffixes lack commit metadata", async () => {
    mockLatestRelease(rootPackageJson.version);

    const env = envFixture({
      RENEWLET_VERSION: `${rootPackageJson.version}-dev`,
      RENEWLET_COMMIT: "",
    });

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: rootPackageJson.version,
      latestVersion: rootPackageJson.version,
      checkSucceeded: true,
      hasUpdate: false,
      deployment: "cloudflare",
      build: {
        version: rootPackageJson.version,
        commit: "",
        buildType: "cloudflare",
      },
    });
  });

  it("keeps explicit branch deploy versions with commit metadata", async () => {
    mockLatestRelease(rootPackageJson.version);

    const env = envFixture({
      RENEWLET_VERSION: `${rootPackageJson.version}-dev+504c168`,
      RENEWLET_COMMIT: "504c1681822ac60f0caafdb0b1ba731853c9169d",
    });

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    const expectedVersion = `${rootPackageJson.version}-dev+504c168`;
    expect(body).toMatchObject({
      currentVersion: expectedVersion,
      latestVersion: rootPackageJson.version,
      checkSucceeded: true,
      hasUpdate: false,
      deployment: "cloudflare",
      releaseInfo: null,
      build: {
        version: expectedVersion,
        commit: "504c1681822ac60f0caafdb0b1ba731853c9169d",
        buildType: "cloudflare",
      },
    });
  });

  it("reports a newer stable release without enabling executable updates", async () => {
    mockLatestRelease("0.1.1");
    const env = envFixture({
      RENEWLET_VERSION: "0.1.0-dev+d0059b5",
      RENEWLET_COMMIT: "d0059b51822ac60f0caafdb0b1ba731853c9169d",
    });

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: "0.1.0-dev+d0059b5",
      latestVersion: "0.1.1",
      checkSucceeded: true,
      hasUpdate: true,
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      releaseInfo: {
        tagName: "v0.1.1",
        version: "0.1.1",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.1.1",
      },
    });
  });

  it("reports hotfix patch stable releases as newer deploy-only updates", async () => {
    mockLatestRelease("0.2.91");

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), envFixture({ RENEWLET_VERSION: "0.2.9" }));

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: "0.2.9",
      latestVersion: "0.2.91",
      checkSucceeded: true,
      hasUpdate: true,
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      releaseInfo: {
        tagName: "v0.2.91",
        version: "0.2.91",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v0.2.91",
      },
    });
  });

  it("skips release candidates from the Atom feed when selecting the stable target", async () => {
    mockReleaseFeed(["1.3.0-rc.1", "1.2.3"]);

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), envFixture({ RENEWLET_VERSION: "1.2.2" }));

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: "1.2.2",
      latestVersion: "1.2.3",
      checkSucceeded: true,
      hasUpdate: true,
      releaseInfo: {
        tagName: "v1.2.3",
        version: "1.2.3",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.2.3",
      },
    });
  });

  it("keeps the dialog usable when GitHub release checks fail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("release feed unavailable", { status: 403 })));

    const env = envFixture();
    delete env.RENEWLET_VERSION;
    delete env.RENEWLET_COMMIT;

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      currentVersion: rootPackageJson.version,
      latestVersion: rootPackageJson.version,
      checkSucceeded: false,
      hasUpdate: false,
      deployment: "cloudflare",
      releaseInfo: null,
      warning: "GitHub Releases cannot be fetched right now. Try again later.",
      build: {
        version: rootPackageJson.version,
        commit: "",
        buildType: "cloudflare",
      },
      errorDetails: {
        rawResponseText: "release feed unavailable",
      },
    });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("authorization");
  });

  it("lets non-admin users read versions without raw upstream details", async () => {
    authMocks.role = "user";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("release feed unavailable", { status: 403 })));

    const response = await systemVersion(new Request("https://renewlet.example/api/app/system/version", {
      headers: { "accept-language": "en-US" },
    }), envFixture());

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      checkSucceeded: false,
      hasUpdate: false,
      warning: "GitHub Releases cannot be fetched right now. Try again later.",
    });
    expect(body).not.toHaveProperty("errorDetails");
  });

  it("rejects executable updates in the Worker runtime", async () => {
    await expect(systemUpdate(new Request("https://renewlet.example/api/app/admin/system/update", {
      headers: { "accept-language": "en-US" },
      method: "POST",
    }), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "SYSTEM_UPDATE_UNSUPPORTED",
    });
  });

  it("returns an empty update task for the shared status protocol", async () => {
    const response = await systemUpdateStatus(new Request("https://renewlet.example/api/app/admin/system/update/status"), envFixture());
    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toEqual({ operation: null });
  });

  it("rejects executable restarts in the Worker runtime with a restart-specific code", async () => {
    await expect(systemRestart(new Request("https://renewlet.example/api/app/admin/system/restart", {
      headers: { "accept-language": "en-US" },
      method: "POST",
    }), envFixture())).rejects.toMatchObject({
      status: 400,
      code: "SYSTEM_RESTART_UNSUPPORTED",
    });
  });

  it("keeps executable system actions admin-only", async () => {
    authMocks.role = "user";

    await expect(systemUpdate(new Request("https://renewlet.example/api/app/admin/system/update", {
      method: "POST",
    }), envFixture())).rejects.toMatchObject({ status: 403 });
    await expect(systemUpdateStatus(new Request("https://renewlet.example/api/app/admin/system/update/status"), envFixture())).rejects.toMatchObject({ status: 403 });
    await expect(systemRestart(new Request("https://renewlet.example/api/app/admin/system/restart", {
      method: "POST",
    }), envFixture())).rejects.toMatchObject({ status: 403 });
  });
});

function envFixture(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
    RENEWLET_VERSION: "1.2.3",
    RENEWLET_COMMIT: "504c1681822ac60f0caafdb0b1ba731853c9169d",
    RENEWLET_BUILD_TIME: "2026-06-02T00:00:00Z",
    ...overrides,
  };
}

function mockLatestRelease(version: string) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    new Response(releaseAtomFixture([version]), {
      headers: { "content-type": "application/atom+xml" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function mockReleaseFeed(versions: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(releaseAtomFixture(versions), {
        headers: { "content-type": "application/atom+xml" },
      }),
    ),
  );
}

function releaseAtomFixture(versions: string[]): string {
  const entries = versions.map((version) => {
    const tag = version.startsWith("v") ? version : `v${version}`;
    return `  <entry>
    <updated>2026-06-02T00:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/zhiyingzzhou/renewlet/releases/tag/${tag}"/>
    <title>${tag}</title>
    <content type="html">&lt;p&gt;Release notes&lt;/p&gt;</content>
  </entry>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
${entries}
</feed>`;
}
