// Browser-only WXML preview bridge. Native pages use the exact same template and controller.
const names={home:'首页',library:'书库',loans:'实体借阅',me:'我的',detail:'图书详情',player:'听读播放器',recent:'最近听读',report:'阅读报告',ranking:'阅读榜单',login:'登录 / 注册',coupons:'我的优惠券',invite:'邀请奖励',quiz:'阅读测验'}
const app=document.getElementById('app'),device=document.getElementById('device')
let source,current,pageName
function evaluate(expr,scope){try{return Function('s','with(s){return ('+expr+')}')(scope)}catch(e){console.error('Binding failed',expr,e);return ''}}
function value(text,scope){const exact=text.match(/^\{\{([^{}]*?)\}\}$/);if(exact)return evaluate(exact[1],scope);return text.replace(/\{\{([\s\S]*?)\}\}/g,(_,expr)=>{const v=evaluate(expr,scope);return v==null?'':String(v)})}
function renderNode(node,scope,inLoop=false){
  if(node.nodeType===3)return document.createTextNode(value(node.textContent,scope))
  if(node.nodeType!==1)return null
  if(node.hasAttribute('wx:for')&&!inLoop){const frag=document.createDocumentFragment(),items=value(node.getAttribute('wx:for'),scope)||[],itemName=node.getAttribute('wx:for-item')||'item',indexName=node.getAttribute('wx:for-index')||'index';items.forEach((item,index)=>{const el=renderNode(node,{...scope,[itemName]:item,[indexName]:index},true);if(el)frag.appendChild(el)});return frag}
  if(node.hasAttribute('wx:if')&&!value(node.getAttribute('wx:if'),scope))return null
  const tag=node.tagName.toLowerCase(),isSlider=tag==='slider',el=document.createElement(({view:'div',text:'span',image:'img',slider:'input'})[tag]||tag)
  let handler
  for(const a of node.attributes){
    if(a.name.startsWith('wx:'))continue
    if(a.name.startsWith('bind')||a.name.startsWith('catch')){
      handler=a.value
      const event=a.name.replace(/^(bind|catch):?/,'');const domEvent=event==='tap'?'click':event==='longpress'?'contextmenu':event
      el.dataset.action=handler
      el.addEventListener(domEvent,e=>{if(a.name.startsWith('catch'))e.stopPropagation();if(event==='longpress')e.preventDefault();current[a.value]?.({currentTarget:{dataset:{...el.dataset}},detail:{value:el.value},target:e.target})})
      if(domEvent==='click'&&!['button','input'].includes(tag)){el.setAttribute('role','button');el.tabIndex=0;el.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();el.click()}})}
    }else {const v=value(a.value,scope);if(a.name==='disabled'){el.disabled=!!v}else if(a.name==='value'){el.value=v}else if(a.name==='class')el.className=v;else if(a.name!=='mode')el.setAttribute(a.name,String(v))}
  }
  if(tag==='img'||tag==='image'){el.alt='';el.draggable=false}
  if(tag==='input'&&el.type==='number'){el.type='text';el.inputMode='numeric'}
  if(isSlider){el.type='range';el.setAttribute('aria-label','听读进度')}
  if(tag==='input'&&node.hasAttribute('placeholder'))el.setAttribute('aria-label',node.getAttribute('placeholder'))
  for(const child of node.childNodes){const rendered=renderNode(child,scope);if(rendered)el.appendChild(rendered)}
  return el
}
function render(){
  const active=document.activeElement,action=active?.dataset?.action,selection=active?.selectionStart,scroll=device.scrollTop
  const frag=document.createDocumentFragment();for(const node of source.childNodes){const el=renderNode(node,current.data);if(el)frag.appendChild(el)}app.replaceChildren(frag)
  // Fixed controls belong to the non-scrolling phone frame in the browser preview.
  const shell=document.querySelector('.phone-shell')
  shell.querySelectorAll(':scope > .bottom-nav, :scope > .modal-backdrop').forEach(el=>el.remove())
  for(const selector of ['.bottom-nav','.modal-backdrop']){const el=app.querySelector(selector);if(el)shell.appendChild(el)}
  device.scrollTop=scroll
  if(action){const field=app.querySelector('input[data-action="'+action+'"]');if(field){field.focus({preventScroll:true});if(typeof selection==='number'&&field.type!=='range')field.setSelectionRange(selection,selection)}}
}
function mount(){
  const [route,search]=(location.hash.slice(1)||'home').split('?');pageName=names[route]?route:'home';const options=Object.fromEntries(new URLSearchParams(search||''));current=window.Tingyue.createPage(pageName);window.currentPage=current
  current.data=structuredClone(current.data);current.setData=function(updates){Object.assign(this.data,updates);render()};current.onLoad(options);render();device.scrollTop=0
  document.querySelectorAll('#screens a').forEach(a=>a.classList.toggle('active',a.dataset.page===pageName));document.getElementById('screen-label').textContent=String(Object.keys(names).indexOf(pageName)+1).padStart(2,'0')+' — '+names[pageName];document.title=names[pageName]+' · 听阅 Tingyue'
}
document.getElementById('screens').innerHTML=Object.entries(names).map(([id,name],i)=>'<a href="#'+id+'" data-page="'+id+'"><span>'+String(i+1).padStart(2,'0')+'</span>'+name+'</a>').join('')
fetch('/screen.wxml').then(r=>r.text()).then(text=>{const template=document.createElement('template');template.innerHTML=text.replace(/<slider([^>]*?)\/>/g,'<slider$1></slider>');source=template.content;mount();window.addEventListener('hashchange',mount)})
