FROM node:24.19.0-alpine3.24 AS build

WORKDIR /repo

# 官网构建只需要 workspace 依赖图和 website 源码；不复制产品前后端源码，避免官网镜像把无关产物带进 build context。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/website/package.json apps/website/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/docker-server/package.json apps/docker-server/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN corepack enable && pnpm install --frozen-lockfile

COPY apps/website apps/website

RUN pnpm --filter @renewlet/website build

FROM nginx:1.30.4-alpine3.24

# Nginx 运行态降到固定 UID，方便容器平台用只读根文件系统或外部安全策略约束官网静态站。
RUN addgroup -S -g 1000 renewlet \
  && adduser -S -D -H -u 1000 -G renewlet renewlet \
  && mkdir -p /tmp/nginx \
  && chown -R renewlet:renewlet /var/cache/nginx /var/run /tmp/nginx /usr/share/nginx/html

COPY apps/website/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=renewlet:renewlet /repo/apps/website/dist /usr/share/nginx/html

USER renewlet
