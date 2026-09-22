import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

function isDesktopProject(projectName: string) {
  return projectName.includes('desktop')
}

async function stabilizePage(page: Page) {
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        caret-color: transparent !important;
        animation: none !important;
        transition: none !important;
        scroll-behavior: auto !important;
      }

      canvas,
      [id*="tsparticles"],
      [class*="tsparticles"] {
        opacity: 0 !important;
      }
    `,
  })

  await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'))
    canvases.forEach((canvas) => {
      const context = canvas.getContext('2d')
      context?.clearRect(0, 0, canvas.width, canvas.height)
    })
  })

  await page.waitForLoadState('networkidle')
  await page.waitForFunction(() => document.fonts?.status === 'loaded')
  await page.waitForTimeout(600)
}

function localLocators(page: Page) {
  return {
    hero: page.locator('[data-section="hero"]'),
    intro: page.locator('[data-section="intro"]'),
    features: page.locator('[data-section="features"]'),
    runtime: page.locator('[data-section="genius"]'),
    cta: page.locator('[data-section="cta"]'),
    footer: page.locator('[data-section="footer"]'),
    cards: [
      page.locator('[data-card="ai-recognition"]'),
      page.locator('[data-card="subscriptions"]'),
      page.locator('[data-card="public-status"]'),
      page.locator('[data-card="reminders"]'),
      page.locator('[data-card="calendar"]'),
      page.locator('[data-card="statistics"]'),
    ],
    runtimeCards: [
      page.locator('[data-card="docker"]'),
      page.locator('[data-card="cloudflare"]'),
    ],
    dialogSurface: page.locator('[data-dialog="deploy"]'),
  }
}

async function expectSectionScreenshot(locator: Locator, name: string) {
  await expect.soft(locator).toHaveScreenshot(name, {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01,
  })
}

test.describe('website visual coverage @visual', () => {
  test('captures stable Renewlet website surfaces', async ({ page }, testInfo) => {
    await page.goto('/#intro')
    await stabilizePage(page)

    const local = localLocators(page)
    const suffix = isDesktopProject(testInfo.project.name) ? 'desktop' : 'mobile'

    await expectSectionScreenshot(local.hero, `renewlet-hero-${suffix}.png`)
    await expectSectionScreenshot(local.intro, `renewlet-intro-${suffix}.png`)
    await expectSectionScreenshot(local.features, `renewlet-features-${suffix}.png`)
    await expectSectionScreenshot(local.runtime, `renewlet-runtime-${suffix}.png`)
    await expectSectionScreenshot(local.cta, `renewlet-cta-${suffix}.png`)
    await expectSectionScreenshot(local.footer, `renewlet-footer-${suffix}.png`)

    for (let index = 0; index < local.cards.length; index += 1) {
      await expectSectionScreenshot(local.cards[index], `renewlet-feature-card-${index + 1}-${suffix}.png`)
    }

    for (let index = 0; index < local.runtimeCards.length; index += 1) {
      await expectSectionScreenshot(local.runtimeCards[index], `renewlet-runtime-card-${index + 1}-${suffix}.png`)
    }

    await page.getByRole('button', { name: /选择部署方式/i }).click()
    await expect(local.dialogSurface).toBeVisible()
    await expectSectionScreenshot(local.dialogSurface, `renewlet-deploy-dialog-${suffix}.png`)
    await page.getByRole('button', { name: /关闭/i }).click()
    await expect(local.dialogSurface).not.toBeVisible()

    await expect.soft(page).toHaveScreenshot(`renewlet-home-${suffix}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    })

    await page.getByRole('banner').getByRole('button', { name: /Switch to English/i }).click()
    await stabilizePage(page)
    await expectSectionScreenshot(local.hero, `renewlet-hero-en-${suffix}.png`)
    await expectSectionScreenshot(local.intro, `renewlet-intro-en-${suffix}.png`)
    await expectSectionScreenshot(local.features, `renewlet-features-en-${suffix}.png`)
    await expectSectionScreenshot(local.runtime, `renewlet-runtime-en-${suffix}.png`)
    await expectSectionScreenshot(local.cta, `renewlet-cta-en-${suffix}.png`)
    await expect.soft(page).toHaveScreenshot(`renewlet-home-en-${suffix}.png`, {
      animations: 'disabled',
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    })
  })
})
