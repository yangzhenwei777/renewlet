import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { links } from '../content/site'
import { Header } from './Header'

describe('Header', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses the Vite base URL for the Renewlet home link', () => {
    vi.stubEnv('BASE_URL', '/renewlet/')

    render(<Header locale="zh" onLocaleChange={vi.fn()} />)

    const homeLink = screen.getByRole('link', { name: /Renewlet home/i })

    expect(homeLink).toHaveAttribute('href', '/renewlet/')
    expect(homeLink).not.toHaveAttribute('target')
  })

  it('opens external header links in a new tab', () => {
    render(<Header locale="zh" onLocaleChange={vi.fn()} />)

    const docsLink = screen.getByRole('link', { name: /^文档$/i })
    const githubLink = screen.getByRole('link', { name: /^GitHub$/i })

    expect(docsLink).toHaveAttribute('href', links.docsZh)
    expect(githubLink).toHaveAttribute('href', links.github)

    for (const link of [docsLink, githubLink]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })
})
