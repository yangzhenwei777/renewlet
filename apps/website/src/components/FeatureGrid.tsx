import { copy, featureCards, text, type FeatureCard, type Locale } from '../content/site'
import { FeatureScene } from './feature-scenes'

type FeatureGridProps = {
  locale: Locale
}

const cardClassNames = [
  'col-span-full md:col-span-3 lg:col-span-4',
  'col-span-full md:col-span-3 lg:col-span-4',
  'col-span-full md:col-span-3 lg:col-span-4',
  'col-span-full md:col-span-3 lg:col-span-4',
  'col-span-full md:col-span-3 lg:col-span-4',
  'col-span-full md:col-span-3 lg:col-span-4',
]

function SectionHeading({ locale }: FeatureGridProps) {
  const isChinese = locale === 'zh'

  return (
    <div className={`grid items-start justify-between gap-5 ${isChinese ? 'max-w-xl' : 'max-w-[42rem]'}`}>
      <div className="text-[2rem]/[1.07] font-bold tracking-tight [text-wrap:balance] md:text-5xl/[1.07]">
        <span className="bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-transparent">
          {text(copy.featuresHeading.title, locale)}
        </span>
      </div>
      <div className={`text-zinc-400/80 ${isChinese ? 'text-lg' : 'max-w-[38rem] text-base leading-7 md:text-lg md:leading-8'}`}>
        {text(copy.featuresHeading.body, locale)}{' '}
        <span className="text-zinc-200">{text(copy.featuresHeading.highlight, locale)}</span>
      </div>
    </div>
  )
}

function FeatureCardView({
  card,
  className,
  locale,
}: {
  card: FeatureCard
  className: string
  locale: Locale
}) {
  const Icon = card.icon
  const isChinese = locale === 'zh'

  // 480px 卡片固定拆成 292px 视觉区和 188px 文案区，避免中英文描述高度不齐时破坏整组节奏。
  return (
    <article
      className={`${className} flex h-[480px] flex-col overflow-hidden rounded-2xl bg-zinc-900/50 ring-1 ring-zinc-100/10`}
      data-card={card.key}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative h-[292px] shrink-0 overflow-hidden bg-zinc-950/40">
          <FeatureScene locale={locale} scene={card.key} />
          <div className="absolute left-4 top-4 flex items-center gap-2 rounded-full border border-white/10 bg-zinc-950/70 px-3 py-1.5 text-xs font-semibold text-zinc-200 backdrop-blur">
            <Icon aria-hidden="true" className="h-4 w-4 text-emerald-300" strokeWidth={1.6} />
            {text(card.title, locale)}
          </div>
        </div>
        <div className="relative flex h-[188px] shrink-0 flex-col border-t border-white/10 p-5 md:p-6">
          <h3 className="text-xl font-semibold text-zinc-100">{text(card.title, locale)}</h3>
          <p className={`mt-3 line-clamp-3 text-sm text-zinc-400 ${isChinese ? 'leading-6' : 'max-w-[31rem] leading-[1.7]'}`}>
            {text(card.body, locale)}
          </p>
        </div>
      </div>
    </article>
  )
}

export function FeatureGrid({ locale }: FeatureGridProps) {
  return (
    <section className="mx-auto max-w-7xl p-6 py-16 md:py-24 lg:px-8" data-section="features">
      <SectionHeading locale={locale} />
      <div className="mt-16 grid grid-cols-6 gap-4 lg:grid-cols-12 lg:gap-6 xl:gap-8">
        {featureCards.map((card, index) => (
          <FeatureCardView
            key={card.key}
            card={card}
            className={cardClassNames[index] ?? 'col-span-full'}
            locale={locale}
          />
        ))}
      </div>
    </section>
  )
}
