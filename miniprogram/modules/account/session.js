function demoLogin(method, phone, code, agreed) {
  if (!agreed) throw new Error('请先阅读并同意用户协议和隐私政策')
  if (method === 'phone' && (!/^1\d{10}$/.test(phone) || code !== '123456')) throw new Error('请输入正确手机号和演示验证码 123456')
  return { id:'demo-reader', name:'小小阅读家', method, demo:true }
}
module.exports = { demoLogin }
