const {test,before}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const {build}=require('../tools/build-miniapp')
const {auditProduction,auditDemo}=require('../tools/release-audit')

const root=path.resolve(__dirname,'..')
let production,demo
before(()=>{production=build('production');demo=build('demo')})

test('X-05 production artifact physically excludes Demo routes and modules',()=>{
  const manifest=auditProduction(production.target)
  const names=manifest.files.map(item=>item.path)
  assert.equal(manifest.mode,'production')
  assert.ok(!names.some(name=>/pages\/(?:loans|coupons|invite)\//.test(name)))
  assert.ok(!names.some(name=>/modules\/(?:account|physical-loan|promotion)\//.test(name)))
  assert.ok(!names.some(name=>name.startsWith('quiz/assets/')))
})

test('X-05 production artifact contains only the Peter Rabbit catalog',()=>{
  const catalog=require(path.join(production.target,'modules/catalog/catalog.json'))
  const app=require(path.join(production.target,'app.json'))
  assert.deepEqual(catalog.map(book=>book.id),['peter-rabbit'])
  assert.ok(app.pages.every(page=>!/(?:loans|coupons|invite)/.test(page)))
})

test('X-05 Demo artifact preserves explicit development-only functionality',()=>{
  const manifest=auditDemo(demo.target)
  const screen=fs.readFileSync(path.join(demo.target,'ui/screen.wxml'),'utf8')
  assert.equal(manifest.mode,'demo')
  assert.match(screen,/Demo: 123456/)
  assert.match(screen,/Complete Demo Invite/)
})

test('X-05 builds are byte-reproducible and project entries are explicit',()=>{
  const first={production:production.manifest.treeSha256,demo:demo.manifest.treeSha256}
  const again={production:build('production').manifest.treeSha256,demo:build('demo').manifest.treeSha256}
  assert.deepEqual(again,first)
  const productionProject=require(path.join(root,'project.config.json'))
  const demoProject=require(path.join(root,'project.demo.config.json'))
  assert.equal(productionProject.miniprogramRoot,'build/production-miniprogram/')
  assert.equal(demoProject.miniprogramRoot,'build/demo-miniprogram/')
})
