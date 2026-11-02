/**
 * Generate the macOS Dock icon from a 1024 RGBA source (v1: ICC optional).
 *
 * Source constraint: build/app-icon.png must be a FULL-BLEED square with
 * SQUARE corners (produced by scripts/generate-app-icon-source-omnimux.mjs
 * from the canonical octo_ghost vector). Never feed a pre-rounded brand-kit
 * variant (`rx="280"`): this script already applies the 22.37% Apple corner
 * mask, and a rounded source would double-round and eat the Dock safe area.
 */

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Pixel width and height of the generated macOS icon canvas. */
export const MAC_APP_ICON_CANVAS_SIZE = 1024
/** Pixel width and height of the centered source artwork. */
export const MAC_APP_ICON_ARTWORK_SIZE = 824
/** Transparent inset on each edge of the generated macOS icon. */
export const MAC_APP_ICON_INSET = (MAC_APP_ICON_CANVAS_SIZE - MAC_APP_ICON_ARTWORK_SIZE) / 2
/**
 * Apple macOS / iOS app-icon corner radius as a fraction of the icon edge.
 * Matches the Grid / continuous-corner approximation used by icon templates (~22.37%).
 */
export const MAC_APP_ICON_CORNER_RADIUS_RATIO = 0.2237

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(packageRoot, 'build', 'app-icon.png')
const outputPath = join(packageRoot, 'build', 'app-icon-mac.png')
const icnsPath = join(packageRoot, 'build', 'app-icon.icns')

/**
 * The slices `iconutil` packs into one `.icns`.
 *
 * electron-builder copies this file into the bundle as `Contents/Resources/icon.icns`,
 * which is what the Dock renders: a set that stops at 256 leaves Retina Dock icons
 * upscaled from a quarter-size bitmap.
 */
export const MAC_ICONSET_ENTRIES = Object.freeze([
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
])

/**
 * Pack a 1024 RGBA PNG into the multi-size `.icns` macOS needs.
 *
 * `iconutil` is a macOS tool, so other platforms keep the committed `.icns`
 * untouched instead of failing the whole build.
 * @param {Buffer} png - Rendered 1024x1024 icon.
 * @param {string} [destination] - Output `.icns` path.
 * @returns {Promise<boolean>} Whether a new `.icns` was written.
 */
export async function writeMacAppIconIcns(png, destination = icnsPath) {
  if (process.platform !== 'darwin') return false
  const workRoot = await mkdtemp(join(tmpdir(), 'omnimux-app-icon-'))
  try {
    const iconsetDir = join(workRoot, 'app-icon.iconset')
    await mkdir(iconsetDir, { recursive: true })
    for (const [name, size] of MAC_ICONSET_ENTRIES) {
      await sharp(png, { failOn: 'none' })
        .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
        .png({ compressionLevel: 9 })
        .toFile(join(iconsetDir, name))
    }
    execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', destination], { stdio: 'inherit' })
    return true
  } finally {
    await rm(workRoot, { recursive: true, force: true })
  }
}

/**
 * Build an SVG rounded-rect alpha mask for a square canvas.
 * @param {number} size
 * @param {number} radius
 */
export function roundedRectMaskSvg(size, radius) {
  const r = Math.max(0, Math.min(radius, size / 2))
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/>` +
      `</svg>`,
  )
}

/**
 * Apply an Apple-ratio rounded-rect mask to a square RGBA PNG buffer.
 * @param {Buffer} png
 * @param {number} size
 */
export async function applyAppleIconCornerMask(png, size) {
  const radius = size * MAC_APP_ICON_CORNER_RADIUS_RATIO
  const mask = await sharp(roundedRectMaskSvg(size, radius))
    .resize(size, size)
    .ensureAlpha()
    .png()
    .toBuffer()
  return sharp(png, { failOn: 'none' })
    .ensureAlpha()
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
}

export async function generateMacAppIconOmnimux(
  source = sourcePath,
  output = outputPath,
) {
  if (resolve(source) === resolve(output)) {
    throw new Error('generate-mac-app-icon-omnimux: output must not overwrite the source icon')
  }
  const metadata = await sharp(source).metadata()
  if (
    metadata.format !== 'png'
    || metadata.width !== MAC_APP_ICON_CANVAS_SIZE
    || metadata.height !== MAC_APP_ICON_CANVAS_SIZE
    || metadata.hasAlpha !== true
  ) {
    throw new Error(
      `generate-mac-app-icon-omnimux: source must be a ${MAC_APP_ICON_CANVAS_SIZE}x${MAC_APP_ICON_CANVAS_SIZE} RGBA PNG`,
    )
  }
  const artwork = await sharp(source, { failOn: 'none' })
    .resize({
      width: MAC_APP_ICON_ARTWORK_SIZE,
      height: MAC_APP_ICON_ARTWORK_SIZE,
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .png()
    .toBuffer()
  const maskedArtwork = await applyAppleIconCornerMask(artwork, MAC_APP_ICON_ARTWORK_SIZE)
  const rendered = await sharp(maskedArtwork, { failOn: 'none' })
    .extend({
      top: MAC_APP_ICON_INSET,
      bottom: MAC_APP_ICON_INSET,
      left: MAC_APP_ICON_INSET,
      right: MAC_APP_ICON_INSET,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(output, rendered)
  await writeMacAppIconIcns(rendered)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await generateMacAppIconOmnimux()
}
