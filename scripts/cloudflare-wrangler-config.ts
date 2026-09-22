import { readFileSync, writeFileSync } from "node:fs";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type WranglerConfig = { [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is WranglerConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readWranglerConfig(path: string): WranglerConfig {
  const errors: ParseError[] = [];
  const value: unknown = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  const [firstError] = errors;
  if (firstError) {
    throw new Error(`${path} contains invalid JSONC: ${printParseErrorCode(firstError.error)}`);
  }
  if (!isJsonObject(value)) throw new Error(`${path} must contain a Wrangler JSON object`);
  return value;
}

export function writeWranglerConfig(path: string, config: WranglerConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 维护配置保留 bundle、Static Assets、producer 和存储 binding，只停止会产生后台 D1 写入的触发器。 */
export function createMaintenanceWranglerConfig(source: WranglerConfig): WranglerConfig {
  const config = structuredClone(source);
  const vars = isJsonObject(config["vars"]) ? config["vars"] : {};
  config["vars"] = { ...vars, RENEWLET_MAINTENANCE_MODE: "true" };

  if (isJsonObject(config["triggers"])) {
    const triggers = { ...config["triggers"] };
    delete triggers["crons"];
    if (Object.keys(triggers).length === 0) delete config["triggers"];
    else config["triggers"] = triggers;
  }

  const queues = isJsonObject(config["queues"]) ? config["queues"] : {};
  config["queues"] = { ...queues, consumers: [] };
  return config;
}

export function writeWranglerConfigPair(normalPath: string, maintenancePath: string, normal: WranglerConfig): void {
  writeWranglerConfig(normalPath, normal);
  writeWranglerConfig(maintenancePath, createMaintenanceWranglerConfig(normal));
}
