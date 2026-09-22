import type { LucideIcon } from 'lucide-react'
import {
  BarChart3,
  BellRing,
  CalendarClock,
  Cloud,
  Container,
  CreditCard,
  Eye,
  Sparkles,
} from 'lucide-react'

import type { WebsiteRepositoryLinks } from '../lib/website-metadata'

declare const __RENEWLET_WEBSITE_REPOSITORY_LINKS__: WebsiteRepositoryLinks

export type Locale = 'zh' | 'en'

export type LocalizedText = Record<Locale, string>
export type LocalizedUrl = string | LocalizedText
export type WebsiteLinks = WebsiteRepositoryLinks & {
  demo: string
}

export const locales: Record<Locale, { label: string; ariaLabel: string }> = {
  zh: { label: '中', ariaLabel: '切换到中文' },
  en: { label: 'EN', ariaLabel: 'Switch to English' },
}

export function createSiteLinks(repositoryLinks: WebsiteRepositoryLinks): WebsiteLinks {
  return {
    demo: 'https://demo.renewlet.cc/',
    ...repositoryLinks,
  }
}

export const links = createSiteLinks(__RENEWLET_WEBSITE_REPOSITORY_LINKS__)

export const copy = {
  nav: {
    blog: { zh: '文档', en: 'Docs' },
    github: { zh: 'GitHub', en: 'GitHub' },
  },
  hero: {
    eyebrow: { zh: 'Self-hosted renewal tracker', en: 'Self-hosted renewal tracker' },
    title: {
      zh: '别再让续费悄悄扣走预算',
      en: 'Catch renewals before they charge',
    },
    body: {
      zh: 'Renewlet 是一个自托管订阅账本，把 AI 辅助录入、订阅、续费日、预算、通知、日历和公开状态页放在同一个地方。适合小 VPS、NAS 和 homelab 长期运行。',
      en: 'Renewlet is a small self-hosted ledger for subscriptions. Add items with AI, track renewal dates, and share a public status page when you need one.',
    },
    secondaryCta: { zh: '选择部署方式', en: 'Choose deployment' },
    demoCta: { zh: '尝试在线演示', en: 'Try live demo' },
    demoNote: {
      zh: '演示账号 demo@renewlet.local / renewlet-demo。数据会定期重置，请勿放真实个人信息或真实凭据。',
      en: 'Demo account: demo@renewlet.local / renewlet-demo. The demo resets regularly; do not enter real personal data or credentials.',
    },
    learnMore: { zh: '看看它能管住什么', en: 'See what it tracks' },
    imageAlt: {
      zh: 'Renewlet 中文仪表盘，展示月度支出、近期订阅和支出分布',
      en: 'Renewlet dashboard showing monthly spend, recent subscriptions, and spending distribution',
    },
  },
  intro: {
    title: {
      zh: '订阅不是记一张表，而是知道下一次扣费会不会影响预算。',
      en: 'A list is not enough. Keep the next charge in view.',
    },
    body: {
      zh: 'Renewlet 可以从截图、备忘录或表格内容生成订阅草稿，也能记录每个周期性扣费的价格、币种、周期、续费日和付款方式，再把它们折算成月度/年度成本。',
      en: 'Paste notes, screenshots, or tables to draft subscriptions. Renewlet turns prices, cycles, dates, and payment methods into monthly and yearly cost.',
    },
    highlight: {
      zh: '它不替你做决定，只把该看到的账和提醒放到眼前。',
      en: 'You stay in control.',
    },
  },
  featuresHeading: {
    title: { zh: '该记的都在。多余的没有。', en: 'Track renewals without the clutter.' },
    body: {
      zh: '从 AI 识别添加到订阅清单、公开状态页、通知、日历和统计，Renewlet 把常驻自托管工具该做的部分做扎实。',
      en: 'AI entry, a clean ledger, public status pages, reminders, calendars, and spending charts stay in one quiet tool.',
    },
    highlight: { zh: '轻量、明确、长期可维护。', en: 'Small, explicit, maintainable.' },
  },
  runtimeHeading: {
    title: { zh: '两种运行方式，一套使用体验', en: 'Two runtimes. Same product.' },
    body: {
      zh: '你可以把它放在自己的 VPS/NAS，也可以用 Cloudflare 的边缘服务运行。前端体验保持一致，部署边界清楚。',
      en: 'Run Renewlet on a VPS or NAS, or deploy it on Cloudflare. The app stays the same; the hosting boundary stays clear.',
    },
    highlight: { zh: '自托管不应该难维护。', en: 'Self-hosting stays manageable.' },
  },
  cta: {
    title: {
      zh: '把下一次续费放回你的掌控里。',
      en: 'See the next renewal before it charges.',
    },
    body: {
      zh: '从 Docker 单容器开始，或者直接走 Cloudflare Workers。数据在你的环境里，提醒按你的时区发出。',
      en: 'Start with Docker or Cloudflare Workers. Your data stays in your environment, and reminders use your timezone.',
    },
    button: { zh: '查看部署方式', en: 'View deployment options' },
  },
  footer: {
    copyright: { zh: '© 2026 Renewlet contributors.', en: '© 2026 Renewlet contributors.' },
    note: {
      zh: 'Renewlet 是 MIT 许可的自托管开源项目。第三方服务 Logo、图标和名称仅用于帮助用户识别自己的订阅项目，不代表背书或合作关系。',
      en: 'Renewlet is a self-hosted open source project licensed under MIT. Third-party logos, icons, and names are used only to help users recognize their own subscriptions; they do not imply endorsement or affiliation.',
    },
  },
}

export type FeatureCard = {
  key: string
  icon: LucideIcon
  title: LocalizedText
  body: LocalizedText
  imageAlt: LocalizedText
  stats: Array<{ label: LocalizedText; value: string }>
}

export const featureCards: FeatureCard[] = [
  {
    key: 'ai-recognition',
    icon: Sparkles,
    title: { zh: 'AI 识别添加', en: 'AI-assisted entry' },
    body: {
      zh: '把账单截图、备忘录或表格内容整理成可编辑订阅草稿，确认后再导入。',
      en: 'Turn screenshots, notes, or tables into editable drafts. Review them before import.',
    },
    imageAlt: {
      zh: 'Renewlet AI 识别订阅弹窗',
      en: 'Renewlet AI recognition dialog',
    },
    stats: [
      { label: { zh: '输入', en: 'Inputs' }, value: '文字/图片' },
      { label: { zh: '草稿', en: 'Drafts' }, value: '可编辑' },
    ],
  },
  {
    key: 'subscriptions',
    icon: CreditCard,
    title: { zh: '订阅清单', en: 'Subscription ledger' },
    body: {
      zh: '名称、Logo、价格、币种、周期、续费日、状态、分类、付款方式、标签、网站和备注都能放在同一张账里。',
      en: 'Keep names, prices, cycles, renewal dates, status, tags, and notes in one ledger.',
    },
    imageAlt: {
      zh: 'Renewlet 订阅清单页面',
      en: 'Renewlet subscriptions page',
    },
    stats: [
      { label: { zh: '字段', en: 'Fields' }, value: '12+' },
      { label: { zh: '视图', en: 'Views' }, value: '2' },
    ],
  },
  {
    key: 'public-status',
    icon: Eye,
    title: { zh: '公开订阅状态页', en: 'Public status page' },
    body: {
      zh: '生成可分享的订阅状态页，按订阅控制可见内容，也可以隐藏金额。',
      en: 'Share a public status page. Choose visible items and hide prices when needed.',
    },
    imageAlt: {
      zh: 'Renewlet 公开订阅状态页',
      en: 'Renewlet public subscription status page',
    },
    stats: [
      { label: { zh: '分享', en: 'Sharing' }, value: 'URL' },
      { label: { zh: '金额', en: 'Prices' }, value: '可隐藏' },
    ],
  },
  {
    key: 'reminders',
    icon: BellRing,
    title: { zh: '续费前提醒', en: 'Renewal reminders' },
    body: {
      zh: '按用户自己的时区和提醒时间生成任务，支持提前天数、重复提醒、发送历史和失败重试。',
      en: 'Send renewal reminders in your timezone, with advance days, history, and retry handling.',
    },
    imageAlt: {
      zh: 'Renewlet 通知设置页面',
      en: 'Renewlet notification settings page',
    },
    stats: [
      { label: { zh: '渠道', en: 'Channels' }, value: '7' },
      { label: { zh: '时区', en: 'Timezone' }, value: 'IANA' },
    ],
  },
  {
    key: 'calendar',
    icon: CalendarClock,
    title: { zh: '日历订阅', en: 'Calendar feeds' },
    body: {
      zh: '全局私有 ICS Feed 和单订阅 Feed 都可以复制、下载或用 webcal 唤起系统日历。',
      en: 'Copy, download, or open private ICS feeds in calendar apps.',
    },
    imageAlt: {
      zh: 'Renewlet 续费日历页面',
      en: 'Renewlet renewal calendar page',
    },
    stats: [
      { label: { zh: 'Feed', en: 'Feeds' }, value: '2' },
      { label: { zh: '格式', en: 'Format' }, value: 'ICS' },
    ],
  },
  {
    key: 'statistics',
    icon: BarChart3,
    title: { zh: '支出统计', en: 'Spending overview' },
    body: {
      zh: '月度/年度成本、预算使用、分类占比、付款方式占比和多币种换算都按当前订阅实时汇总。',
      en: 'See monthly cost, budget use, category share, payment mix, and currency conversion.',
    },
    imageAlt: {
      zh: 'Renewlet 统计分析页面',
      en: 'Renewlet statistics page',
    },
    stats: [
      { label: { zh: '汇率源', en: 'Rate feeds' }, value: '2' },
      { label: { zh: '预算', en: 'Budget' }, value: '月/年' },
    ],
  },
]

export type RuntimeCard = {
  key: string
  icon: LucideIcon
  title: LocalizedText
  body: LocalizedText
  details: LocalizedText[]
}

export const runtimeCards: RuntimeCard[] = [
  {
    key: 'docker',
    icon: Container,
    title: { zh: 'Docker / NAS / VPS', en: 'Docker, NAS, or VPS' },
    body: {
      zh: '单容器运行 React 静态资源、Go/PocketBase 后端和 SQLite 数据库，数据持久化到 `data/`。',
      en: 'A single container serves the app, API, and SQLite data. Data persists under `data/`.',
    },
    details: [
      { zh: '部署脚本自动生成 `.env`、密钥和数据目录。', en: 'The deploy script creates `.env`, secrets, and data folders.' },
      { zh: '适合小 VPS、NAS 和 homelab 常驻运行。', en: 'Fits small VPS, NAS, and homelab installs.' },
      { zh: '页面顶部可以检查版本并触发更新。', en: 'The app header can check versions and start updates.' },
    ],
  },
  {
    key: 'cloudflare',
    icon: Cloud,
    title: { zh: 'Cloudflare Workers', en: 'Cloudflare Workers' },
    body: {
      zh: 'React 静态资源、Worker API、D1、R2 和 Cron Triggers 组成无 Go/PocketBase 服务器的运行面。',
      en: 'Static assets, Worker API, D1, R2, and Cron run without a Go/PocketBase server.',
    },
    details: [
      { zh: '适合已经使用 Cloudflare 的轻量部署。', en: 'Good for lightweight installs already on Cloudflare.' },
      { zh: 'D1 保存应用数据，R2 保存上传 Logo 和图标。', en: 'D1 stores app data; R2 stores uploaded logos and icons.' },
      { zh: 'Cron Triggers 负责通知调度。', en: 'Cron Triggers schedule notifications.' },
    ],
  },
]

export type DeployOption = {
  key: string
  icon: LucideIcon
  title: LocalizedText
  body: LocalizedText
  href: LocalizedUrl
  action: LocalizedText
}

export function createDeployOptions(siteLinks: Pick<WebsiteLinks, 'cloudflare' | 'docker'> = links): DeployOption[] {
  return [
    {
      key: 'docker',
      icon: Container,
      title: { zh: 'Docker 单容器', en: 'Single Docker container' },
      body: {
        zh: '适合 VPS、NAS 和 homelab，数据持久化到本机目录。',
        en: 'Best for VPS, NAS, and homelab installs with local persistent data.',
      },
      href: siteLinks.docker,
      action: { zh: '看 Docker 部署', en: 'Read Docker setup' },
    },
    {
      key: 'cloudflare',
      icon: Cloud,
      title: { zh: 'Cloudflare Workers', en: 'Cloudflare Workers' },
      body: {
        zh: '一键部署到 Cloudflare，升级按文档同步生成仓库。',
        en: 'One-click deploy to Cloudflare; update by syncing the generated repo.',
      },
      href: siteLinks.cloudflare,
      action: { zh: '查看 Cloudflare 部署', en: 'Read Cloudflare deploy' },
    },
  ]
}

export const deployOptions: DeployOption[] = createDeployOptions()

export function text(value: LocalizedText, locale: Locale) {
  return value[locale]
}

export function localizedUrl(value: LocalizedUrl, locale: Locale) {
  return typeof value === 'string' ? value : value[locale]
}
