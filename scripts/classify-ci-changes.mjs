import { readFileSync } from 'node:fs'

const changedPaths = readFileSync(0)
  .toString('utf8')
  .split('\0')
  .filter(Boolean)

const productCriticalDocument = /(?:^|\/)(?:LICENSE(?:\.[^/]*)?|THIRD_PARTY_NOTICES\.md)$/u
const documentationPath = /^(?:docs\/|\.agents\/notes\/|\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE))/u
const nestedDocumentationPath = /\/docs\//u
const documentationFile = /(?:\.mdx?|\.i18n\.ya?ml)$/u

const productChanged = changedPaths.length === 0 || changedPaths.some((path) => {
  if (productCriticalDocument.test(path)) return true
  return !documentationPath.test(path)
    && !nestedDocumentationPath.test(path)
    && !documentationFile.test(path)
})

/**
 * Paths whose change can alter the universal macOS package.
 *
 * CI packages a single CPU on every run so the PR lane stays fast. The
 * dual-architecture merge (lipo + the universal native runtime repair) then
 * only runs when one of these moves — which is where a silent regression would
 * otherwise wait until the release lane, the one place universal is always
 * built, to surface.
 */
const macOSPackagingPath = /^(?:dsh-plugin-desktop|dsh-desktop-next)\/(?:scripts\/(?:mac-universal|package-mac|verify-mac-smoke|prepare-fs-ext|prepare-runtime|mac-runtime|package)\.ts|package\.json)$/u
const ciWorkflowPath = /^\.github\/workflows\/ci\.ya?ml$/u

// An empty path list means a manual dispatch or an undiffable push: no diff can
// prove the universal merge still works, so take the slow path.
const macOSPackagingChanged = changedPaths.length === 0 || changedPaths.some(
  path => macOSPackagingPath.test(path) || ciWorkflowPath.test(path),
)

process.stdout.write(productChanged ? 'true\n' : 'false\n')
process.stdout.write(macOSPackagingChanged ? 'true\n' : 'false\n')
