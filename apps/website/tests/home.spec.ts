import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

import {
  renewletImageManifest,
  screenshotName,
  screenshotViewport,
  type ScreenshotKey,
} from '../src/lib/renewlet-image-assets'

const dashboardViewport = screenshotViewport('dashboard')
const dashboardRetinaWidth = dashboardViewport.websiteWidths[1]
const notificationsH5Viewport = screenshotViewport('notifications-h5')
const [notificationsH5Width, notificationsH5RetinaWidth] = notificationsH5Viewport.websiteWidths
const desktopViewport = {
  width: renewletImageManifest.viewports.desktop.width,
  height: renewletImageManifest.viewports.desktop.height,
}
const featureScreenshotKeys: ScreenshotKey[] = ['ai-recognition', 'subscriptions', 'public-status', 'calendar', 'statistics']

function retinaName(key: ScreenshotKey, suffix: 'zh' | 'en') {
  return screenshotName(key, suffix)
}

function retinaCandidate(key: ScreenshotKey, suffix: 'zh' | 'en') {
  return `${retinaName(key, suffix)}-${dashboardRetinaWidth}`
}

async function expectLocalizedScreenshots(page: Page, suffix: 'zh' | 'en') {
  const otherSuffix = suffix === 'zh' ? 'en' : 'zh'
  const heroPicture = page.locator('[data-responsive-image="hero-dashboard"]')
  const dashboard = retinaName('dashboard', suffix)
  const notificationsH5 = retinaName('notifications-h5', suffix)
  const phonePicture = page.locator('[data-responsive-image="feature-phone"]')

  await expect(heroPicture.locator('source[type="image/avif"]')).toHaveAttribute(
    'srcset',
    new RegExp(`${dashboard}-${dashboardRetinaWidth}\\.avif ${dashboardRetinaWidth}w`),
  )
  await expect(heroPicture.locator('source[type="image/webp"]')).toHaveAttribute(
    'srcset',
    new RegExp(`${dashboard}-${dashboardRetinaWidth}\\.webp ${dashboardRetinaWidth}w`),
  )
  await expect(heroPicture.locator('img')).toHaveAttribute(
    'srcset',
    new RegExp(`${dashboard}-2x\\.png ${dashboardRetinaWidth}w`),
  )

  const featureSources = await page.locator('[data-section="features"] source, [data-section="features"] img').evaluateAll(
    (nodes) =>
      nodes
        .map((node) => `${node.getAttribute('srcset') ?? ''} ${node.getAttribute('src') ?? ''}`.trim())
        .filter(Boolean),
  )

  for (const key of featureScreenshotKeys) {
    expect(featureSources.some((value) => value.includes(screenshotName(key, suffix)))).toBe(true)
    expect(featureSources.some((value) => value.includes(screenshotName(key, otherSuffix)))).toBe(false)
  }

  expect(featureSources.some((value) => value.includes(screenshotName('notifications-h5', suffix)))).toBe(true)
  expect(featureSources.some((value) => value.includes(screenshotName('notifications-h5', otherSuffix)))).toBe(false)
  expect(featureSources.some((value) => value.includes(`${notificationsH5}-1400`))).toBe(false)
  expect(featureSources.some((value) => value.includes(`${notificationsH5}-2800`))).toBe(false)

  await expect(phonePicture.locator('source[type="image/avif"]')).toHaveAttribute(
    'srcset',
    new RegExp(
      `${notificationsH5}-${notificationsH5Width}\\.avif ${notificationsH5Width}w, .*${notificationsH5}-${notificationsH5RetinaWidth}\\.avif ${notificationsH5RetinaWidth}w`,
    ),
  )
  await expect(phonePicture.locator('source[type="image/webp"]')).toHaveAttribute(
    'srcset',
    new RegExp(
      `${notificationsH5}-${notificationsH5Width}\\.webp ${notificationsH5Width}w, .*${notificationsH5}-${notificationsH5RetinaWidth}\\.webp ${notificationsH5RetinaWidth}w`,
    ),
  )
  await page.locator('[data-card="reminders"]').scrollIntoViewIfNeeded()
  await page.waitForFunction(
    (candidate) => {
      const image = document.querySelector('[data-responsive-image="feature-phone"] img')
      return (
        image instanceof HTMLImageElement &&
        image.complete &&
        image.naturalWidth > 0 &&
        image.currentSrc.includes(candidate)
      )
    },
    notificationsH5,
  )
}

async function expectExternalLink(link: Locator) {
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
}

test('renders the Renewlet homepage and opens deployment dialog from both entry points', async ({ page }) => {
  await page.goto('/')
  const header = page.getByRole('banner')

  await expect(page.getByRole('heading', { name: /别再让续费悄悄扣走预算/i })).toBeVisible()
  await expect(header.getByRole('link', { name: /Renewlet home/i })).toHaveAttribute('href', '/')
  await expect(header.getByRole('link', { name: /^文档$/i })).toBeVisible()
  await expect(header.getByRole('link', { name: /^GitHub$/i })).toBeVisible()
  await expect(header.getByRole('button', { name: /Switch to English/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /选择部署方式/i })).toHaveCount(1)
  const demoLink = page.getByRole('link', { name: /尝试在线演示/i })
  await expect(demoLink).toHaveAttribute('href', 'https://demo.renewlet.cc/')
  await expectExternalLink(demoLink)
  await expect(page.getByText(/演示账号 demo@renewlet\.local \/ renewlet-demo/)).toBeVisible()
  await expect(page.getByText(/数据会定期重置，请勿放真实个人信息或真实凭据/)).toBeVisible()
  const footer = page.locator('[data-section="footer"]')
  await expect(footer.getByRole('link', { name: /^GitHub$/i })).toBeVisible()
  await expect(footer.getByRole('link', { name: /^Docker$/i })).toBeVisible()
  await expect(footer.getByRole('link', { name: /^Cloudflare$/i })).toHaveAttribute(
    'href',
    /docs\/cloudflare-workers-deploy\.zh-CN\.md/,
  )
  await expect(footer.getByRole('link', { name: /^License$/i })).toBeVisible()
  for (const linkName of [/^GitHub$/i, /^Docker$/i, /^Cloudflare$/i, /^License$/i]) {
    await expectExternalLink(footer.getByRole('link', { name: linkName }))
  }
  await expect(footer.getByRole('link', { name: /中文 README|英文 README|MIT License/i })).toHaveCount(0)

  for (const card of ['ai-recognition', 'subscriptions', 'public-status', 'reminders', 'calendar', 'statistics']) {
    await expect(page.locator(`[data-card="${card}"]`)).toBeVisible()
    await expect(page.locator(`[data-scene="${card}"]`)).toBeVisible()
  }
  await expect(page.locator('img[src*="/assets/cobalt/images/"]')).toHaveCount(0)

  await expectLocalizedScreenshots(page, 'zh')

  await expect(page.locator('[data-responsive-image="feature-screenshot"] source[type="image/avif"]')).toHaveCount(5)
  await expect(page.locator('[data-responsive-image="feature-phone"] source[type="image/avif"]')).toHaveCount(1)

  await page.getByRole('button', { name: /选择部署方式/i }).click()
  await expect(page.getByRole('heading', { name: /选择 Renewlet 部署方式/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /Docker 单容器/i })).toBeVisible()
  await expect(page.getByRole('link', { name: /Cloudflare Workers/i })).toHaveAttribute(
    'href',
    /docs\/cloudflare-workers-deploy\.zh-CN\.md/,
  )
  await expect(page.getByRole('link', { name: /源码仓库/i })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /官网静态部署/i })).toHaveCount(0)
  await page.getByRole('button', { name: /关闭/i }).click()
  await expect(page.getByRole('heading', { name: /选择 Renewlet 部署方式/i })).not.toBeVisible()

  await page.getByRole('button', { name: /查看部署方式/i }).click()
  await expect(page.getByRole('heading', { name: /选择 Renewlet 部署方式/i })).toBeVisible()
})

test('switches the homepage copy to English', async ({ page }) => {
  await page.goto('/')
  const header = page.getByRole('banner')

  await header.getByRole('button', { name: /Switch to English/i }).click()

  await expect(
    page.getByRole('heading', { name: /Catch renewals before they charge/i }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /Choose deployment/i })).toBeVisible()
  const demoLink = page.getByRole('link', { name: /Try live demo/i })
  await expect(demoLink).toHaveAttribute('href', 'https://demo.renewlet.cc/')
  await expectExternalLink(demoLink)
  await expect(page.getByText(/Demo account: demo@renewlet\.local \/ renewlet-demo/)).toBeVisible()
  await expect(page.getByText(/The demo resets regularly; do not enter real personal data or credentials/)).toBeVisible()
  await expect(header.getByRole('link', { name: /^Docs$/i })).toBeVisible()
  await expect(header.getByRole('link', { name: /^GitHub$/i })).toBeVisible()
  await expectLocalizedScreenshots(page, 'en')
})

test('requests the Chinese retina hero candidate on high density screens', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: desktopViewport,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const requestedImages: string[] = []

  page.on('request', (request) => {
    if (request.resourceType() === 'image') {
      requestedImages.push(request.url())
    }
  })

  await page.goto('/')
  await expect(page.locator('[data-responsive-image="hero-dashboard"] img')).toBeVisible()
  await page.waitForFunction((candidate) => {
    const image = document.querySelector('[data-responsive-image="hero-dashboard"] img')
    return (
      image instanceof HTMLImageElement &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.currentSrc.includes(candidate)
    )
  }, retinaCandidate('dashboard', 'zh'))

  expect(requestedImages.some((url) => new RegExp(`${retinaCandidate('dashboard', 'zh')}\\.(avif|webp)$`).test(url))).toBe(true)
  await context.close()
})

test('requests the English retina hero candidate after switching language on high density screens', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: desktopViewport,
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()
  const requestedImages: string[] = []

  page.on('request', (request) => {
    if (request.resourceType() === 'image') {
      requestedImages.push(request.url())
    }
  })

  await page.goto('/')
  await expect(page.locator('[data-responsive-image="hero-dashboard"] img')).toBeVisible()
  requestedImages.length = 0

  await page.getByRole('banner').getByRole('button', { name: /Switch to English/i }).click()
  await expect(page.locator('[data-responsive-image="hero-dashboard"] source[type="image/avif"]')).toHaveAttribute(
    'srcset',
    new RegExp(`${retinaName('dashboard', 'en')}-${dashboardRetinaWidth}\\.avif ${dashboardRetinaWidth}w`),
  )
  await page.waitForFunction((candidate) => {
    const image = document.querySelector('[data-responsive-image="hero-dashboard"] img')
    return (
      image instanceof HTMLImageElement &&
      image.complete &&
      image.naturalWidth > 0 &&
      image.currentSrc.includes(candidate)
    )
  }, retinaCandidate('dashboard', 'en'))

  expect(requestedImages.some((url) => new RegExp(`${retinaCandidate('dashboard', 'en')}\\.(avif|webp)$`).test(url))).toBe(true)
  expect(requestedImages.some((url) => new RegExp(`${retinaCandidate('dashboard', 'zh')}\\.(avif|webp)$`).test(url))).toBe(false)
  await context.close()
})
