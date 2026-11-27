// Renders the PNG logo files from grape-mark.svg with headless Chrome (needs `puppeteer-core` and Google Chrome).
//   node build-assets.mjs        -> logo-dark.png, logo-light.png, icon.png, icon-dark.png (committed; rerun only to change the design)
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const here = dirname(fileURLToPath(import.meta.url))
const mark = readFileSync(join(here, 'grape-mark.svg'), 'utf8').replace(/<svg /, '<svg width="100%" height="100%" ')
const font = (f) => `data:font/woff2;base64,${readFileSync(join(here, 'fonts', f)).toString('base64')}`
const css = (ink) => `
  @font-face{font-family:F;src:url(${font('fraunces.woff2')});font-weight:100 900}
  @font-face{font-family:I;src:url(${font('inter.woff2')});font-weight:100 900}
  html,body{margin:0;background:transparent}
  .row{display:inline-flex;align-items:center;gap:22px;padding:24px 28px}
  .mark{width:112px;height:112px}
  .word{font:600 92px/1 F,serif;letter-spacing:-2px;color:${ink}}
  .id{font:800 64px/1 I,sans-serif;letter-spacing:2px;margin-left:10px;background:linear-gradient(100deg,#e0a8ff,#b86cf0 55%,#8f3fd1);-webkit-background-clip:text;background-clip:text;color:transparent;vertical-align:8px}
  .icon{width:256px;height:256px;display:grid;place-items:center}
  .icon .mark{width:208px;height:208px}`
const wordmark = (ink) => `<style>${css(ink)}</style><div class="row" id="s"><div class="mark">${mark}</div><div><span class="word">Grapes</span><span class="id">ID</span></div></div>`
const icon = (bg) => `<style>${css('#fff')}</style><div class="icon" id="s" style="${bg}"><div class="mark">${mark}</div></div>`

const jobs = [
  ['logo-dark.png', wordmark('#f4ecff')], // for dark backgrounds
  ['logo-light.png', wordmark('#2b1048')], // for light backgrounds
  ['icon.png', icon('background:transparent')],
  ['icon-dark.png', icon('background:#140a22;border-radius:56px')],
]
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const page = await browser.newPage()
await page.setViewport({ width: 1200, height: 400, deviceScaleFactor: 2 })
for (const [file, html] of jobs) {
  await page.setContent(`<html><body>${html}</body></html>`)
  await page.evaluate(() => document.fonts.ready)
  const el = await page.$('#s')
  await el.screenshot({ path: join(here, file), omitBackground: true })
  console.log('wrote', file)
}
await browser.close()
