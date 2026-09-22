# Renewlet Website

Renewlet 官网静态站，使用 Vite、React、TypeScript 和 Tailwind CSS 构建。它只发布 `apps/website/dist`，不部署 Renewlet 产品 API，也不需要 D1、R2、PocketBase、通知密钥或 Worker bindings。

## 开发

```bash
pnpm --filter @renewlet/website dev
```

## 验证

```bash
pnpm check:website
pnpm build:website
```

等价的包内命令：

```bash
pnpm --filter @renewlet/website lint
pnpm --filter @renewlet/website test
pnpm --filter @renewlet/website build
pnpm --filter @renewlet/website test:e2e
```

## GitHub Pages

仓库提供 `.github/workflows/website-pages.yml`。它只在官网相关文件变化时触发，构建并发布 `apps/website/dist`。

1. 在 GitHub 仓库中打开 `Settings` -> `Pages`。
2. `Build and deployment` 的 source 选择 `GitHub Actions`。
3. 推送到 `main`，或手动运行 `Website Pages` workflow。

workflow 会先运行 `actions/configure-pages`，再把 GitHub Pages 当前配置里的 `base_url` 和 `base_path` 交给 Vite。自定义域会构建成根路径资源，默认仓库页会构建成仓库子路径资源。

本地模拟自定义域构建：

```bash
RENEWLET_WEBSITE_BASE_URL=https://renewlet.cc RENEWLET_WEBSITE_BASE_PATH= pnpm --filter @renewlet/website build
pnpm --filter @renewlet/website preview
```

本地模拟默认仓库页构建：

```bash
RENEWLET_WEBSITE_BASE_URL=https://zhiyingzzhou.github.io/renewlet RENEWLET_WEBSITE_BASE_PATH=/renewlet pnpm --filter @renewlet/website build
pnpm --filter @renewlet/website preview
```

`apps/website/vite.config.ts` 不判断部署平台名称，只消费 Pages 当前发布 URL；切换自定义域或默认域名后重新运行 workflow 即可得到匹配的资源路径。

## Cloudflare Pages

Cloudflare Pages 只部署静态站，不使用 Wrangler，也不绑定 Renewlet Worker 的 D1/R2/Cron。

Dashboard 配置：

| Field | Value |
| --- | --- |
| Root directory | `apps/website` |
| Build command | `pnpm install --frozen-lockfile && pnpm build` |
| Build output directory | `dist` |
| Node.js version | `24` |

如果从仓库根目录构建：

| Field | Value |
| --- | --- |
| Root directory | 留空或仓库根目录 |
| Build command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @renewlet/website build` |
| Build output directory | `apps/website/dist` |

Cloudflare Pages 默认部署到域名根路径，Vite `base` 保持 `/`。

## Docker 静态站

官网提供独立静态镜像：Node 构建 `dist`，NGINX 服务静态文件。

从仓库根目录构建：

```bash
docker build -f apps/website/Dockerfile -t renewlet-website .
docker run --rm -p 4180:8080 renewlet-website
```

打开：

```text
http://localhost:4180
```

Compose：

```bash
cd apps/website
docker compose up --build
```

NGINX 配置在 `apps/website/nginx.conf`：

- `/assets/*` 使用一年 immutable 缓存。
- `/index.html` 使用 no-cache。
- 深链刷新 fallback 到 `/index.html`。

## 常见问题

- GitHub Pages 页面空白或资源 404：确认 workflow 里的 `actions/configure-pages` 输出了符合当前 Pages 设置的 `base_url` 和 `base_path`。
- Cloudflare Pages 资源 404：确认没有设置 `RENEWLET_WEBSITE_BASE_PATH=/renewlet` 这类 GitHub Pages 仓库子路径。
- Docker 深链刷新 404：确认镜像使用 `apps/website/nginx.conf`，并且 `location /` fallback 到 `/index.html`。
- 修改截图或字体后仍看到旧资源：重新构建并清理部署平台缓存。
