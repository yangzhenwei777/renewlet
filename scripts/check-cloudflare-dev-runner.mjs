import { readFileSync } from "node:fs";
import { join } from "node:path";

export function checkCloudflareDevRunner(repoRoot) {
  const source = readFileSync(join(repoRoot, "scripts/cloudflare-dev-wrangler.mjs"), "utf8");
  for (const snippet of [
    'const SYSTEM_PROXY_OPT_IN = "RENEWLET_CLOUDFLARE_DEV_SYSTEM_PROXY"',
    'baseEnv[SYSTEM_PROXY_OPT_IN] !== "1"',
    "macOsSystemProxy()",
  ]) {
    if (!source.includes(snippet)) {
      throw new Error(`cloudflare-dev-wrangler.mjs must keep explicit macOS proxy opt-in snippet: ${snippet}`);
    }
  }
}
