/**
 * Rasterize the canonical OmniMux ghost IP vector into the 1024x1024 RGBA
 * application-icon source consumed by electron-builder (win/linux.icon) and by
 * scripts/generate-mac-app-icon-omnimux.mjs.
 *
 * Source of truth: build/octo-ghost-app.svg — a byte-identical copy of the
 * OmniMux repo's assets/ip_design/octo_ghost_vector.svg (DESIGN 2.0 Violet &
 * Indigo Brand Refresh). The SVG is a full-bleed SQUARE with square corners
 * (lavender #b8b7ff background, charcoal #121213 ghost body, pure-white
 * capsule eyes). Do NOT substitute the docs/brand `rx="280"` pre-rounded
 * variants: the macOS generator applies its own 22.37% corner mask, and a
 * pre-rounded source would double-round and eat the Dock safe area.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Pixel width and height of the generated application-icon source. */
export const APP_ICON_SOURCE_SIZE = 1024
/** SVG render density: 1254-unit viewBox rasterized well above 1024px, then downscaled. */
const SVG_RENDER_DENSITY = 384

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceSvgPath = join(packageRoot, 'build', 'octo-ghost-app.svg')
const outputPath = join(packageRoot, 'build', 'app-icon.png')

export async function generateAppIconSourceOmnimux(
  source = sourceSvgPath,
  output = outputPath,
) {
  const svg = await readFile(source)
  const png = await sharp(svg, { density: SVG_RENDER_DENSITY })
    .resize(APP_ICON_SOURCE_SIZE, APP_ICON_SOURCE_SIZE, {
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer()

  const metadata = await sharp(png).metadata()
  if (
    metadata.width !== APP_ICON_SOURCE_SIZE
    || metadata.height !== APP_ICON_SOURCE_SIZE
    || metadata.hasAlpha !== true
  ) {
    throw new Error(
      `generate-app-icon-source-omnimux: expected a ${APP_ICON_SOURCE_SIZE}x${APP_ICON_SOURCE_SIZE} RGBA PNG`,
    )
  }

  await writeFile(output, png)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && fileURLToPath(import.meta.url) === invokedPath) {
  await generateAppIconSourceOmnimux()
}
