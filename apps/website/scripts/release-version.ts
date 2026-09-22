import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { latestStableReleaseVersionFromFileNames } from '../src/lib/release-version.ts'

const releaseNotesDir = fileURLToPath(new URL('../../../docs/release-notes/', import.meta.url))

export function latestStableReleaseVersion() {
  // release notes 是官网对外版本事实源；workspace package.json 在发布准备窗口可能仍停在旧稳定版。
  const version = latestStableReleaseVersionFromFileNames(readdirSync(releaseNotesDir))
  if (!version) throw new Error(`No stable Renewlet release notes found in ${releaseNotesDir}.`)
  return version
}
