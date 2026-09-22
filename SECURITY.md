# Security Policy

## Supported Versions

Security fixes are made on the latest published Renewlet release. Upgrade before reporting an issue that only affects an older release.

## Reporting a Vulnerability

Do not open a public issue for a vulnerability, leaked credential, or exploit details. Use GitHub's private vulnerability reporting page:

https://github.com/zhiyingzzhou/renewlet/security/advisories/new

Include the affected version and runtime (Docker or Cloudflare), reproduction steps, impact, and any logs with credentials, session cookies, tokens, webhook URLs, and account data removed. You should receive an initial response within seven days.

Renewlet is a self-hosted subscription ledger. The host administrator, Docker data directory, Cloudflare account, D1 database, and R2 bucket are trusted deployment boundaries; reports still need to show an unauthorized boundary crossing or a concrete data exposure.
