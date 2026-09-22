// Worker 汇率快照测试保护登录态当前月 capture、历史月拒绝和 owner-scoped 读取。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { putExchangeRateSnapshot, readExchangeRateSnapshots } from "./exchange-rate-snapshots";
import type { Env, ExchangeRateSnapshotRow } from "./types";

const USER_ID = "usr_rates";
const currentMonth = "2026-08";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  nowIso: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    nowIso: dbMocks.nowIso,
  };
});

function d1Result<T = unknown>(results: T[] = [], changes = 0): D1Result<T> {
  return { results, success: true, meta: { changes } as D1Meta } as D1Result<T>;
}

function createEnv(rows: ExchangeRateSnapshotRow[] = []): Env {
  const state = { rows };
  return {
    DB: {
      prepare: vi.fn((sql: string) => ({
        bind: (...values: unknown[]) => ({
          async all<T>() {
            if (!sql.includes("FROM exchange_rate_snapshots")) return d1Result<T>([]);
            const [userId, from, to] = values as [string, string | undefined, string | undefined];
            return d1Result(state.rows
              .filter((row) => row.user_id === userId)
              .filter((row) => !from || row.month >= from)
              .filter((row) => !to || row.month <= to)
              .sort((left, right) => left.month.localeCompare(right.month)) as T[]);
          },
          async first<T>() {
            if (!sql.includes("FROM exchange_rate_snapshots")) return null;
            const [userId, month] = values as [string, string];
            return state.rows.find((row) => row.user_id === userId && row.month === month) as T | undefined ?? null;
          },
          async run() {
            if (sql.includes("INSERT INTO exchange_rate_snapshots")) {
              const [
                userId,
                month,
                base,
                ratesJson,
                requestedProvider,
                provider,
                sourceDate,
                capturedAt,
                warningJson,
                createdAt,
                updatedAt,
              ] = values as [string, string, "USD", string, ExchangeRateSnapshotRow["requested_provider"], ExchangeRateSnapshotRow["provider"], string, string, string | null, string, string];
              const next: ExchangeRateSnapshotRow = {
                user_id: userId,
                month,
                base,
                rates_json: ratesJson,
                requested_provider: requestedProvider,
                provider,
                source_date: sourceDate,
                captured_at: capturedAt,
                warning_json: warningJson,
                created_at: createdAt,
                updated_at: updatedAt,
              };
              const index = state.rows.findIndex((row) => row.user_id === userId && row.month === month);
              if (index >= 0) state.rows[index] = { ...state.rows[index], ...next, created_at: state.rows[index]!.created_at };
              else state.rows.push(next);
            }
            return d1Result([], 1);
          },
        }),
      })),
    } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  } as Env;
}

function request(path: string, init: RequestInit = {}): Request {
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

function snapshotBody() {
  return {
    base: "USD",
    rates: { USD: 1, CNY: 7 },
    requestedProvider: "frankfurter",
    provider: "frankfurter",
    sourceDate: "2026-08-01",
  };
}

describe("exchange rate snapshot worker handlers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    authMocks.requireAuth.mockResolvedValue({ user: { id: USER_ID }, session: { id: "ses" } });
    dbMocks.nowIso.mockReturnValue("2026-08-06T12:00:00.000Z");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    authMocks.requireAuth.mockReset();
    dbMocks.nowIso.mockReset();
  });

  it("captures and lists the current month snapshot for the authenticated owner", async () => {
    const env = createEnv();
    const put = await putExchangeRateSnapshot(request(`/api/app/exchange-rate-snapshots/${currentMonth}`, {
      method: "PUT",
      body: JSON.stringify(snapshotBody()),
    }), env, currentMonth);
    expect(await readSuccessData(put)).toMatchObject({
      snapshot: {
        month: currentMonth,
        base: "USD",
        rates: { USD: 1, CNY: 7 },
        provider: "frankfurter",
      },
    });

    const list = await readExchangeRateSnapshots(request(`/api/app/exchange-rate-snapshots?from=${currentMonth}&to=${currentMonth}`), env);
    expect(await readSuccessData(list)).toMatchObject({
      snapshots: [{ month: currentMonth, rates: { USD: 1, CNY: 7 } }],
    });
  });

  it("rejects authenticated writes to closed historical report months", async () => {
    const env = createEnv();
    await expect(putExchangeRateSnapshot(request("/api/app/exchange-rate-snapshots/2000-01", {
      method: "PUT",
      body: JSON.stringify(snapshotBody()),
    }), env, "2000-01")).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST_PARAMETERS" });
  });
});
