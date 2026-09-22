import { beforeEach, describe, expect, it } from "vitest";
import { listPasskeysForUser, mfaStatusForUser } from "./mfa";
import { ensureAccountSecuritySchema, resetAccountSecuritySchemaForTest, withAccountSecuritySchema } from "./account-security-schema";
import type { Env, PasskeyCredentialRow } from "./types";

const USER_ID = "usr_schema";

describe("Cloudflare account security schema readiness", () => {
  beforeEach(() => {
    resetAccountSecuritySchemaForTest();
  });

  it("repairs missing account security tables before returning MFA status", async () => {
    const env = createEnv({ accountSecurityTablesReady: false });

    const status = await mfaStatusForUser(env, USER_ID);

    expect(status).toEqual({
      enabled: false,
      methods: [],
      recoveryCodesRemaining: 0,
      passkeyCount: 0,
    });
    expect(env.__state.accountSecurityTablesReady).toBe(true);
    expect(env.__state.accountSecuritySchemaBatches).toBe(1);
  });

  it("repairs missing passkey tables before listing passkeys", async () => {
    const env = createEnv({ accountSecurityTablesReady: false });

    const response = await listPasskeysForUser(env, USER_ID);

    expect(response).toEqual({ passkeys: [] });
    expect(env.__state.accountSecurityTablesReady).toBe(true);
    expect(env.__state.accountSecuritySchemaBatches).toBe(1);
  });

  it("does not run DDL on healthy account security queries", async () => {
    const env = createEnv({
      accountSecurityTablesReady: true,
      passkeys: [passkeyRow({ id: "pkey_touchid", name: "MacBook Touch ID" })],
    });

    const status = await mfaStatusForUser(env, USER_ID);
    const passkeys = await listPasskeysForUser(env, USER_ID);

    expect(status.passkeyCount).toBe(1);
    expect(passkeys.passkeys).toEqual([{ id: "pkey_touchid", name: "MacBook Touch ID", createdAt: "2026-06-22T00:00:00.000Z" }]);
    expect(env.__state.accountSecuritySchemaBatches).toBe(0);
  });

  it("deduplicates concurrent first-time account security repairs", async () => {
    const env = createEnv({ accountSecurityTablesReady: false, schemaDelayMs: 5 });

    await Promise.all([
      mfaStatusForUser(env, USER_ID),
      listPasskeysForUser(env, USER_ID),
    ]);

    expect(env.__state.accountSecurityTablesReady).toBe(true);
    expect(env.__state.accountSecuritySchemaBatches).toBe(1);
  });

  it("does not mark schema ready when runtime DDL fails", async () => {
    const env = createEnv({
      accountSecurityTablesReady: false,
      schemaError: new Error("D1_ERROR: permission denied"),
    });

    await expect(mfaStatusForUser(env, USER_ID)).rejects.toMatchObject({
      name: "AccountSecuritySchemaError",
      message: "D1_ERROR: permission denied",
    });
    expect(env.__state.accountSecurityTablesReady).toBe(false);
    expect(env.__state.accountSecuritySchemaBatches).toBe(1);

    env.__state.schemaError = null;
    await expect(mfaStatusForUser(env, USER_ID)).resolves.toMatchObject({ passkeyCount: 0 });
    expect(env.__state.accountSecuritySchemaBatches).toBe(2);
  });

  it("ignores non-account-security missing tables", async () => {
    const env = createEnv({ accountSecurityTablesReady: true });

    await expect(withAccountSecuritySchema(env, async () => {
      throw new Error("D1_ERROR: no such table: subscriptions: SQLITE_ERROR");
    })).rejects.toThrow("subscriptions");
    expect(env.__state.accountSecuritySchemaBatches).toBe(0);
  });

  it("allows explicit readiness checks to share the cached schema promise", async () => {
    const env = createEnv({ accountSecurityTablesReady: false });

    await ensureAccountSecuritySchema(env);
    await ensureAccountSecuritySchema(env);

    expect(env.__state.accountSecurityTablesReady).toBe(true);
    expect(env.__state.accountSecuritySchemaBatches).toBe(1);
  });
});

type TestEnv = Env & {
  __state: AccountSecuritySchemaTestState;
};

interface AccountSecuritySchemaTestState {
  accountSecuritySchemaBatches: number;
  accountSecurityTablesReady: boolean;
  passkeys: PasskeyCredentialRow[];
  recoveryCodesRemaining: number;
  schemaDelayMs: number;
  schemaError: Error | null;
  totpEnabled: boolean;
}

interface TestEnvOptions {
  accountSecurityTablesReady?: boolean;
  passkeys?: PasskeyCredentialRow[];
  recoveryCodesRemaining?: number;
  schemaDelayMs?: number;
  schemaError?: Error | null;
  totpEnabled?: boolean;
}

function createEnv(options: TestEnvOptions = {}): TestEnv {
  const state: AccountSecuritySchemaTestState = {
    accountSecuritySchemaBatches: 0,
    accountSecurityTablesReady: options.accountSecurityTablesReady ?? true,
    passkeys: options.passkeys ?? [],
    recoveryCodesRemaining: options.recoveryCodesRemaining ?? 0,
    schemaDelayMs: options.schemaDelayMs ?? 0,
    schemaError: options.schemaError ?? null,
    totpEnabled: options.totpEnabled ?? false,
  };
  return {
    DB: new AccountSecuritySchemaTestDB(state) as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
    __state: state,
  };
}

function passkeyRow(overrides: Partial<PasskeyCredentialRow> = {}): PasskeyCredentialRow {
  return {
    id: "pkey_1",
    user_id: USER_ID,
    name: "Security Key",
    credential_id: "credential-id",
    public_key: "public-key",
    credential_json: "{}",
    counter: 0,
    transports_json: "[]",
    created_at: "2026-06-22T00:00:00.000Z",
    updated_at: "2026-06-22T00:00:00.000Z",
    ...overrides,
  };
}

class AccountSecuritySchemaTestDB {
  constructor(private readonly state: AccountSecuritySchemaTestState) {}

  prepare(sql: string) {
    return new AccountSecuritySchemaTestStatement(this.state, sql);
  }

  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.state.accountSecuritySchemaBatches += 1;
    for (const statement of statements) await statement.run();
    if (this.state.schemaDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.state.schemaDelayMs));
    return statements.map(() => d1Result([]));
  }
}

class AccountSecuritySchemaTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: AccountSecuritySchemaTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM mfa_totp_credentials")) {
      this.assertAccountSecurityTablesReady("mfa_totp_credentials");
      return this.state.totpEnabled ? { user_id: this.values[0] } as T : null;
    }
    if (this.sql.includes("FROM mfa_recovery_codes") && this.sql.includes("COUNT(*) AS count")) {
      this.assertAccountSecurityTablesReady("mfa_recovery_codes");
      return { count: this.state.recoveryCodesRemaining } as T;
    }
    if (this.sql.includes("FROM passkey_credentials") && this.sql.includes("COUNT(*) AS count")) {
      this.assertAccountSecurityTablesReady("passkey_credentials");
      return { count: this.state.passkeys.length } as T;
    }
    return null;
  }

  async all<T>(): Promise<D1Result<T>> {
    if (this.sql.includes("FROM passkey_credentials")) {
      this.assertAccountSecurityTablesReady("passkey_credentials");
      return d1Result(this.state.passkeys as T[]);
    }
    return d1Result([]);
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("CREATE TABLE IF NOT EXISTS") || this.sql.includes("CREATE INDEX IF NOT EXISTS")) {
      if (this.state.schemaError) throw this.state.schemaError;
      this.state.accountSecurityTablesReady = true;
    }
    return d1Result([]);
  }

  private assertAccountSecurityTablesReady(table: string): void {
    if (!this.state.accountSecurityTablesReady) {
      throw new Error(`D1_ERROR: no such table: ${table}: SQLITE_ERROR`);
    }
  }
}

function d1Result<T>(results: T[]): D1Result<T> {
  return {
    results,
    success: true,
    meta: {},
  } as D1Result<T>;
}
