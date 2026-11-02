/**
 * Generate native tray bitmaps from the OmniMux ghost-IP tray vector.
 *
 * Source of truth: build/tray-icon.svg — background-free ghost silhouette
 * (same path as the canonical octo_ghost_vector.svg) whose body is filled
 * with aurora violet #7961f2 and whose eyes are pure-white capsules
 * (DESIGN 2.0 Violet & Indigo Brand Refresh). The legacy chartreuse
 * (#C6F14F / #C8F135 / #A3E635) octopus is retired and must never return.
 *
 * Contract for build/tray-icon.svg:
 *   1. exactly one fill="#7961f2" (the body);
 *   2. no <style> element and no prefers-color-scheme media query;
 *   3. no solid background tile (transparent canvas).
 *
 * Outputs:
 *   - macOS template images: body rendered pure black with the eyes knocked
 *     out to transparent holes, so `setTemplateImage(true)` lets the system
 *     invert the glyph for light/dark menu bars;
 *   - Windows/Linux "tray-icon-blue*" images (historical filenames, kept to
 *     avoid touching Electron runtime paths): the aurora-violet color glyph.
 * The intermediate tray-icon-source*-32/16 rasters are also refreshed from
 * the same vector for build-time traceability.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

/** Aurora violet body fill of the color tray glyph (DESIGN 2.0 --logo-bg-vibrant). */
const BRAND_VIOLET = '#7961f2'
/** White capsule-eye fill inside the color tray glyph. */
const EYE_WHITE = '#FFFFFF'
/** Body fill of the macOS template glyph (system recolors black/transparent). */
const TEMPLATE_BLACK = '#000000'

/** ViewBox edge of the canonical ghost vector. */
const VIEWBOX_SIZE = 1254
/** White capsule eyes of the canonical ghost vector, in viewBox coordinates. */
const EYES = [
  { x: 447, y: 562, width: 75, height: 172, radius: 37.5 },
  { x: 731, y: 562, width: 75, height: 172, radius: 37.5 },
]

/** SVG render density: rasterize well above target sizes, then downscale. */
const SVG_RENDER_DENSITY = 384

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const buildRoot = join(packageRoot, 'build')
const traySvgPath = join(buildRoot, 'tray-icon.svg')

function assertTraySvgContract(svgText) {
  const bodyFills = svgText.match(new RegExp(BRAND_VIOLET, 'gu'))
  if (bodyFills === null || bodyFills.length !== 1) {
    throw new Error(
      `generate-tray-icons-omnimux: tray-icon.svg must contain exactly one fill="${BRAND_VIOLET}"`,
    )
  }
  if (/<style\b|prefers-color-scheme/iu.test(svgText)) {
    throw new Error(
      'generate-tray-icons-omnimux: tray-icon.svg must not contain <style> or prefers-color-scheme',
    )
  }
  if (/#C6F14F|#C8F135|#A3E635|#101B2B/iu.test(svgText)) {
    throw new Error(
      'generate-tray-icons-omnimux: tray-icon.svg still carries legacy chartreuse/navy brand colors',
    )
  }
}

/** Derive the macOS template SVG: black body, eye capsules removed (knocked out later). */
function toTemplateSvg(svgText) {
  return svgText
    .replace(`fill="${BRAND_VIOLET}"`, `fill="${TEMPLATE_BLACK}"`)
    .replace(new RegExp(`\\s*<rect[^>]*fill="${EYE_WHITE}"[^>]*/>`, 'gu'), '')
}

/** Opaque eye capsules on a transparent canvas, scaled from the viewBox to `size` px. */
function eyeKnockoutMaskSvg(size) {
  const scale = size / VIEWBOX_SIZE
  const rects = EYES.map((eye) =>
    `<rect x="${eye.x * scale}" y="${eye.y * scale}" width="${eye.width * scale}" ` +
    `height="${eye.height * scale}" rx="${eye.radius * scale}" ry="${eye.radius * scale}" fill="#fff"/>`,
  ).join('')
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${rects}</svg>`,
  )
}

async function renderSvg(svgText, size) {
  return sharp(Buffer.from(svgText), { density: SVG_RENDER_DENSITY })
    .resize(size, size, { fit: 'fill', kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer()
}

/** Render one aurora-violet color tray PNG. */
async function renderTray(svgText, size, file) {
  await writeFile(join(buildRoot, file), await renderSvg(svgText, size))
}

/** Render one macOS template PNG: black body with transparent eye holes. */
async function renderTemplateTray(templateSvgText, size, file) {
  const body = await renderSvg(templateSvgText, size)
  const mask = await sharp(eyeKnockoutMaskSvg(size))
    .ensureAlpha()
    .png()
    .toBuffer()
  const rendered = await sharp(body)
    .composite([{ input: mask, blend: 'dest-out' }])
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(join(buildRoot, file), rendered)
}

const svgText = await readFile(traySvgPath, 'utf8')
assertTraySvgContract(svgText)
const templateSvgText = toTemplateSvg(svgText)

const colorVariants = [
  ['tray-icon-blue.png', 16],
  ['tray-icon-blue@1.25x.png', 20],
  ['tray-icon-blue@1.5x.png', 24],
  ['tray-icon-blue@2x.png', 32],
  ['tray-icon-source-blue-16.png', 16],
  ['tray-icon-source-blue-32.png', 32],
]
const templateVariants = [
  ['tray-iconTemplate.png', 16],
  ['tray-iconTemplate@2x.png', 32],
  ['tray-icon-source-16.png', 16],
  ['tray-icon-source-32.png', 32],
]

await Promise.all([
  ...colorVariants.map(([filename, size]) => renderTray(svgText, size, filename)),
  ...templateVariants.map(([filename, size]) => renderTemplateTray(templateSvgText, size, filename)),
])
