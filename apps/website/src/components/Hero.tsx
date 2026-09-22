import { lazy, Suspense } from 'react'
import { ArrowDown, CirclePlay } from 'lucide-react'
import { motion } from 'framer-motion'

import { copy, links, text, type Locale } from '../content/site'
import { externalLinkProps } from '../lib/external-link'
import { responsiveScreenshotAsset, screenshotName } from '../lib/renewlet-image-assets'
import { GridPattern } from './icons'
import { GlowButton } from './ui/GlowButton'

type HeroProps = {
  locale: Locale
  onDeployClick: () => void
}

// Hero 截图必须跟随官网语言切换，并通过 BASE_URL 兼容 GitHub Pages 子路径。
function dashboardImage(locale: Locale) {
  return responsiveScreenshotAsset(screenshotName('dashboard', locale), 'heroDashboard')
}
const dashboardVariants = {
  show: {
    rotateX: 0,
    transition: { duration: 0.75 },
  },
}
const HeroParticles = lazy(() => import('./HeroParticles').then((module) => ({ default: module.HeroParticles })))

export function Hero({ locale, onDeployClick }: HeroProps) {
  const isChinese = locale === 'zh'
  const image = dashboardImage(locale)

  return (
    <section className="relative isolate transform-gpu pt-14" data-section="hero">
      <div className="absolute inset-0 -z-10 bg-[image:radial-gradient(80%_50%_at_50%_-20%,hsl(160,84%,39%,0.42),rgba(255,255,255,0))]" />
      <GridPattern className="absolute inset-0 -z-10 h-full w-full stroke-white/5 [mask-image:radial-gradient(75%_50%_at_top_center,white,transparent)]" />
      <div className="py-24 sm:py-32 lg:pb-40">
        <div className="mx-auto max-w-7xl px-6 lg:px-8">
          <div className={`relative mx-auto text-center ${isChinese ? 'max-w-6xl' : 'max-w-[46rem]'}`}>
            <motion.p
              animate={{ opacity: 1, y: 0 }}
              className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-emerald-300/80"
              initial={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.45 }}
            >
              {text(copy.hero.eyebrow, locale)}
            </motion.p>
            <motion.h1
              animate={{ opacity: 1, scale: 1 }}
              className={`bg-gradient-to-br from-white to-zinc-500 bg-clip-text text-5xl/[1.07] font-bold tracking-tight text-transparent [text-wrap:balance] md:text-7xl/[1.07] ${isChinese ? 'lg:whitespace-nowrap' : ''}`}
              initial={{ opacity: 0, scale: 0.9 }}
              transition={{ duration: 0.5 }}
            >
              {text(copy.hero.title, locale)}
            </motion.h1>
            <motion.p
              animate={{ opacity: 1, y: 0 }}
              className={`mx-auto mt-6 font-medium text-zinc-400 ${isChinese ? 'max-w-5xl text-lg md:text-xl md:leading-8' : 'max-w-[40rem] text-base leading-7 md:text-lg md:leading-8'}`}
              initial={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.6, delay: 0.4 }}
            >
              {text(copy.hero.body, locale)}
            </motion.p>
            <div className="mt-10 flex flex-col items-center justify-center gap-y-7">
              <motion.div
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center"
                initial={{ opacity: 0, y: 10 }}
                transition={{ duration: 0.6, delay: 0.4 }}
              >
                <div className="flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
                  <GlowButton innerClassName="flex min-h-11 items-center px-5 py-2.5" onClick={onDeployClick}>
                    {text(copy.hero.secondaryCta, locale)}
                  </GlowButton>
                  <a
                    aria-describedby="hero-demo-note"
                    className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-white/10 bg-zinc-950/50 px-5 py-2.5 text-sm/6 font-medium text-zinc-300 transition hover:border-emerald-300/35 hover:bg-white/[0.045] hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/45"
                    href={links.demo}
                    {...externalLinkProps}
                  >
                    <CirclePlay aria-hidden="true" className="h-4 w-4 text-emerald-300" strokeWidth={1.7} />
                    {text(copy.hero.demoCta, locale)}
                  </a>
                </div>
                <p
                  className={`mt-4 max-w-2xl text-xs leading-5 text-zinc-500 sm:text-sm sm:leading-6 ${isChinese ? '' : 'max-w-[39rem]'}`}
                  id="hero-demo-note"
                >
                  {text(copy.hero.demoNote, locale)}
                </p>
              </motion.div>
              <motion.div
                animate={{ opacity: 1 }}
                className="group"
                initial={{ opacity: 0 }}
                transition={{ duration: 0.75, delay: 1 }}
              >
                <a className="flex flex-col items-center gap-1" href="#intro">
                  <p className="text-sm/6 text-zinc-400 duration-300 group-hover:text-zinc-100">
                    {text(copy.hero.learnMore, locale)}
                  </p>
                  <ArrowDown
                    className="text-zinc-400 duration-300 group-hover:translate-y-1.5 group-hover:text-zinc-100"
                    size={18}
                    strokeWidth={1.5}
                  />
                </a>
              </motion.div>
            </div>
          </div>
          <motion.div
            animate={{ opacity: 1 }}
            className="perspective-[1500px] relative pt-16"
            initial={{ opacity: 0 }}
            transition={{ duration: 0.75, delay: 1 }}
          >
            <Suspense fallback={null}>
              <HeroParticles />
            </Suspense>
            <motion.div
              className="relative"
              initial={false}
              variants={dashboardVariants}
              viewport={{ once: true, amount: 0.5 }}
              whileInView="show"
            >
              <div className="absolute -top-px right-20 h-2 w-20 [mask-image:linear-gradient(to_right,rgba(217,217,217,0)_0%,#d9d9d9_25%,#d9d9d9_75%,rgba(217,217,217,0)_100%)] md:w-32 lg:w-64">
                <div className="h-px w-full animate-starlight-right bg-gradient-to-r from-emerald-400/0 via-emerald-400 to-emerald-400/0" />
              </div>
              <div className="rounded-md bg-zinc-950 ring-1 ring-white/10 lg:rounded-2xl">
                <picture data-responsive-image="hero-dashboard">
                  <source sizes={image.sizes} srcSet={image.avif} type="image/avif" />
                  <source sizes={image.sizes} srcSet={image.webp} type="image/webp" />
                  <img
                    alt={text(copy.hero.imageAlt, locale)}
                    className="block h-auto w-full rounded-md lg:rounded-2xl"
                    decoding="async"
                    fetchPriority="high"
                    height={image.height}
                    sizes={image.sizes}
                    src={image.fallback}
                    srcSet={image.png}
                    width={image.width}
                  />
                </picture>
              </div>
              <div className="absolute -bottom-2 left-20 h-2 w-20 [mask-image:linear-gradient(to_right,rgba(217,217,217,0)_0%,#d9d9d9_25%,#d9d9d9_75%,rgba(217,217,217,0)_100%)] md:w-32 lg:w-64">
                <div className="h-px w-full animate-starlight-left bg-gradient-to-r from-emerald-400/0 via-emerald-400 to-emerald-400/0" />
              </div>
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
