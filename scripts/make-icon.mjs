import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Turn the brand mark into an application icon.
 *
 * Rasterised with **Electron itself**, which is already a dependency — pulling in `sharp` or an
 * SVG library to render one file at build time would be a lot of node_modules for a picture.
 *
 * Run with: npm run icon
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mark = readFileSync(join(root, 'src/renderer/src/assets/brand/mark.svg'), 'utf8')

/** The accent, from the design tokens. The mark is knocked out of it in white. */
const ACCENT = '#5980a6'

/**
 * Every size Windows actually asks for.
 *
 * 16 is the title bar and the taskbar at 100%; 256 is what File Explorer shows at "extra large".
 * Shipping only 256 and letting Windows downscale is how an icon becomes a smudge at 16px, so
 * each size is drawn from the vector rather than resampled from a bigger raster.
 */
const SIZES = [16, 24, 32, 48, 64, 128, 256]

/**
 * A rounded square in the accent with the mark centred on it.
 *
 * Full-bleed would be simpler but reads as dated, and a bare mark on transparency disappears
 * against a taskbar of the same colour. The inset scales with the icon so the headset is still
 * a headset at 16 pixels.
 */
function pageFor(svg) {
  // The source uses `currentColor`; an icon needs a real one.
  const encoded = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    svg.replace('fill="currentColor"', 'fill="#ffffff"'),
  )}`

  return [
    '<!doctype html><meta charset="utf-8"><body><script>',
    `const SRC = ${JSON.stringify(encoded)}`,
    `const ACCENT = ${JSON.stringify(ACCENT)}`,
    `const SIZES = ${JSON.stringify(SIZES)}`,
    'function draw(img, size) {',
    '  const c = document.createElement("canvas")',
    '  c.width = size; c.height = size',
    '  const g = c.getContext("2d")',
    '  const r = Math.round(size * 0.22)',
    '  g.fillStyle = ACCENT',
    '  g.beginPath()',
    '  g.moveTo(r, 0)',
    '  g.arcTo(size, 0, size, size, r)',
    '  g.arcTo(size, size, 0, size, r)',
    '  g.arcTo(0, size, 0, 0, r)',
    '  g.arcTo(0, 0, size, 0, r)',
    '  g.closePath(); g.fill()',
    '  const inner = size * 0.62',
    '  const ratio = img.naturalWidth / img.naturalHeight',
    '  const w = ratio >= 1 ? inner : inner * ratio',
    '  const h = ratio >= 1 ? inner / ratio : inner',
    '  g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)',
    '  return c.toDataURL("image/png").split(",")[1]',
    '}',
    'window.render = () => new Promise((resolve, reject) => {',
    '  const img = new Image()',
    '  img.onload = () => { try { resolve(SIZES.map((s) => draw(img, s))) } catch (e) { reject(e) } }',
    '  img.onerror = () => reject(new Error("the mark did not decode"))',
    '  img.src = SRC',
    '})',
    '</script></body>',
  ].join('\n')
}

/**
 * Pack PNGs into a Windows .ico.
 *
 * A 6-byte header, a 16-byte directory entry per image, then the images. PNG frames have been
 * legal since Vista and everything that matters reads them, so there is no reason to hand-roll
 * a BMP encoder for this.
 */
function ico(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16

  for (const { size, png } of images) {
    const e = Buffer.alloc(16)
    // 256 is written as 0: the field is one byte, so 256 does not fit in it.
    e.writeUInt8(size >= 256 ? 0 : size, 0)
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt8(0, 2) // palette size: 0 for truecolour
    e.writeUInt8(0, 3) // reserved
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

app.disableHardwareAcceleration()

/**
 * `app.whenReady().then(...)`, deliberately, rather than top-level `await`.
 *
 * In an ESM entry Electron holds `ready` until the module finishes evaluating — so a top-level
 * `await app.whenReady()` waits for an event that is waiting for it. The script simply hangs,
 * with no error and no output at all. A callback sidesteps it.
 */
app
  .whenReady()
  .then(async () => {
    /*
     * A real file rather than a `data:` URL: a data-URL page is an opaque origin, which is a
     * good way to get a tainted canvas and a `toDataURL` that throws where you cannot see it.
     */
    const page = join(tmpdir(), `vp-icon-${process.pid}.html`)
    writeFileSync(page, pageFor(mark), 'utf8')

    const win = new BrowserWindow({ show: false, width: 320, height: 320 })
    await win.loadFile(page)

    const base64s = await win.webContents.executeJavaScript('window.render()')
    rmSync(page, { force: true })

    const images = SIZES.map((size, i) => ({ size, png: Buffer.from(base64s[i], 'base64') }))

    const out = join(root, 'build')
    mkdirSync(out, { recursive: true })

    // The .ico is what Windows wants; the .png is what BrowserWindow and Linux want.
    writeFileSync(join(out, 'icon.ico'), ico(images))
    writeFileSync(join(out, 'icon.png'), images[images.length - 1].png)

    console.log(
      `icon: build/icon.ico (${SIZES.join(', ')}) + build/icon.png — ` +
        `${images.reduce((n, i) => n + i.png.length, 0)} bytes`,
    )

    win.destroy()
    app.quit()
  })
  .catch((e) => {
    console.error(`icon failed: ${e.message}`)
    app.exit(1)
  })
