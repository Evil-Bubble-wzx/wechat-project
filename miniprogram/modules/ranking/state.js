const states = ['unauthenticated','unavailable','loading','choose_campus','cohort_too_small','error','ready']
const copy = {
  unauthenticated:['登录后查看排行榜','排行榜只使用账户下的服务端验证成绩。'],
  unavailable:['排行榜服务尚未开放','当前没有服务端验证成绩，不展示用户名、名次或虚构榜单。'],
  loading:['正在加载排行榜','请稍候。'],
  choose_campus:['请选择校区','选择校区后查看真实成绩榜单。'],
  cohort_too_small:['样本暂时不足','达到运营设定的真实样本门槛后才展示榜单。'],
  error:['排行榜加载失败','请检查网络后重试。'],
  ready:['排行榜','仅展示服务端验证成绩。']
}
function view(status='unavailable') {
  const safe=states.includes(status)?status:'unavailable'
  return {status:safe,title:copy[safe][0],description:copy[safe][1]}
}
module.exports={states,view}
