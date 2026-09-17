const { test } = require('node:test')
const assert = require('node:assert/strict')
const {demoLogin}=require('../miniprogram/modules/account/session')
const {reserve,renew}=require('../miniprogram/modules/physical-loan/rules')
const {books}=require('../miniprogram/modules/catalog/books')
test('Login requires consent, validates test credentials and never persists phone',()=>{
 assert.throws(()=>demoLogin('wechat','','',false));assert.throws(()=>demoLogin('phone','13800000000','000000',true));
 const a=demoLogin('phone','13800000000','123456',true),b=demoLogin('wechat','','',true)
 assert.equal(a.id,b.id);assert.equal(a.phone,undefined);assert.equal(a.demo,true)
})
test('Reservation rejects no stock and repeated active reservations; cancellation permits retry',()=>{
 assert.throws(()=>reserve([],books.find(b=>b.stock===0)))
 const list=reserve([],books[0]);assert.equal(list.length,1)
 assert.throws(()=>reserve(list,books[0]));assert.equal(reserve([{...list[0],status:'cancelled'}],books[0]).length,2)
})
test('Renew only applies to borrowed copy and can only happen once',()=>{
 assert.throws(()=>renew({status:'reserved',renewals:0}));const r=renew({status:'borrowed',renewals:0});assert.equal(r.renewals,1);assert.throws(()=>renew(r))
})
test('Catalog IDs are stable and unique',()=>{assert.equal(new Set(books.map(b=>b.id)).size,books.length);assert.ok(books.every(b=>b.id && b.cover && b.duration>0))})
