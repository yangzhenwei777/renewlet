import { copy, text, type Locale } from '../content/site'
import { GlowButton } from './ui/GlowButton'

type CallToActionProps = {
  locale: Locale
  onDeployClick: () => void
}

export function CallToAction({ locale, onDeployClick }: CallToActionProps) {
  const isChinese = locale === 'zh'

  return (
    <section className="relative mx-auto mt-16 max-w-full p-6 pb-12 pt-20 lg:px-8" data-section="cta">
      <div
        aria-hidden="true"
        className="user-select-none center pointer-events-none absolute -top-0.5 left-1/2 h-px w-4/5 max-w-[500px] -translate-x-1/2 -translate-y-1/2 transform-gpu [background:linear-gradient(90deg,rgba(0,0,0,0)_0%,rgba(2,132,199,0.65)_50%,rgba(0,0,0,0)_100%)]"
      />
      <div
        aria-hidden="true"
        className="user-select-none center pointer-events-none absolute -top-1 left-1/2 h-[200px] w-full max-w-[300px] -translate-x-1/2 -translate-y-1/2 transform-gpu [background:conic-gradient(from_90deg_at_50%_50%,#00000000_50%,#09090b_50%),radial-gradient(rgba(200,200,200,0.05)_0%,transparent_70%)] md:max-w-[600px]"
      />
      <div className="relative isolate">
        <svg
          aria-hidden="true"
          className="absolute inset-0 -z-10 h-full w-full stroke-white/5 [mask-image:radial-gradient(40%_80%_at_center,black,transparent)]"
        >
          <defs>
            <pattern height="80" id="cta" patternUnits="userSpaceOnUse" width="80" x="50%" y="-1">
              <path d="M.5 200V.5H200" fill="none" />
            </pattern>
          </defs>
          <rect fill="url(#cta)" height="100%" strokeWidth={0} width="100%" />
        </svg>
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-10 -z-10 flex transform-gpu justify-center overflow-hidden blur-3xl"
        >
          <div
            className="aspect-[1108/632] w-[69.25rem] flex-none bg-gradient-to-r from-emerald-500 to-cyan-800 opacity-20"
            style={{
              clipPath:
                'polygon(77.5% 40.13%, 90% 10%, 100% 50%, 95% 80%, 92% 85%, 75% 65%, 61.26% 54.7%, 50% 54.7%, 47.24% 65.81%, 50% 85%, 26.16% 73.91%, 0.1% 100%, 1% 40.13%, 20% 48.75%, 60% 0.25%, 67.5% 32.63%)',
            }}
          />
        </div>
        {/* CTA 文案长度中英文差异明显，宽度分支只保护断行，不改变按钮行为。 */}
        <div className={`mx-auto text-center ${isChinese ? 'max-w-xl' : 'max-w-[42rem]'}`}>
          <h2 className="bg-gradient-to-br from-zinc-100 to-zinc-600 bg-clip-text text-3xl font-bold tracking-tight text-transparent sm:text-4xl">
            {text(copy.cta.title, locale)}
          </h2>
          <p className={`mx-auto mt-6 text-zinc-400/80 ${isChinese ? 'max-w-xl text-lg' : 'max-w-[36rem] text-base leading-7 md:text-lg md:leading-8'}`}>
            {text(copy.cta.body, locale)}
          </p>
          <div className="mt-12 flex items-center justify-center">
            <GlowButton onClick={onDeployClick}>{text(copy.cta.button, locale)}</GlowButton>
          </div>
        </div>
      </div>
    </section>
  )
}
