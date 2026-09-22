import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'

import {
  renderRobotsTxt,
  renderSitemapXml,
  replaceWebsiteMetadataPlaceholders,
  resolveWebsiteDeployment,
} from './src/lib/website-metadata.ts'
import { latestStableReleaseVersion } from './scripts/release-version.ts'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const deployment = resolveWebsiteDeployment(process.env)
const websiteSoftwareVersion = latestStableReleaseVersion()

function websiteMetadataPlugin(): Plugin {
  return {
    name: 'renewlet-website-metadata',
    transformIndexHtml(html) {
      return replaceWebsiteMetadataPlaceholders(html, deployment, { softwareVersion: websiteSoftwareVersion })
    },
    generateBundle() {
      // GitHub Pages 当前发布 URL 是官网路径事实来源；不要再把仓库名或自定义域写进静态文件。
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: renderRobotsTxt(deployment) })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: renderSitemapXml(deployment) })
    },
  }
}

export default defineConfig({
  base: deployment.viteBase,
  define: {
    __RENEWLET_WEBSITE_REPOSITORY_LINKS__: JSON.stringify(deployment.repositoryLinks),
  },
  build: {
    rollupOptions: {
      // 中文根路径与英文 /en/ 都是可索引 HTML 入口；不要退回只靠前端按钮切语言。
      input: {
        main: resolve(rootDir, 'index.html'),
        en: resolve(rootDir, 'en/index.html'),
      },
    },
  },
  plugins: [react(), tailwindcss(), websiteMetadataPlugin()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
    exclude: ['tests/**', 'node_modules/**'],
    clearMocks: true,
    restoreMocks: true,
  },
})
