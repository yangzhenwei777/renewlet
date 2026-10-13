// Free配额按invocation累计；batch中的每条SQL仍占一次，不能按往返次数计费。
export const CRON_SQL_LIMIT = 50;
export const CRON_EXTERNAL_REQUEST_LIMIT = 50;
const CRON_STORAGE_REQUEST_LIMIT = 1000;
export const CRON_SUBSCRIPTION_PAGE_SIZE = 50;
export const CRON_CLAIM_DURATION_MS = 15 * 60_000;

export class CronBudgetExceeded extends Error {
  constructor(readonly resource: "sql" | "external" | "storage") {
    super(`CRON_${resource.toUpperCase()}_BUDGET_EXCEEDED`);
    this.name = "CronBudgetExceeded";
  }
}

export class CronBudget {
  readonly used = { sql: 0, externalReserved: 0, externalRequests: 0, storageReserved: 0 };
  readonly #originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

  requireSql(count: number): void {
    if (this.used.sql + count > CRON_SQL_LIMIT) throw new CronBudgetExceeded("sql");
  }

  consumeSql(count: number, reserved = 0): void {
    this.requireSql(count + reserved);
    this.used.sql += count;
  }

  requireExternal(count: number): void {
    if (this.used.externalReserved + this.used.externalRequests + count > CRON_EXTERNAL_REQUEST_LIMIT) throw new CronBudgetExceeded("external");
  }

  consumeExternal(count: number): void {
    this.requireExternal(count);
    this.used.externalReserved += count;
  }

  consumeExternalRequest(): void {
    if (this.used.externalReserved + this.used.externalRequests >= CRON_EXTERNAL_REQUEST_LIMIT) throw new CronBudgetExceeded("external");
    this.used.externalRequests += 1;
  }

  consumeStorage(count: number): void {
    if (this.used.storageReserved + CRON_SQL_LIMIT + count > CRON_STORAGE_REQUEST_LIMIT) throw new CronBudgetExceeded("storage");
    this.used.storageReserved += count;
  }

  get remainingStorage(): number {
    return CRON_STORAGE_REQUEST_LIMIT - CRON_SQL_LIMIT - this.used.storageReserved;
  }

  database(database: D1Database, reserved = 0): D1Database {
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get: (target, property) => {
          if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
          if (property === "all" || property === "first" || property === "run" || property === "raw") {
            return (...args: unknown[]) => {
              this.consumeSql(1, reserved);
              return Reflect.apply(target[property], target, args) as unknown;
            };
          }
          return Reflect.get(target, property) as unknown;
        },
      });
      this.#originals.set(proxy, statement);
      return proxy;
    };
    return new Proxy(database, {
      get: (target, property) => {
        if (property === "prepare") return (sql: string) => wrap(target.prepare(sql));
        if (property === "batch") return (statements: D1PreparedStatement[]) => {
          this.consumeSql(statements.length, reserved);
          return target.batch(statements.map((statement) => this.#originals.get(statement) ?? statement));
        };
        // Cron业务只允许预编译语句；exec/新session会绕开本invocation的逐条预算。
        throw new Error(`CRON_DATABASE_OPERATION_UNSUPPORTED:${String(property)}`);
      },
    });
  }
}
