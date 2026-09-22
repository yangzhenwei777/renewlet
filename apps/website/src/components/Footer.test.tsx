import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { links, localizedUrl } from '../content/site'
import { Footer } from './Footer'

describe('Footer', () => {
  it('uses repository-derived footer links', () => {
    render(<Footer locale="zh" />)

    const githubLink = screen.getByRole('link', { name: 'GitHub' })
    const dockerLink = screen.getByRole('link', { name: 'Docker' })
    const cloudflareLink = screen.getByRole('link', { name: 'Cloudflare' })
    const licenseLink = screen.getByRole('link', { name: 'License' })

    expect(githubLink).toHaveAttribute('href', links.github)
    expect(dockerLink).toHaveAttribute('href', links.docker)
    expect(cloudflareLink).toHaveAttribute('href', localizedUrl(links.cloudflare, 'zh'))
    expect(licenseLink).toHaveAttribute('href', links.license)

    for (const link of [githubLink, dockerLink, cloudflareLink, licenseLink]) {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    }
  })
})
