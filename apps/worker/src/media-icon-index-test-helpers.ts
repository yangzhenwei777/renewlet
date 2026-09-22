import { readFileSync } from "node:fs";
import { vi } from "vitest";
import { refreshBuiltInIconIndexProvider } from "./media-icon-index";
import { consumeBuiltInIconIndexRefreshQueue } from "./media-icon-index-refresh-queue";
import type { Env, MediaIconIndexRefreshJobRow, MediaIconIndexRow } from "./types";

export interface TestState {
  row: MediaIconIndexRow | null;
  jobs: MediaIconIndexRefreshJobRow[];
  queueMessages: unknown[];
  objects: Map<string, Uint8Array>;
  failQueueSend: boolean;
  failR2Put: boolean;
  failD1ActiveUpdate: boolean;
  jobTableUnavailable: boolean;
  jobIndexHashColumnUnavailable: boolean;
}

export type TestEnv = Env & { testState: TestState };

export function createEnv(row: MediaIconIndexRow | null = null, statePatch: Partial<TestState> = {}): TestEnv {
  const state: TestState = {
    row,
    jobs: [],
    queueMessages: [],
    objects: new Map(),
    failQueueSend: false,
    failR2Put: false,
    failD1ActiveUpdate: false,
    jobTableUnavailable: false,
    jobIndexHashColumnUnavailable: false,
    ...statePatch,
  };

  return {
    DB: createD1(state),
    ASSETS: createStaticAssets(),
    ASSETS_BUCKET: createR2(state),
    MEDIA_ICON_INDEX_REFRESH_QUEUE: createQueue(state),
    testState: state,
  };
}

function createStaticAssets(): Fetcher {
  const assets = new Map<string, Uint8Array | string>([
    ["/built-in-icons/metadata.json", readFileSync(new URL("../../web/public/built-in-icons/metadata.json", import.meta.url), "utf8")],
    ["/built-in-icons/search-index.json.gz", readFileSync(new URL("../../web/public/built-in-icons/search-index.json.gz", import.meta.url))],
  ]);
  return {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const asset = assets.get(url.pathname);
      if (!asset) return new Response("not found", { status: 404 });
      if (typeof asset === "string") return new Response(asset, { status: 200 });
      const body = new ArrayBuffer(asset.byteLength);
      new Uint8Array(body).set(asset);
      return new Response(body, { status: 200 });
    },
  } as Fetcher;
}

function createD1(state: TestState): D1Database {
  return {
    batch: async (statements: Array<{ run: () => Promise<D1Result> }>) => {
      const results: D1Result[] = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    },
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          const compactSQL = sql.replace(/\s+/g, " ");
          if (compactSQL.includes("SELECT * FROM media_icon_indexes")) return state.row;
          if (compactSQL.includes("media_icon_index_refresh_jobs") && state.jobTableUnavailable) {
            throw new Error("D1_ERROR: no such table: media_icon_index_refresh_jobs: SQLITE_ERROR");
          }
          if (compactSQL.includes("SELECT * FROM media_icon_index_refresh_jobs WHERE id = ?")) {
            return state.jobs.find((job) => job.id === stringArg(args, 0)) ?? null;
          }
          if (compactSQL.includes("queued_at >= ?")) {
            return latestJobAfter(state, stringArg(args, 0), stringArg(args, 1), stringArg(args, 2));
          }
          if (compactSQL.includes("status IN ('queued', 'running')")) {
            return latestJobWhere(state, stringArg(args, 0), (job) => job.status === "queued" || job.status === "running");
          }
          if (compactSQL.includes("WHERE provider = ? ORDER BY queued_at DESC")) {
            return latestJobWhere(state, stringArg(args, 0), () => true);
          }
          return null;
        },
        run: async () => {
          if (sql.includes("INSERT OR IGNORE INTO media_icon_indexes")) {
            if (!state.row) {
              state.row = mediaIconIndexRow({
                provider_counts_json: "{}",
                provider_status_json: "{}",
                created_at: stringArg(args, 1),
                updated_at: stringArg(args, 2),
              });
              return d1Result(1);
            }
            return d1Result(0);
          }
          if (sql.includes("INSERT INTO media_icon_index_refresh_jobs")) {
            if (state.jobTableUnavailable) throw new Error("D1_ERROR: no such table: media_icon_index_refresh_jobs: SQLITE_ERROR");
            if (state.jobIndexHashColumnUnavailable) throw new Error("D1_ERROR: table media_icon_index_refresh_jobs has no column named index_hash: SQLITE_ERROR");
            const provider = stringArg(args, 1) as MediaIconIndexRefreshJobRow["provider"];
            if (state.jobs.some((job) => job.provider === provider && (job.status === "queued" || job.status === "running"))) {
              throw new Error("UNIQUE constraint failed: media_icon_index_refresh_jobs.provider");
            }
            state.jobs.push(mediaIconIndexRefreshJobRow({
              id: stringArg(args, 0),
              provider,
              status: "queued",
              attempts: 0,
              error: null,
              index_hash: null,
              artifact_hash: null,
              queued_at: stringArg(args, 2),
              started_at: null,
              finished_at: null,
              created_at: stringArg(args, 3),
              updated_at: stringArg(args, 4),
            }));
            return d1Result(1);
          }
          if (sql.includes("SET status = 'running'")) {
            if (state.jobTableUnavailable) throw new Error("D1_ERROR: no such table: media_icon_index_refresh_jobs: SQLITE_ERROR");
            const job = state.jobs.find((item) => item.id === stringArg(args, 2));
            if (job) {
              job.status = "running";
              job.attempts += 1;
              job.error = null;
              job.started_at ||= stringArg(args, 0);
              job.finished_at = null;
              job.updated_at = stringArg(args, 1);
            }
            return d1Result(job ? 1 : 0);
          }
          if (sql.includes("SET status = 'failed'") && !sql.includes("index_hash")) {
            if (state.jobTableUnavailable) throw new Error("D1_ERROR: no such table: media_icon_index_refresh_jobs: SQLITE_ERROR");
            const provider = args.length === 5 ? stringArg(args, 3) : null;
            const cutoff = stringArg(args, args.length === 5 ? 4 : 3);
            let changes = 0;
            for (const job of state.jobs) {
              if (provider && job.provider !== provider) continue;
              if (job.status !== "queued" && job.status !== "running") continue;
              if (job.updated_at >= cutoff) continue;
              job.status = "failed";
              job.error = stringArg(args, 0);
              job.finished_at = stringArg(args, 1);
              job.updated_at = stringArg(args, 2);
              changes += 1;
            }
            return d1Result(changes);
          }
          if (sql.includes("SET status = 'succeeded'")) {
            if (state.jobTableUnavailable) throw new Error("D1_ERROR: no such table: media_icon_index_refresh_jobs: SQLITE_ERROR");
            if (state.jobIndexHashColumnUnavailable) throw new Error("D1_ERROR: no such column: index_hash: SQLITE_ERROR");
            const job = state.jobs.find((item) => item.id === stringArg(args, 3) && item.provider === stringArg(args, 4));
            if (job) {
              job.status = "succeeded";
              job.error = null;
              job.index_hash = stringArg(args, 0);
              job.finished_at = stringArg(args, 1);
              job.updated_at = stringArg(args, 2);
            }
            return d1Result(job ? 1 : 0);
          }
          if (sql.includes("SET status = 'failed'")) {
            if (state.jobTableUnavailable) throw new Error("D1_ERROR: no such table: media_icon_index_refresh_jobs: SQLITE_ERROR");
            if (state.jobIndexHashColumnUnavailable) throw new Error("D1_ERROR: no such column: index_hash: SQLITE_ERROR");
            const job = state.jobs.find((item) => item.id === stringArg(args, 4) && item.provider === stringArg(args, 5));
            if (job) {
              job.status = "failed";
              job.error = stringArg(args, 0);
              job.index_hash = stringOrNullArg(args, 1);
              job.finished_at = stringArg(args, 2);
              job.updated_at = stringArg(args, 3);
            }
            return d1Result(job ? 1 : 0);
          }
          if (sql.includes("SET locked_until = ?")) {
            const now = stringArg(args, 3);
            if (!state.row?.locked_until || state.row.locked_until <= now) {
              state.row = { ...mediaIconIndexRow(state.row ?? {}), locked_until: stringArg(args, 0), updated_at: stringArg(args, 1) };
              return d1Result(1);
            }
            return d1Result(0);
          }
          if (sql.includes("SET locked_until = NULL")) {
            if (state.row) state.row = { ...state.row, locked_until: null, updated_at: stringArg(args, 0) };
            return d1Result(1);
          }
          if (sql.includes("SET hash = ?")) {
            if (state.failD1ActiveUpdate) throw new Error("D1 active update failed");
            state.row = {
              ...mediaIconIndexRow(state.row ?? {}),
              hash: stringArg(args, 0),
              search_r2_key: stringOrNullArg(args, 1),
              detail_r2_key: stringOrNullArg(args, 2),
              icon_count: numberArg(args, 3),
              provider_counts_json: stringArg(args, 4),
              provider_status_json: stringArg(args, 5),
              checked_at: stringArg(args, 6),
              index_updated_at: stringArg(args, 7),
              updated_at: stringArg(args, 8),
            };
            return d1Result(1);
          }
          if (sql.includes("SET checked_at = ?, provider_status_json = ?")) {
            if (state.row?.provider_status_json !== stringArg(args, 4)) return d1Result(0);
            state.row = {
              ...mediaIconIndexRow(state.row ?? {}),
              checked_at: stringArg(args, 0),
              provider_status_json: stringArg(args, 1),
              updated_at: stringArg(args, 2),
            };
            return d1Result(1);
          }
          return d1Result(0);
        },
      }),
    }),
  } as unknown as D1Database;
}

function createQueue(state: TestState): Queue<unknown> {
  return {
    send: async (body: unknown) => {
      if (state.failQueueSend) throw new Error("queue send failed");
      state.queueMessages.push(body);
    },
  } as unknown as Queue<unknown>;
}

function createR2(state: TestState): R2Bucket {
  return {
    get: async (key: string) => {
      const bytes = state.objects.get(key);
      if (!bytes) return null;
      return {
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      };
    },
    put: async (key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob) => {
      if (state.failR2Put) throw new Error("R2 put failed");
      state.objects.set(key, await bodyToBytes(value));
      return null;
    },
  } as unknown as R2Bucket;
}

async function bodyToBytes(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    const buffer = new ArrayBuffer(value.byteLength);
    new Uint8Array(buffer).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return new Uint8Array(buffer);
  }
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(await new Response(value).arrayBuffer());
}

function d1Result(changes: number): D1Result {
  return { meta: { changes } } as D1Result;
}

export function mediaIconIndexRow(overrides: Partial<MediaIconIndexRow>): MediaIconIndexRow {
  return {
    key: "active",
    hash: null,
    search_r2_key: null,
    detail_r2_key: null,
    icon_count: 0,
    provider_counts_json: "{}",
    provider_status_json: "{}",
    checked_at: null,
    index_updated_at: null,
    locked_until: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

export function mediaIconIndexRefreshJobRow(overrides: Partial<MediaIconIndexRefreshJobRow>): MediaIconIndexRefreshJobRow {
  return {
    id: "job_test",
    provider: "thesvg",
    status: "queued",
    attempts: 0,
    error: null,
    index_hash: null,
    artifact_hash: null,
    queued_at: "2026-06-11T00:00:00.000Z",
    started_at: null,
    finished_at: null,
    created_at: "2026-06-11T00:00:00.000Z",
    updated_at: "2026-06-11T00:00:00.000Z",
    ...overrides,
  };
}

export function requestFixture(method: string, body?: string): Request {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const headers: HeadersInit = {
    "accept-language": "en-US",
    cookie: "renewlet_session=session-token; renewlet_csrf=csrf-token",
    ...(unsafe ? { origin: "https://renewlet.example", "x-renewlet-csrf": "csrf-token" } : {}),
  };
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = body;
  }
  return new Request("https://renewlet.example/api/app/admin/media/icon-index/providers/thesvg/refresh", init);
}

export async function envWithActiveDashboardProvider(): Promise<TestEnv> {
  const env = createEnv();
  stubOfficialRegistryFetch({
    provider: "dashboardIcons",
    commitSha: "aaa111122223333444455556666777788889999",
    registries: dashboardRegistryFixture("active-dashboard"),
  });
  await refreshBuiltInIconIndexProvider(requestFixture("POST"), env, "dashboardIcons");
  await consumeBuiltInIconIndexRefreshQueue(messageBatch(lastQueueMessage(env)), env);
  return env;
}

export function stubOfficialRegistryFetch(input: {
  provider: "thesvg" | "selfhst" | "dashboardIcons";
  commitSha: string;
  registries: Record<string, unknown>;
  failJsDelivr?: boolean;
  permanentRegistry404?: boolean;
  transientRegistry503?: boolean;
}) {
  const fetchMock = vi.fn(async (requestInput: RequestInfo | URL) => {
    const url = new URL(requestInput instanceof Request ? requestInput.url : String(requestInput));
    if (url.hostname === "github.com" && url.pathname.endsWith("/commits/main.atom")) {
      return atomCommitResponse(input.commitSha);
    }
    if (url.hostname === "github.com" && url.pathname.endsWith("/releases.atom")) {
      return atomReleaseResponse("thesvg@3.0.15");
    }
    const label = registryLabelFromUrl(url);
    if (!label) return new Response("unexpected url", { status: 404 });
    if (input.permanentRegistry404) return new Response("not found", { status: 404 });
    if (input.transientRegistry503) return new Response("temporarily unavailable", { status: 503 });
    if (input.failJsDelivr && url.hostname.includes("jsdelivr")) return new Response("cdn unavailable", { status: 503 });
    return jsonResponse(input.registries[label] ?? {});
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function registryLabelFromUrl(url: URL): string | null {
  if (url.pathname.endsWith("/src/data/icons.json")) return "TheSVG registry";
  if (url.pathname.endsWith("/index.json")) return "selfh.st index";
  if (url.pathname.endsWith("/metadata.json")) return "Dashboard Icons metadata";
  if (url.pathname.endsWith("/tree.json")) return "Dashboard Icons tree";
  return null;
}

export function dashboardRegistryFixture(slug: string): Record<string, unknown> {
  return {
    "Dashboard Icons metadata": {
      [slug]: {
        aliases: ["Cf Dashboard"],
        categories: ["Cloud"],
      },
    },
    "Dashboard Icons tree": {
      svg: [`${slug}.svg`],
    },
  };
}

export function selfhstRegistryFixture(slug: string): Record<string, unknown> {
  return {
    "selfh.st index": [
      {
        Reference: slug,
        Name: "Raw Budget",
        Category: "Finance",
        SVG: "Yes",
      },
    ],
  };
}

export function messageBatch(message: unknown): MessageBatch<unknown> & { testDelivery: { acked: number; retried: number } } {
  const testDelivery = { acked: 0, retried: 0 };
  return {
    messages: [{
      body: message,
      ack: () => {
        testDelivery.acked += 1;
      },
      retry: () => {
        testDelivery.retried += 1;
      },
    }],
    testDelivery,
  } as unknown as MessageBatch<unknown> & { testDelivery: { acked: number; retried: number } };
}

export function lastQueueMessage(env: TestEnv): unknown {
  const message = env.testState.queueMessages.at(-1);
  if (!message) throw new Error("expected queued message");
  return message;
}

export function latestJob(env: TestEnv, provider: MediaIconIndexRefreshJobRow["provider"]): MediaIconIndexRefreshJobRow | undefined {
  return latestJobWhere(env.testState, provider, () => true) ?? undefined;
}

function latestJobWhere(
  state: TestState,
  provider: string,
  predicate: (job: MediaIconIndexRefreshJobRow) => boolean,
): MediaIconIndexRefreshJobRow | null {
  return state.jobs
    .map((job, index) => ({ index, job }))
    .filter(({ job }) => job.provider === provider && predicate(job))
    .sort((a, b) => b.job.queued_at.localeCompare(a.job.queued_at) || b.index - a.index)[0]?.job ?? null;
}

function latestJobAfter(state: TestState, provider: string, jobId: string, queuedAt: string): MediaIconIndexRefreshJobRow | null {
  return latestJobWhere(state, provider, (job) => job.id !== jobId && job.queued_at >= queuedAt);
}

export function providerVersion(commitSha: string) {
  return {
    sourceRef: commitSha,
    displayVersion: commitSha.slice(0, 7),
    commitSha,
    commitShortSha: commitSha.slice(0, 7),
    commitDate: "2026-06-11T00:00:00Z",
    releaseTag: null,
    releasePublishedAt: null,
  };
}

function atomCommitResponse(commitSha: string): Response {
  return new Response([
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<feed>",
    "<entry>",
    `<id>tag:github.com,2008:Grit::Commit/${commitSha}</id>`,
    "<updated>2026-06-11T00:00:00Z</updated>",
    "</entry>",
    "</feed>",
  ].join(""), {
    headers: { "content-type": "application/atom+xml", etag: "\"commit-etag\"" },
  });
}

function atomReleaseResponse(tagName: string): Response {
  return new Response([
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<feed>",
    "<entry>",
    `<link href="https://github.com/glincker/thesvg/releases/tag/${encodeURIComponent(tagName)}" />`,
    "<updated>2026-06-11T01:00:00Z</updated>",
    "</entry>",
    "</feed>",
  ].join(""), {
    headers: { "content-type": "application/atom+xml" },
  });
}

function jsonResponse(value: unknown): Response {
  const body = JSON.stringify(value);
  return new Response(body, {
    headers: { "content-type": "application/json", "content-length": String(new TextEncoder().encode(body).byteLength) },
  });
}

function stringArg(args: readonly unknown[], index: number): string {
  const value = args[index];
  return typeof value === "string" ? value : "";
}

function stringOrNullArg(args: readonly unknown[], index: number): string | null {
  const value = args[index];
  return typeof value === "string" ? value : null;
}

function numberArg(args: readonly unknown[], index: number): number {
  const value = args[index];
  return typeof value === "number" ? value : 0;
}
