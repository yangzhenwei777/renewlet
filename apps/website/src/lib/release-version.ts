const stableReleaseNotePattern = /^v(?<version>\d+\.\d+\.\d+)-(?:zh|en)\.md$/

export function latestStableReleaseVersionFromFileNames(fileNames: readonly string[]) {
  const versions = new Set<string>()
  for (const fileName of fileNames) {
    const match = stableReleaseNotePattern.exec(fileName)
    if (match?.groups?.version) versions.add(match.groups.version)
  }
  return [...versions].sort(compareStableVersions).at(-1) ?? null
}

function compareStableVersions(left: string, right: string) {
  const leftParts = left.split('.').map((part) => Number.parseInt(part, 10))
  const rightParts = right.split('.').map((part) => Number.parseInt(part, 10))
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index] - rightParts[index]
    if (delta !== 0) return delta
  }
  return 0
}
