const BOOK_IDS = ['little-seed', 'fox-star', 'bear-picnic']
const PRICE = 15
const DISCOUNT = 5
const MINIMUM = 12
const VALID_DAYS = 30
const DAY = 86400000

function eligibleBook(bookId) { return BOOK_IDS.includes(bookId) }
function activeCoupons(state, now = Date.now()) {
  return (state.demoCoupons || []).filter(c => !c.used && c.expires > now)
}
function applicableCoupon(state, bookId, now = Date.now()) {
  return eligibleBook(bookId) && PRICE >= MINIMUM ? activeCoupons(state, now)[0] || null : null
}
function simulateInvitation(state, now = Date.now()) {
  if (!state.user) throw new Error('请先登录演示账户')
  if (state.demoInvitationCompleted) throw new Error('演示邀请奖励已领取')
  state.demoInvitationCompleted = true
  state.demoCoupons = [...(state.demoCoupons || []), { id:'invite-' + now, amount:DISCOUNT, minimum:MINIMUM, expires:now + VALID_DAYS * DAY, used:false, source:'invite-demo' }]
  return state
}
function simulatePurchase(state, bookId, now = Date.now()) {
  if (!state.user) throw new Error('请先登录演示账户')
  if (!eligibleBook(bookId)) throw new Error('这本书暂无购书演示')
  if ((state.demoPurchases || []).includes(bookId)) throw new Error('这本书已经完成演示购买')
  const coupon = applicableCoupon(state, bookId, now)
  if (coupon) coupon.used = true
  state.demoPurchases = [...(state.demoPurchases || []), bookId]
  return { total:PRICE - (coupon ? coupon.amount : 0), couponUsed:!!coupon }
}
module.exports = { BOOK_IDS, PRICE, DISCOUNT, MINIMUM, VALID_DAYS, eligibleBook, activeCoupons, applicableCoupon, simulateInvitation, simulatePurchase }
