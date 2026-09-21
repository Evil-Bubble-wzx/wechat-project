const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { chromium } = require('playwright')

const reviewPath = path.resolve('content/peter-rabbit/peter-rabbit-01/review/vocab-index.html')

let browser

async function run() {
  browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } })
  const errors = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(reviewPath).href)
  await page.waitForLoadState('domcontentloaded')

  const initial = {
    title: await page.title(),
    stats: await page.locator('#stats').innerText(),
    units: await page.locator('#list button').count(),
    downloadEnabled: await page.locator('#download').isEnabled()
  }
  if (initial.title !== 'Peter Rabbit 词汇编辑审核') throw new Error(`Unexpected title: ${initial.title}`)
  if (initial.stats !== '0/371 已确认' || initial.units !== 371 || initial.downloadEnabled) {
    throw new Error(`Unexpected initial state: ${JSON.stringify(initial)}`)
  }

  await page.locator('#search').fill('scr-r-ritch')
  if (await page.locator('#list button').count() !== 1) throw new Error('Special-form search did not narrow to one unit.')
  if (!(await page.locator('#editor').innerText()).includes('onomatopoeia')) throw new Error('Special-form risk was not rendered.')

  await page.locator('#search').fill('asked')
  await page.locator('#list button').first().click()
  await page.locator('#action').selectOption('approve')
  await page.locator('[data-use]').first().click()
  const candidate = {
    lemma: await page.locator('[data-s="0"][data-f="lemma"]').inputValue(),
    partOfSpeech: await page.locator('[data-s="0"][data-f="partOfSpeech"]').inputValue(),
    phonetic: await page.locator('[data-s="0"][data-f="phonetic"]').inputValue()
  }
  if (candidate.lemma !== 'ask' || candidate.partOfSpeech !== 'verb' || !candidate.phonetic.startsWith('/')) {
    throw new Error(`Evidence selection failed: ${JSON.stringify(candidate)}`)
  }
  await page.locator('#addSense').click()
  if (await page.locator('.sense').count() !== 2) throw new Error('Sense split did not add a second editor.')
  await page.locator('[data-remove-sense="1"]').click()
  if (await page.locator('.sense').count() !== 1) throw new Error('Sense removal did not restore one editor.')

  await page.locator('#reviewer').fill('wzx')
  if (await page.locator('#download').isEnabled()) throw new Error('Completed export unlocked before all review units were confirmed.')

  await page.setViewportSize({ width: 390, height: 844 })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  if (overflow) throw new Error('The vocabulary workbench overflows horizontally at 390px.')
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`)
  console.log(JSON.stringify({ initial, candidate, splitSense: 'PASS', completionGate: 'PASS', mobile390: 'PASS', errors }, null, 2))
  await browser.close()
  browser = null
}

run().catch(async (error) => {
  if (browser) await browser.close().catch(() => {})
  console.error(error.stack || error.message)
  process.exitCode = 1
})
