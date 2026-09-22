import { useState } from 'react'

import { CallToAction } from './components/CallToAction'
import { FeatureGrid } from './components/FeatureGrid'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { Hero } from './components/Hero'
import { Intro } from './components/Intro'
import { RuntimeSection } from './components/RuntimeSection'
import { DeployDialog } from './features/deploy/DeployDialog'
import { websitePath } from './lib/site-path'
import type { Locale } from './content/site'

// /en/ 是真实静态 HTML 入口，初始语言必须跟路径一致，避免英文 canonical 页首屏闪成中文。
function initialLocale(): Locale {
  return window.location.pathname.replace(/\/+$/, '').endsWith('/en') ? 'en' : 'zh'
}

function App() {
  const [deployOpen, setDeployOpen] = useState(false)
  const [locale, setLocale] = useState<Locale>(initialLocale)

  function openDeployDialog() {
    setDeployOpen(true)
  }

  function handleLocaleChange(nextLocale: Locale) {
    setLocale(nextLocale)
    document.documentElement.lang = nextLocale === 'en' ? 'en' : 'zh-CN'

    window.history.replaceState({}, '', websitePath(nextLocale === 'en' ? 'en/' : ''))
  }

  return (
    <>
      <div className="overflow-clip">
        <Header locale={locale} onLocaleChange={handleLocaleChange} />
        <main>
          <Hero locale={locale} onDeployClick={openDeployDialog} />
          <Intro locale={locale} />
          <FeatureGrid locale={locale} />
          <RuntimeSection locale={locale} />
          <CallToAction locale={locale} onDeployClick={openDeployDialog} />
        </main>
        <Footer locale={locale} />
      </div>
      <DeployDialog locale={locale} onOpenChange={setDeployOpen} open={deployOpen} />
    </>
  )
}

export default App
