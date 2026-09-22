import {
  BellRing,
  CalendarClock,
  CheckCircle2,
  Eye,
  EyeOff,
  Image,
  Link,
  Sparkles,
  Table2,
} from 'lucide-react'

import type { Locale } from '../content/site'
import { responsiveScreenshotAsset, screenshotName, type ScreenshotAsset } from '../lib/renewlet-image-assets'

type FeatureSceneProps = {
  locale: Locale
}

type SceneKey = 'ai-recognition' | 'subscriptions' | 'public-status' | 'reminders' | 'calendar' | 'statistics'

// 官网语言切换时，所有可见产品截图都必须同步切换，避免英文页面混入中文 UI。
function localizedImages(locale: Locale) {
  return {
    aiRecognition: responsiveScreenshotAsset(screenshotName('ai-recognition', locale), 'featureWide'),
    subscriptions: responsiveScreenshotAsset(screenshotName('subscriptions', locale)),
    publicStatus: responsiveScreenshotAsset(screenshotName('public-status', locale), 'featureWide'),
    reminders: responsiveScreenshotAsset(screenshotName('notifications-h5', locale), 'featurePhone'),
    calendar: responsiveScreenshotAsset(screenshotName('calendar', locale)),
    statistics: responsiveScreenshotAsset(screenshotName('statistics', locale), 'featureWide'),
  }
}

const copy = {
  aiRecognition: {
    chips: [
      { zh: '截图', en: 'Screenshots' },
      { zh: '表格', en: 'Tables' },
      { zh: '草稿', en: 'Drafts' },
    ],
  },
  subscriptions: {
    chips: [
      { zh: '价格', en: 'Price' },
      { zh: '周期', en: 'Cycle' },
      { zh: '续费日', en: 'Renewal date' },
      { zh: '付款方式', en: 'Payment method' },
    ],
  },
  publicStatus: {
    chips: [
      { zh: '公开项', en: 'Visible items' },
      { zh: '隐藏金额', en: 'Hidden prices' },
      { zh: '可撤销链接', en: 'Revocable link' },
    ],
  },
  reminders: {
    chips: [
      { zh: 'SMTP', en: 'SMTP' },
      { zh: '提前天数', en: 'Advance days' },
      { zh: '发送历史', en: 'Send history' },
    ],
  },
  calendar: {
    chips: [
      { zh: 'webcal', en: 'webcal' },
      { zh: 'ICS', en: 'ICS' },
      { zh: '私有 token', en: 'Private token' },
    ],
  },
  statistics: {
    chips: [
      { zh: '月度成本', en: 'Monthly cost' },
      { zh: '预算使用', en: 'Budget usage' },
      { zh: '多币种', en: 'Multi-currency' },
    ],
  },
}

function text(value: Record<Locale, string>, locale: Locale) {
  return value[locale]
}

function SceneBase({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return (
    <div className={`relative h-full overflow-hidden bg-zinc-950 ${className}`}>
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.035)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.035)_1px,transparent_1px)] bg-[size:36px_36px]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_16%_0%,rgba(16,185,129,0.24),transparent_32%),radial-gradient(circle_at_86%_72%,rgba(14,165,233,0.14),transparent_38%),linear-gradient(180deg,rgba(9,9,11,0.05)_0%,rgba(9,9,11,0.88)_100%)]"
      />
      <div className="relative h-full">{children}</div>
    </div>
  )
}

function ScreenshotLayer({
  alt,
  asset,
  className,
}: {
  alt: string
  asset: ScreenshotAsset
  className: string
}) {
  // 截图在卡片里只是产品场景背景；可访问文本由卡片标题和正文承担。
  return (
    <picture aria-hidden="true" className="contents" data-responsive-image="feature-screenshot">
      {asset.avif ? <source sizes={asset.sizes} srcSet={asset.avif} type="image/avif" /> : null}
      {asset.webp ? <source sizes={asset.sizes} srcSet={asset.webp} type="image/webp" /> : null}
      <img
        alt={alt}
        className={`absolute max-w-none rounded-xl border border-white/10 object-cover object-top opacity-70 shadow-2xl shadow-black/40 ${className}`}
        decoding="async"
        height={asset.height}
        loading="lazy"
        sizes={asset.sizes}
        src={asset.fallback}
        srcSet={asset.png}
        width={asset.width}
      />
    </picture>
  )
}

function Chip({
  children,
  icon: Icon = CheckCircle2,
}: {
  children: React.ReactNode
  icon?: React.ComponentType<{ className?: string; strokeWidth?: number }>
}) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-zinc-950/72 px-2.5 py-1 text-[11px] font-medium text-zinc-200 shadow-2xl shadow-black/20 backdrop-blur">
      <Icon aria-hidden="true" className="h-3.5 w-3.5 text-emerald-300" strokeWidth={1.7} />
      {children}
    </span>
  )
}

function ProductBackdrop({ asset }: { asset: ScreenshotAsset }) {
  return (
    <>
      <img
        alt=""
        aria-hidden="true"
        className="absolute inset-0 h-full w-full object-cover object-top opacity-18 blur-[1px] saturate-75"
        height={900}
        loading="lazy"
        src={asset.fallback}
        width={1400}
      />
      <div aria-hidden="true" className="absolute inset-0 bg-zinc-950/35" />
    </>
  )
}

function AIRecognitionScene({ locale }: FeatureSceneProps) {
  const imageSet = localizedImages(locale)

  return (
    <SceneBase>
      <ProductBackdrop asset={imageSet.aiRecognition} />
      <ScreenshotLayer
        alt=""
        asset={imageSet.aiRecognition}
        className="left-6 top-8 h-[255px] w-[680px] object-left-top"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950 via-zinc-950/82 to-transparent" />
      <div className="absolute bottom-7 left-6 right-6 flex flex-wrap gap-2">
        {copy.aiRecognition.chips.map((item, index) => (
          <Chip key={item.en} icon={index === 0 ? Image : index === 1 ? Table2 : Sparkles}>
            {text(item, locale)}
          </Chip>
        ))}
      </div>
    </SceneBase>
  )
}

function SubscriptionsScene({ locale }: FeatureSceneProps) {
  const imageSet = localizedImages(locale)

  return (
    <SceneBase>
      <ProductBackdrop asset={imageSet.subscriptions} />
      <ScreenshotLayer
        alt=""
        asset={imageSet.subscriptions}
        className="left-7 top-12 h-[245px] w-[520px] object-left-top"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950 via-zinc-950/85 to-transparent" />
      <div className="absolute bottom-7 left-6 right-6 flex flex-wrap gap-2">
        {copy.subscriptions.chips.map((item) => (
          <Chip key={item.en}>{text(item, locale)}</Chip>
        ))}
      </div>
    </SceneBase>
  )
}

function PublicStatusScene({ locale }: FeatureSceneProps) {
  const imageSet = localizedImages(locale)

  return (
    <SceneBase>
      <ProductBackdrop asset={imageSet.publicStatus} />
      <ScreenshotLayer
        alt=""
        asset={imageSet.publicStatus}
        className="left-8 top-8 h-[255px] w-[680px] object-left-top"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950 via-zinc-950/82 to-transparent" />
      <div className="absolute bottom-7 left-6 right-6 flex flex-wrap gap-2">
        {copy.publicStatus.chips.map((item, index) => (
          <Chip key={item.en} icon={index === 0 ? Eye : index === 1 ? EyeOff : Link}>
            {text(item, locale)}
          </Chip>
        ))}
      </div>
    </SceneBase>
  )
}

function RemindersScene({ locale }: FeatureSceneProps) {
  const imageSet = localizedImages(locale)

  return (
    <SceneBase className="bg-[radial-gradient(circle_at_center,rgba(39,39,42,0.72),transparent_64%)]">
      <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-72 w-72 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10" />
      <div aria-hidden="true" className="absolute left-1/2 top-1/2 h-48 w-48 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/8" />
      <div className="absolute left-1/2 top-8 h-[318px] w-[174px] -translate-x-1/2 rounded-[2rem] border-[6px] border-black bg-zinc-950 shadow-2xl shadow-black">
        <div className="absolute left-1/2 top-2 z-10 h-5 w-16 -translate-x-1/2 rounded-full bg-black" />
        <div className="h-full overflow-hidden rounded-[1.45rem] border border-white/10">
          <picture aria-hidden="true" data-responsive-image="feature-phone">
            <source sizes={imageSet.reminders.sizes} srcSet={imageSet.reminders.avif} type="image/avif" />
            <source sizes={imageSet.reminders.sizes} srcSet={imageSet.reminders.webp} type="image/webp" />
            <img
              alt=""
              className="h-full w-full object-cover object-top opacity-72"
              decoding="async"
              height={imageSet.reminders.height}
              loading="lazy"
              sizes={imageSet.reminders.sizes}
              src={imageSet.reminders.fallback}
              srcSet={imageSet.reminders.png}
              width={imageSet.reminders.width}
            />
          </picture>
          <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-zinc-950/80" />
        </div>
      </div>
      <div className="absolute bottom-7 left-6 right-6 flex flex-wrap justify-center gap-2">
        {copy.reminders.chips.map((item) => (
          <Chip key={item.en} icon={BellRing}>
            {text(item, locale)}
          </Chip>
        ))}
      </div>
    </SceneBase>
  )
}

function CalendarScene({ locale }: FeatureSceneProps) {
  const imageSet = localizedImages(locale)

  return (
    <SceneBase>
      <ProductBackdrop asset={imageSet.calendar} />
      <ScreenshotLayer
        alt=""
        asset={imageSet.calendar}
        className="left-6 top-10 h-[245px] w-[520px] object-left-top"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950 via-zinc-950/85 to-transparent" />
      <div className="absolute bottom-7 left-6 right-6 flex flex-wrap gap-2">
        {copy.calendar.chips.map((item, index) => (
          <Chip key={item.en} icon={index === 0 ? Link : CalendarClock}>
            {text(item, locale)}
          </Chip>
        ))}
      </div>
    </SceneBase>
  )
}

function StatisticsScene({ locale }: FeatureSceneProps) {
  const imageSet = localizedImages(locale)

  return (
    <SceneBase>
      <ProductBackdrop asset={imageSet.statistics} />
      <ScreenshotLayer
        alt=""
        asset={imageSet.statistics}
        className="left-8 top-8 h-[255px] w-[680px] object-left-top"
      />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-zinc-950 via-zinc-950/80 to-transparent" />
      <div className="absolute bottom-7 left-7 right-7 flex flex-wrap gap-2">
        {copy.statistics.chips.map((item) => (
          <Chip key={item.en}>{text(item, locale)}</Chip>
        ))}
      </div>
    </SceneBase>
  )
}

const scenes: Record<SceneKey, (props: FeatureSceneProps) => React.ReactElement> = {
  'ai-recognition': AIRecognitionScene,
  subscriptions: SubscriptionsScene,
  'public-status': PublicStatusScene,
  reminders: RemindersScene,
  calendar: CalendarScene,
  statistics: StatisticsScene,
}

export function FeatureScene({ scene, locale }: FeatureSceneProps & { scene: string }) {
  const Scene = scenes[scene as SceneKey]

  return (
    <div className="h-full" data-scene={scene}>
      {Scene ? <Scene locale={locale} /> : <SceneBase />}
    </div>
  )
}
