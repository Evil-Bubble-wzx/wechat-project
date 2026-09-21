function reserve(loans, book) {
  if (!book.stock) throw new Error('这本书暂时无可借库存')
  if (loans.some(l => l.bookId === book.id && l.status !== 'cancelled')) throw new Error('你已经预约或借阅了这本书')
  return [{ id:'demo-' + Date.now(), bookId:book.id, status:'reserved', label:'待备书', due:'馆员备书后通知取书', renewals:0 }, ...loans]
}
function renew(loan) {
  if (loan.status !== 'borrowed' || loan.renewals >= 1) throw new Error('当前借阅不可续借')
  return Object.assign({}, loan, { renewals:1, due:'已续借 7 天 · 演示记录' })
}
module.exports = { reserve, renew }
