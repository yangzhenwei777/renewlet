## Change

Describe the problem and the final design. Renewlet uses complete contract switches; list any removed API, schema, or code path instead of adding compatibility branches.

## Runtime impact

- Affected runtime(s): Docker / Cloudflare / Web / shared
- Dataset used: subscriptions, unique tags, assets, import items
- Resource result: SQL or D1 operations, RSS/isolate trend, duration, gzip/brotli when relevant
- Breaking contract or migration: yes/no, with deployment and recovery order

## Verification

List the exact commands run and their results. For cross-runtime changes include route/schema parity; for D1 changes include local migration and foreign-key checks. Confirm that logs, fixtures, and screenshots contain no secrets or private subscription data.
