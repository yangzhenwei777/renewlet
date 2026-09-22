// Worker 图标索引测试保护 D1 job、Queue ack/retry、官方 registry fallback，以及失败不切 active 的运行面契约。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMediaCandidateItem } from "@renewlet/shared/media-resolver";
import type { BuiltInIconIndexProviderRefreshResponse, BuiltInIconIndexStatus } from "@renewlet/shared/schemas/media";
import { readSuccessData } from "./api-test-helpers";
import {
  builtInIconIndexStatus,
  checkBuiltInIconIndexProvider,
  getActiveBuiltInMediaResolver,
  providerFailureMessage,
  refreshBuiltInIconIndexProvider,
} from "./media-icon-index";
import { consumeBuiltInIconIndexRefreshQueue } from "./media-icon-index-refresh-queue";
import {
  createEnv,
  dashboardRegistryFixture,
  envWithActiveDashboardProvider,
  lastQueueMessage,
  latestJob,
  mediaIconIndexRefreshJobRow,
  mediaIconIndexRow,
  messageBatch,
  providerVersion,
  requestFixture,
  selfhstRegistryFixture,
  stubOfficialRegistryFetch,
} from "./media-icon-index-test-helpers";
import { UpstreamRequestError } from "./upstream-http";

vi.mock("./auth", () => ({
  requireAdmin: vi.fn().mockResolvedValue({
    user: { id: "usr_admin", role: "admin" },
  }),
}));

describe("Cloudflare media icon index", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns embedded provider statuses when no runtime index is active", async () => {
    const env = createEnv();
    const response = await builtInIconIndexStatus(requestFixture("GET"), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexStatus>(response);
    expect(body).toMatchObject({ source: "embedded", refreshing: false });
    expectSeedProviderVersions(body);
  });

  it("keeps status readable when the refresh job table has not been migrated yet", async () => {
    const env = createEnv(null, { jobTableUnavailable: true });

    const response = await builtInIconIndexStatus(requestFixture("GET"), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexStatus>(response);
    expect(body).toMatchObject({ source: "embedded", refreshing: false });
    expect(body.providers.every((provider) => provider.job === undefined)).toBe(true);
  });

  it("keeps old artifact_hash refresh jobs visible in provider status", async () => {
    const oldHash = "a".repeat(64);
    const oldJob = mediaIconIndexRefreshJobRow({
      id: "job_failed_old_column",
      provider: "selfhst",
      status: "failed",
      attempts: 2,
      error: "old refresh failed",
      artifact_hash: oldHash,
      finished_at: "2026-06-11T00:01:00.000Z",
    });
    delete oldJob.index_hash;
    const env = createEnv(null, {
      jobs: [oldJob],
    });

    const response = await builtInIconIndexStatus(requestFixture("GET"), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexStatus>(response);
    expect(body.providers.find((provider) => provider.provider === "selfhst")?.job).toMatchObject({
      id: "job_failed_old_column",
      status: "failed",
      error: "old refresh failed",
      indexHash: oldHash,
    });
  });

  it("ignores legacy locked_until when reading provider status", async () => {
    const env = createEnv(mediaIconIndexRow({
      locked_until: "2026-06-11T00:02:00.000Z",
    }));

    const response = await builtInIconIndexStatus(requestFixture("GET"), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexStatus>(response);
    expect(body.refreshing).toBe(false);
    expect(body.providers.every((provider) => provider.refreshing === false)).toBe(true);
  });

  it("expires stale running refresh jobs when reading provider status", async () => {
    const env = createEnv(null, {
      jobs: [mediaIconIndexRefreshJobRow({
        id: "job_stale_running",
        provider: "dashboardIcons",
        status: "running",
        attempts: 1,
        updated_at: "2026-06-10T23:49:00.000Z",
      })],
    });

    const response = await builtInIconIndexStatus(requestFixture("GET"), env);

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexStatus>(response);
    expect(body.refreshing).toBe(false);
    expect(body.providers.find((provider) => provider.provider === "dashboardIcons")?.job).toMatchObject({
      id: "job_stale_running",
      status: "failed",
      error: expect.stringContaining("safety timeout"),
    });
  });

  it("checks one provider latest version with Atom ETag without switching active", async () => {
    const env = createEnv(mediaIconIndexRow({
      provider_status_json: JSON.stringify({
        thesvg: {
          latest: providerVersion("abc1234567890abcdefabc1234567890abcdef12"),
          etag: "\"cached\"",
        },
      }),
    }));
    env.RENEWLET_VERSION = "1.2.3";
    const fetchMock = vi.fn(async () => new Response(null, { status: 304, headers: { etag: "\"cached\"" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await checkBuiltInIconIndexProvider(requestFixture("POST"), env, "thesvg");

    expect(response.status).toBe(200);
    await expect(readSuccessData<Record<string, unknown>>(response)).resolves.toMatchObject({
      status: {
        refreshing: false,
      },
      provider: {
        provider: "thesvg",
        refreshing: false,
        latest: { commitSha: "abc1234567890abcdefabc1234567890abcdef12" },
      },
    });
    expect(env.testState.row?.hash).toBeNull();
    expect(env.testState.objects.size).toBe(0);
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo | URL, RequestInit?]>;
    expect(String(calls[0]?.[0])).toBe("https://github.com/glincker/thesvg/commits/main.atom");
    const init = calls[0]?.[1];
    expect(init?.headers).toMatchObject({
      accept: "application/atom+xml",
      "if-none-match": "\"cached\"",
      "user-agent": "Renewlet/1.2.3",
    });
  });

  it("records GitHub Atom failures as provider status without breaking check responses", async () => {
    const env = createEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("atom feed unavailable", { status: 429 })));

    const response = await checkBuiltInIconIndexProvider(requestFixture("POST"), env, "selfhst");

    expect(response.status).toBe(200);
    await expect(readSuccessData<Record<string, unknown>>(response)).resolves.toMatchObject({
      status: {
        source: "embedded",
        refreshing: false,
      },
      provider: {
        provider: "selfhst",
        refreshing: false,
        lastError: expect.stringContaining("GitHub commit feed HTTP 429"),
      },
      errorDetails: {
        rawResponseText: "atom feed unavailable",
      },
    });
    expect(env.testState.row?.hash).toBeNull();
    expect(env.testState.objects.size).toBe(0);
    expect(env.testState.row?.provider_status_json).not.toContain("atom feed unavailable");
  });

  it("preserves cached provider versions when GitHub Atom check fails", async () => {
    const activeHash = "b".repeat(64);
    const current = providerVersion("1111111222233334444555566667777888899990");
    const latest = providerVersion("2222222333344445555666677778888999900001");
    const env = createEnv(mediaIconIndexRow({
      hash: activeHash,
      provider_status_json: JSON.stringify({
        selfhst: {
          current,
          latest,
          etag: "\"cached\"",
          checkedAt: "2026-06-10T00:00:00.000Z",
          refreshedAt: "2026-06-10T00:00:00.000Z",
          iconCount: 42,
        },
      }),
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    const response = await checkBuiltInIconIndexProvider(requestFixture("POST"), env, "selfhst");

    expect(response.status).toBe(200);
    await expect(readSuccessData<Record<string, unknown>>(response)).resolves.toMatchObject({
      status: {
        refreshing: false,
      },
      provider: {
        provider: "selfhst",
        current: { commitSha: current.commitSha },
        latest: { commitSha: latest.commitSha },
        updateAvailable: true,
        refreshing: false,
        lastError: expect.stringContaining("GitHub commit feed HTTP 429"),
      },
      errorDetails: {
        rawResponseText: "rate limited",
      },
    });
    expect(env.testState.row?.hash).toBe(activeHash);
    expect(env.testState.objects.size).toBe(0);

    const refreshResponse = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "selfhst");
    expect(refreshResponse.status).toBe(200);
    const refreshBody = await readSuccessData<BuiltInIconIndexProviderRefreshResponse>(refreshResponse);
    expect(refreshBody.job).toMatchObject({ provider: "selfhst", status: "queued" });
    expect(env.testState.queueMessages).toEqual([
      expect.objectContaining({ jobId: refreshBody.job.id, provider: "selfhst" }),
    ]);
  });

  it("checks providers while a legacy locked_until value is still active", async () => {
    const env = createEnv(mediaIconIndexRow({
      locked_until: "2026-06-11T00:02:00.000Z",
    }));
    const commitSha = "3333333444455556666777788889999000011112";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(gitHubCommitAtomFixture(commitSha), {
      status: 200,
      headers: { etag: "\"fresh\"" },
    })));

    const response = await checkBuiltInIconIndexProvider(requestFixture("POST"), env, "selfhst");

    expect(response.status).toBe(200);
    const body = await readSuccessData<Record<string, unknown>>(response);
    expect(body).toMatchObject({
      status: {
        refreshing: false,
      },
      provider: {
        provider: "selfhst",
        latest: { commitSha },
        refreshing: false,
      },
    });
    expect(env.testState.row?.locked_until).toBe("2026-06-11T00:02:00.000Z");
  });

  it("keeps provider check responses readable when the refresh job table is missing", async () => {
    const env = createEnv(null, { jobTableUnavailable: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("atom feed unavailable", { status: 429 })));

    const response = await checkBuiltInIconIndexProvider(requestFixture("POST"), env, "selfhst");

    expect(response.status).toBe(200);
    await expect(readSuccessData<Record<string, unknown>>(response)).resolves.toMatchObject({
      status: {
        source: "embedded",
        refreshing: false,
      },
      provider: {
        provider: "selfhst",
        refreshing: false,
        lastError: expect.stringContaining("GitHub commit feed HTTP 429"),
      },
    });
  });

  it("enqueues provider refresh jobs without writing R2 indexes in the HTTP request", async () => {
    const env = createEnv();
    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexProviderRefreshResponse>(response);
    expect(body).toMatchObject({
      status: {
        source: "embedded",
        refreshing: true,
      },
      provider: {
        provider: "dashboardIcons",
        refreshing: true,
        job: {
          status: "queued",
          attempts: 0,
        },
      },
      job: {
        provider: "dashboardIcons",
        status: "queued",
      },
    });
    expect(env.testState.queueMessages).toEqual([
      expect.objectContaining({ jobId: body.job.id, provider: "dashboardIcons", requestedAt: body.job.queuedAt }),
    ]);
    expect(env.testState.row).toBeNull();
    expect(env.testState.objects.size).toBe(0);
  });

  it("enqueues provider refresh jobs while a legacy locked_until value is still active", async () => {
    const env = createEnv(mediaIconIndexRow({
      locked_until: "2026-06-11T00:02:00.000Z",
    }));

    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexProviderRefreshResponse>(response);
    expect(body).toMatchObject({
      status: {
        refreshing: true,
      },
      provider: {
        provider: "dashboardIcons",
        refreshing: true,
        job: { status: "queued" },
      },
      job: {
        provider: "dashboardIcons",
        status: "queued",
      },
    });
    expect(env.testState.queueMessages).toEqual([
      expect.objectContaining({ jobId: body.job.id, provider: "dashboardIcons" }),
    ]);
    expect(env.testState.row?.locked_until).toBe("2026-06-11T00:02:00.000Z");
  });

  it("reports refresh job schema unavailability instead of throwing 500 when the job table is missing", async () => {
    const env = createEnv(null, { jobTableUnavailable: true });

    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "thesvg");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "MEDIA_ICON_INDEX_REFRESH_SCHEMA_UNAVAILABLE",
      },
    });
    expect(env.testState.queueMessages).toHaveLength(0);
  });

  it("reports refresh job schema unavailability when an old job table lacks index_hash", async () => {
    const env = createEnv(null, { jobIndexHashColumnUnavailable: true });

    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "thesvg");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "MEDIA_ICON_INDEX_REFRESH_SCHEMA_UNAVAILABLE",
      },
    });
    expect(env.testState.queueMessages).toHaveLength(0);
  });

  it("creates a new refresh job after expiring a stale running job", async () => {
    const env = createEnv(null, {
      jobs: [mediaIconIndexRefreshJobRow({
        id: "job_stale_running",
        provider: "dashboardIcons",
        status: "running",
        attempts: 1,
        updated_at: "2026-06-10T23:49:00.000Z",
      })],
    });

    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexProviderRefreshResponse>(response);
    expect(body.job).toMatchObject({ provider: "dashboardIcons", status: "queued" });
    expect(env.testState.jobs.find((job) => job.id === "job_stale_running")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("safety timeout"),
    });
    expect(env.testState.queueMessages).toEqual([
      expect.objectContaining({ jobId: body.job.id, provider: "dashboardIcons" }),
    ]);
  });

  it("deduplicates running provider refresh jobs", async () => {
    const env = createEnv(null, {
      jobs: [mediaIconIndexRefreshJobRow({
        id: "job_running",
        provider: "thesvg",
        status: "running",
        attempts: 1,
      })],
    });

    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "thesvg");

    expect(response.status).toBe(200);
    const body = await readSuccessData<BuiltInIconIndexProviderRefreshResponse>(response);
    expect(body.status.refreshing).toBe(true);
    expect(body.provider.refreshing).toBe(true);
    expect(body.job).toMatchObject({ id: "job_running", status: "running", attempts: 1 });
    expect(env.testState.queueMessages).toHaveLength(0);
  });

  it("consumes a queued Dashboard Icons refresh from official registry sources and switches only that provider", async () => {
    const env = createEnv();
    const commitSha = "ccc111122223333444455556666777788889999";
    const fetchMock = stubOfficialRegistryFetch({
      provider: "dashboardIcons",
      commitSha,
      registries: dashboardRegistryFixture("cf-dashboard"),
    });
    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");
    const body = await readSuccessData<BuiltInIconIndexProviderRefreshResponse>(response);
    const batch = messageBatch(env.testState.queueMessages[0]);

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 1, retried: 0 });
    const job = env.testState.jobs.find((item) => item.id === body.job.id);
    expect(job).toMatchObject({ status: "succeeded", attempts: 1, index_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect([...env.testState.objects.keys()]).toEqual([
      expect.stringMatching(/^system\/media-icon-index\/dashboardIcons\/[a-f0-9]{64}\.search\.json\.gz$/),
    ]);

    const status = await readSuccessData<BuiltInIconIndexStatus>(await builtInIconIndexStatus(requestFixture("GET"), env));
    expect(status.source).toBe("runtime");
    expect(status.providerCounts.dashboardIcons).toBe(1);
    expect(status.providers.find((item) => item.provider === "dashboardIcons")).toMatchObject({
      current: { commitSha },
      latest: { commitSha },
      iconCount: 1,
      refreshing: false,
      lastError: null,
      job: { status: "succeeded" },
    });
    expectSeedProviderVersions(status, ["dashboardIcons"]);

    const resolver = await getActiveBuiltInMediaResolver(env);
    const item = resolveMediaCandidateItem(
      resolver,
      "logo",
      "search",
      { id: "cf", name: "Cf Dashboard" },
      4,
      {},
    );
    expect(item.candidates.builtIn[0]).toMatchObject({
      provider: "dashboardIcons",
      url: expect.stringContaining(`@${commitSha}/svg/cf-dashboard.svg`),
    });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toEqual([
      "https://github.com/homarr-labs/dashboard-icons/commits/main.atom",
      `https://testingcf.jsdelivr.net/gh/homarr-labs/dashboard-icons@${commitSha}/metadata.json`,
      `https://testingcf.jsdelivr.net/gh/homarr-labs/dashboard-icons@${commitSha}/tree.json`,
    ]);
  });

  it("falls back from jsDelivr to raw.githubusercontent.com for official registry JSON", async () => {
    const env = createEnv();
    const commitSha = "bbb111122223333444455556666777788889999";
    const fetchMock = stubOfficialRegistryFetch({
      provider: "selfhst",
      commitSha,
      registries: selfhstRegistryFixture("raw-budget"),
      failJsDelivr: true,
    });
    await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "selfhst");
    const batch = messageBatch(lastQueueMessage(env));

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 1, retried: 0 });
    expect(latestJob(env, "selfhst")).toMatchObject({ status: "succeeded" });
    expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(
      `https://raw.githubusercontent.com/selfhst/icons/${commitSha}/index.json`,
    );
    const status = await readSuccessData<BuiltInIconIndexStatus>(await builtInIconIndexStatus(requestFixture("GET"), env));
    expect(status.providerCounts.selfhst).toBe(1);
  });

  it("acks permanent official registry 404 failures and keeps the previous active index", async () => {
    const env = await envWithActiveDashboardProvider();
    const activeHash = env.testState.row?.hash;
    stubOfficialRegistryFetch({
      provider: "dashboardIcons",
      commitSha: "ddd111122223333444455556666777788889999",
      registries: dashboardRegistryFixture("never-used"),
      permanentRegistry404: true,
    });
    await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");
    const batch = messageBatch(lastQueueMessage(env));

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 1, retried: 0 });
    expect(env.testState.row?.hash).toBe(activeHash);
    expect(latestJob(env, "dashboardIcons")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Dashboard Icons metadata failed"),
    });
    const status = await readSuccessData<BuiltInIconIndexStatus>(await builtInIconIndexStatus(requestFixture("GET"), env));
    expect(status.refreshing).toBe(false);
    expect(status.providers.find((item) => item.provider === "dashboardIcons")?.job?.status).toBe("failed");
  });

  it("retries transient official registry 5xx failures and keeps the previous active index", async () => {
    const env = await envWithActiveDashboardProvider();
    const activeHash = env.testState.row?.hash;
    stubOfficialRegistryFetch({
      provider: "dashboardIcons",
      commitSha: "eee111122223333444455556666777788889999",
      registries: dashboardRegistryFixture("never-used"),
      transientRegistry503: true,
    });
    await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");
    const batch = messageBatch(lastQueueMessage(env));

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 0, retried: 1 });
    expect(env.testState.row?.hash).toBe(activeHash);
    expect(latestJob(env, "dashboardIcons")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("HTTP 503"),
    });
  });

  it("keeps a durable failure summary when transient upstream diagnostics are raw-only", () => {
    const error = new UpstreamRequestError(
      "Dashboard Icons metadata GET request to https://example.test/metadata.json timed out after 15s before response headers; headers={\"accept\":\"application/json\"}",
      true,
    );

    expect(providerFailureMessage(error)).toBe(
      "Dashboard Icons metadata GET request to https://example.test/metadata.json timed out after 15s before response headers",
    );
  });

  it("retries R2 write failures without switching the active index", async () => {
    const env = await envWithActiveDashboardProvider();
    const activeHash = env.testState.row?.hash;
    stubOfficialRegistryFetch({
      provider: "dashboardIcons",
      commitSha: "fff111122223333444455556666777788889999",
      registries: dashboardRegistryFixture("r2-failure"),
    });
    env.testState.failR2Put = true;
    await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");
    const batch = messageBatch(lastQueueMessage(env));

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 0, retried: 1 });
    expect(env.testState.row?.hash).toBe(activeHash);
    expect(latestJob(env, "dashboardIcons")).toMatchObject({ status: "failed", error: "R2 put failed" });
  });

  it("retries D1 active pointer failures without switching the active index", async () => {
    const env = await envWithActiveDashboardProvider();
    const activeHash = env.testState.row?.hash;
    stubOfficialRegistryFetch({
      provider: "dashboardIcons",
      commitSha: "999111122223333444455556666777788889999",
      registries: dashboardRegistryFixture("d1-failure"),
    });
    env.testState.failD1ActiveUpdate = true;
    await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");
    const batch = messageBatch(lastQueueMessage(env));

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 0, retried: 1 });
    expect(env.testState.row?.hash).toBe(activeHash);
    expect(latestJob(env, "dashboardIcons")).toMatchObject({ status: "failed", error: "D1 active update failed" });
  });

  it("acks stale retry messages after a newer provider refresh job exists", async () => {
    const oldJob = mediaIconIndexRefreshJobRow({
      id: "job_old",
      provider: "thesvg",
      status: "failed",
      queued_at: "2026-06-11T00:00:00.000Z",
      updated_at: "2026-06-11T00:00:00.000Z",
    });
    const newerJob = mediaIconIndexRefreshJobRow({
      id: "job_new",
      provider: "thesvg",
      status: "queued",
      queued_at: "2026-06-11T00:00:00.000Z",
      updated_at: "2026-06-11T00:00:00.000Z",
    });
    const env = createEnv(null, { jobs: [oldJob, newerJob] });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const batch = messageBatch({
      jobId: "job_old",
      provider: "thesvg",
      requestedAt: oldJob.queued_at,
    });

    await consumeBuiltInIconIndexRefreshQueue(batch, env);

    expect(batch.testDelivery).toEqual({ acked: 1, retried: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(env.testState.jobs.find((job) => job.id === "job_old")).toMatchObject({ status: "failed", attempts: 0 });
  });

  it("rejects non-empty refresh bodies before creating jobs", async () => {
    const env = createEnv();

    await expect(refreshBuiltInIconIndexProvider(requestFixture("POST", "{}"), env, "thesvg")).rejects.toMatchObject({
      status: 400,
      code: "NON_EMPTY_BODY",
    });
    expect(env.testState.row).toBeNull();
    expect(env.testState.jobs).toHaveLength(0);
  });

  it("reports a missing queue binding without changing active metadata", async () => {
    const env = createEnv();
    delete env.MEDIA_ICON_INDEX_REFRESH_QUEUE;

    const response = await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "thesvg");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "MEDIA_ICON_INDEX_REFRESH_QUEUE_MISSING",
      },
    });
    expect(env.testState.objects.size).toBe(0);
    expect(env.testState.jobs).toHaveLength(0);
  });
});

function expectSeedProviderVersions(status: BuiltInIconIndexStatus, skipProviders: string[] = []): void {
  for (const provider of status.providers) {
    if (skipProviders.includes(provider.provider)) continue;
    expect(provider.current?.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(provider.current?.commitShortSha).toMatch(/^[a-f0-9]{7}$/);
    expect(provider.current?.commitDate).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(provider.current?.sourceRef).not.toBe("embedded");
    expect(provider.current?.sourceRef).not.toBe("runtime");
  }
}

function gitHubCommitAtomFixture(sha: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Grit::Commit/${sha}</id>
    <updated>2026-06-11T00:00:00Z</updated>
  </entry>
</feed>`;
}
