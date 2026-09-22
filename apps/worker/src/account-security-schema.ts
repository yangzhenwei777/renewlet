import type { Env } from "./types";

type AccountSecuritySchemaState = {
  promise: Promise<void>;
};

export class AccountSecuritySchemaError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "account security schema is unavailable");
    this.name = "AccountSecuritySchemaError";
    Object.setPrototypeOf(this, AccountSecuritySchemaError.prototype);
  }
}

const ACCOUNT_SECURITY_TABLES = [
  "mfa_totp_credentials",
  "mfa_recovery_codes",
  "passkey_credentials",
  "mfa_auth_tickets",
  "passkey_challenges",
] as const;

let accountSecuritySchemaByDb = new WeakMap<D1Database, AccountSecuritySchemaState>();

export async function withAccountSecuritySchema<T>(env: Env, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isMissingAccountSecurityTable(error)) throw error;
    // 这里是 0023_mfa 的运行时兜底，不是旧表兼容：只在正式账号安全表缺失时补建，然后重试同一个操作一次。
    await ensureAccountSecuritySchema(env);
    return await operation();
  }
}

export async function ensureAccountSecuritySchema(env: Env): Promise<void> {
  const existing = accountSecuritySchemaByDb.get(env.DB);
  if (existing) return existing.promise;

  const state: AccountSecuritySchemaState = {
    promise: Promise.resolve(),
  };
  state.promise = Promise.resolve().then(async () => {
    await createAccountSecuritySchema(env);
  }).catch((error: unknown) => {
    if (accountSecuritySchemaByDb.get(env.DB) === state) accountSecuritySchemaByDb.delete(env.DB);
    throw new AccountSecuritySchemaError(error);
  });
  // DDL 只在缺表后懒触发；缓存 in-flight/成功状态，避免 MFA/Passkey 热路径反复跑 schema 检查或建表。
  accountSecuritySchemaByDb.set(env.DB, state);
  return await state.promise;
}

export function isAccountSecuritySchemaError(error: unknown): boolean {
  return error instanceof AccountSecuritySchemaError;
}

export function isMissingAccountSecurityTable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const pattern = ACCOUNT_SECURITY_TABLES.map(escapeRegExp).join("|");
  return new RegExp(`no such table:\\s*(?:${pattern})`, "i").test(error.message);
}

async function createAccountSecuritySchema(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS mfa_totp_credentials (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        secret_ciphertext TEXT NOT NULL,
        last_accepted_step INTEGER NOT NULL DEFAULT 0 CHECK (last_accepted_step >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash TEXT NOT NULL CHECK (length(code_hash) = 43),
        used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, code_hash)
      )
    `),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user_used ON mfa_recovery_codes (user_id, used_at)"),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS passkey_credentials (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
        credential_id TEXT NOT NULL UNIQUE,
        public_key TEXT NOT NULL,
        credential_json TEXT NOT NULL,
        counter INTEGER NOT NULL DEFAULT 0 CHECK (counter >= 0),
        transports_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_passkeys_user ON passkey_credentials (user_id, created_at DESC)"),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS mfa_auth_tickets (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ticket_hash TEXT NOT NULL UNIQUE CHECK (length(ticket_hash) = 43),
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 10),
        methods_json TEXT NOT NULL,
        payload_ciphertext TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_mfa_tickets_user_expires ON mfa_auth_tickets (user_id, expires_at)"),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS passkey_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        challenge_id_hash TEXT NOT NULL UNIQUE CHECK (length(challenge_id_hash) = 43),
        kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
        challenge TEXT NOT NULL,
        session_data_json TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_passkey_challenges_user_kind ON passkey_challenges (user_id, kind)"),
  ]);
}

export function resetAccountSecuritySchemaForTest(): void {
  accountSecuritySchemaByDb = new WeakMap<D1Database, AccountSecuritySchemaState>();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
