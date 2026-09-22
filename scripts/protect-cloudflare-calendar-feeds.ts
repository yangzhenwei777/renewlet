#!/usr/bin/env node
/**
 * migration runner 的跨进程 Feed 保护入口。prepare/restore 必须显式指向同一 D1，进度只以数据库持久状态为准。
 */
import {
  prepareCalendarFeedsFor0035,
  restoreCalendarFeedsAfter0035,
} from "./cloudflare-calendar-feed-upgrade";
import { createD1OperationsClient, type D1TargetOptions } from "./cloudflare-d1-operations";

interface Options extends D1TargetOptions {
  phase: "prepare" | "restore";
}

function parseArgs(argv: string[]): Options {
  let target: Options["target"] | undefined;
  let phase: Options["phase"] | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local" || argument === "--remote") {
      if (target) throw new Error("Specify exactly one D1 target: --local or --remote");
      target = argument === "--local" ? "local" : "remote";
      continue;
    }
    if (argument === "--phase") {
      const value = argv[index + 1];
      if (value !== "prepare" && value !== "restore") throw new Error("--phase requires prepare or restore");
      phase = value;
      index += 1;
      continue;
    }
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!target) throw new Error("Calendar Feed protection requires an explicit --local or --remote target");
  if (!phase) throw new Error("Calendar Feed protection requires --phase prepare or --phase restore");
  return configPath === undefined ? { target, phase } : { target, phase, configPath };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = createD1OperationsClient(options);
  const result = options.phase === "prepare"
    ? await prepareCalendarFeedsFor0035(client)
    : await restoreCalendarFeedsAfter0035(client);
  console.log(`Cloudflare calendar Feed ${options.phase}: ${result.action}, feeds=${result.feeds}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
