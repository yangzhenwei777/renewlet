import { copy, text, type Locale } from '../content/site'

type IntroProps = {
  locale: Locale
}

export function Intro({ locale }: IntroProps) {
  const isChinese = locale === 'zh'

  return (
    <section
      className="mx-auto max-w-7xl p-6 py-16 md:py-24 lg:px-8"
      data-section="intro"
      id="intro"
    >
      <div className="grid items-start justify-between gap-5 md:grid-cols-2">
        {/* 中英文标题长度差异很大，中文保留右侧呼吸感，英文用 ch 宽度控制断行节奏。 */}
        <div className={`text-[2rem]/[1.07] font-bold tracking-tight md:text-5xl/[1.07] ${isChinese ? 'pr-8 md:pr-16' : 'max-w-[16ch] pr-0 [text-wrap:balance]'}`}>
          <span className="bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-transparent">
            {text(copy.intro.title, locale)}
          </span>
        </div>
        <div className={`text-zinc-400/80 ${isChinese ? 'text-lg' : 'max-w-[34rem] text-base leading-7 md:text-lg md:leading-8'}`}>
          {text(copy.intro.body, locale)}{' '}
          <span className="text-zinc-200">{text(copy.intro.highlight, locale)}</span>
        </div>
      </div>
    </section>
  )
}
