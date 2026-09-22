# Contributing to Renewlet

Thanks for helping improve Renewlet. Issues, documentation fixes, tests, and pull requests are welcome.

## Local Setup

Renewlet is a pnpm workspace with a React/Vite client, a Go/PocketBase Docker server, a Cloudflare Worker runtime, and shared TypeScript schemas.

Requirements:

- Node.js `>=24.19.0 <25` or `>=26.5.0 <27`.
- pnpm 11.20.0 via Corepack.
- Go 1.26.6 for the Docker server.
- Docker Compose v2 for Docker deployment checks.

Node 24.19.0 LTS is the reproducible Docker and release baseline. The CI quality matrix also runs on Node 26.5.0 so contributors can use the current even-numbered release without engine warnings; EOL Node 25 and untested Node 27+ are not supported.

Check the toolchain before installing dependencies:

```bash
node --version       # v24.19.x or >=v26.5.0 <v27
corepack pnpm --version  # 11.20.0
go version           # go1.26.6
```

Install dependencies from the repository root:

```bash
corepack enable
pnpm install --frozen-lockfile
```

Useful development commands:

```bash
pnpm --filter @renewlet/client dev
pnpm --dir apps/docker-server start
pnpm dev:cloudflare
```

Cloudflare local development uses direct network access by default. On macOS, set `RENEWLET_CLOUDFLARE_DEV_SYSTEM_PROXY=1` only when Worker upstream requests must use the active system HTTP/HTTPS proxy; Wrangler will then print its expected proxy-use notice.

## Quality Checks

Use the narrowest check that covers your change:

```bash
pnpm check:file-lines
pnpm check:deploy
pnpm check:public-api-docs
pnpm check:route-parity
pnpm lint
pnpm --filter @renewlet/client test:run
pnpm --dir apps/docker-server test
pnpm check:cloudflare
pnpm test:scripts
pnpm test:perf
pnpm build:all
pnpm typecheck:scripts
pnpm typecheck:all
pnpm typecheck:e2e
pnpm test:e2e
```

Before opening a pull request, run the relevant type checks and tests. Root operations scripts must pass both `pnpm typecheck:scripts` and `pnpm test:scripts`; `pnpm typecheck:all` is the complete monorepo type gate. For cross-runtime API/schema work, run the Docker server, client, and Cloudflare checks together.

Performance changes must report the affected dataset size and operation count. Client builds enforce the committed gzip/brotli budgets; do not raise a budget without attaching the new build output and explaining the user-visible tradeoff.

## Public API Docs

The Public API documentation is generated. Do not edit `docs/public-api.openapi.json` or `docs/public-api.md` by hand.

When Public API schemas or routes change, update the shared endpoint registry and run:

```bash
pnpm generate:public-api-docs
pnpm check:public-api-docs
```

The generator compares the registry with both Go and Cloudflare Worker `/api/public/v1/*` route registrations so one runtime cannot drift from the documented contract.

## Playwright E2E

Release smoke tests live in `e2e/release-smoke.spec.ts` and `e2e/mobile-release-smoke.spec.ts`. They cover setup/login state, mobile primary pages, Renewlet ZIP import, mocked AI SSE import, and account password change/re-login.

Run the smoke suite locally with:

```bash
pnpm typecheck:e2e
pnpm exec playwright test e2e/release-smoke.spec.ts e2e/mobile-release-smoke.spec.ts
```

The full Playwright suite still runs through `pnpm test:e2e`. AI provider calls in E2E must stay mocked so the release gate does not depend on third-party secrets, quota, or network behavior.

## Code Style

- Keep API contracts in shared Zod schemas when they cross the client, Go server, and Worker runtimes.
- Keep user-visible client text in Lingui catalogs.
- Do not hard-code secrets, real credentials, or private deployment data.
- Add comments only for business intent, historical workarounds, implicit constraints, or core state transitions. Avoid comments that restate ordinary syntax.
- Document exported Go APIs with Go doc comments and cross-module TypeScript helpers with TSDoc when callers need non-obvious guarantees, side effects, or failure behavior.
- Explain Cloudflare/D1/R2, Docker, retry, concurrency, and recovery ordering at the boundary where the platform constraint matters; test names should describe behavior without line-by-line fixture narration.
- Do not weaken strict JSON parsing, user isolation, CSRF/session boundaries, private asset checks, or Public API bearer-token separation.

## Pull Requests

For larger changes, open an issue first with the goal, user-facing behavior, and rough approach. Keep pull requests focused on one problem area, include tests for behavior changes, and mention any checks you could not run.
