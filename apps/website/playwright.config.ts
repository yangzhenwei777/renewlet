import { defineConfig } from '@playwright/test'

const websiteUrl = process.env.RENEWLET_WEBSITE_E2E_URL ?? 'http://127.0.0.1:4173'
const websiteServer = new URL(websiteUrl)
const websiteHost = websiteServer.hostname
const websitePort = websiteServer.port || (websiteServer.protocol === 'https:' ? '443' : '80')

export default defineConfig({
  testDir: './tests',
  // 官网视觉截图按项目和用例隔离，避免移动/桌面 golden 互相覆盖。
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: false,
  use: {
    baseURL: websiteUrl,
    headless: true,
  },
  projects: [
    {
      name: 'local-desktop',
      use: {
        baseURL: websiteUrl,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'local-mobile',
      use: {
        baseURL: websiteUrl,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    // 严格复用指定端口，确保 RENEWLET_WEBSITE_E2E_URL 指向的就是当前被测站点。
    command: `pnpm exec vite --host ${websiteHost} --port ${websitePort} --strictPort`,
    url: websiteUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
})
