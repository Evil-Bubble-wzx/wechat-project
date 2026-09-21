const fs = require('node:fs')
const path = require('node:path')
const { createReviewDraft, createReviewTranscript, writeJson } = require('./review-workflow')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const reviewDir = path.join(packageDir, 'review')
const draft = createReviewDraft(packageDir)
const transcript = createReviewTranscript(packageDir)
const draftPath = path.join(reviewDir, 'review-decisions.json')
const htmlPath = path.join(reviewDir, 'index.html')
const embedded = JSON.stringify(draft).replace(/</g, '\\u003c')
const transcriptEmbedded = JSON.stringify(transcript).replace(/</g, '\\u003c')

const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Peter Rabbit 字幕人耳审核</title>
  <style>
    :root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#17211b;background:#f4f1e8;line-height:1.55}
    *{box-sizing:border-box}body{margin:0}.shell{max-width:1120px;margin:auto;padding:24px}.hero,.transcript,.card,.signoff{background:#fff;border:1px solid #d8d2c3;border-radius:16px;box-shadow:0 6px 20px #4b443415;padding:20px;margin-bottom:18px}
    h1,h2,h3{margin-top:0}.hero h1{margin-bottom:4px}.muted{color:#687069}.warning{background:#fff3cd;border-left:4px solid #c68a00;padding:10px 12px}.progress{height:12px;background:#e7e2d6;border-radius:999px;overflow:hidden}.progress>span{display:block;height:100%;width:0;background:#2f7a53}
    audio{width:100%;margin:12px 0}.toolbar{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.stats{font-variant-numeric:tabular-nums;font-weight:700}.transcript-list{max-height:390px;overflow:auto;border:1px solid #ded8ca;border-radius:10px;background:#faf9f5}.cue-row{display:grid;grid-template-columns:64px 1fr auto;gap:10px;width:100%;padding:10px 12px;border:0;border-bottom:1px solid #ece7dc;border-radius:0;background:transparent;color:#17211b;text-align:left}.cue-row:last-child{border-bottom:0}.cue-row:hover{background:#eef4ef}.cue-row.current{background:#dceee2;box-shadow:inset 4px 0 #2f7a53}.cue-row.omitted{background:#fff4d8}.cue-row.omitted.current{background:#ffe7a8}.cue-time{font-variant-numeric:tabular-nums;color:#687069}.cue-text{min-width:0}.cue-issues{white-space:nowrap}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px}.card{margin:0}.card.done{border-color:#2f7a53}.badge{display:inline-block;border-radius:999px;background:#e9eee9;padding:2px 8px;font-size:12px;margin-right:5px}.quote{background:#f7f6f0;padding:10px;border-radius:8px}.field{display:block;margin:10px 0}.field span{display:block;font-size:13px;color:#59615a}.field input,.field select,.field textarea{width:100%;padding:8px;border:1px solid #b9b5aa;border-radius:7px;background:white}.field textarea{min-height:70px}button{border:0;border-radius:8px;padding:9px 13px;background:#2f7a53;color:white;cursor:pointer}button.secondary{background:#59615a}button:disabled{opacity:.45;cursor:not-allowed}.check{display:flex;gap:8px;align-items:flex-start;margin:10px 0}.check input{margin-top:6px}.errors{color:#a42424;white-space:pre-wrap}.ok{color:#1e6a45}.sticky{position:sticky;bottom:0;z-index:5}.signoff{border:2px solid #2f7a53}code{background:#eee9dd;padding:2px 5px;border-radius:4px}@media(max-width:600px){.shell{padding:12px}.grid{grid-template-columns:1fr}.cue-row{grid-template-columns:54px 1fr}.cue-issues{grid-column:2}}
  </style>
</head>
<body><main class="shell">
  <section class="hero">
    <h1>Peter Rabbit 字幕人耳审核</h1>
    <p class="muted">字幕以录音为准 · 机器建议不是人工批准 · 词汇和权利不在本轮范围</p>
    <p class="warning">必须完整听完 5:22 音频，并逐项确认 26 个低置信词与 2 个漏句。页面数据保存在本机浏览器；最后下载 JSON，再运行校验/应用命令。</p>
    <audio id="audio" controls preload="metadata" src="../source/audio-original.mp3"></audio>
    <div class="toolbar"><button id="playFull">从头完整播放</button><span class="stats" id="listenStats">完整试听覆盖率 0%</span></div>
    <div class="progress"><span id="listenBar"></span></div>
  </section>
  <section class="transcript">
    <h2>全文同步字幕</h2>
    <p class="muted">播放时自动高亮当前句；点击字幕可跳转。黄色行是 O1/O2 漏句候选，仅供听判，不代表录音实际朗读。</p>
    <div class="transcript-list" id="transcript"></div>
  </section>
  <section><h2>重点决策（<span id="decisionStats">0/28</span>）</h2><div class="grid" id="cards"></div></section>
  <section class="signoff sticky">
    <h2>人工签署</h2>
    <label class="field"><span>审核人（必填）</span><input id="reviewer" autocomplete="name" placeholder="姓名或可追溯的审核标识"></label>
    <label class="check"><input type="checkbox" id="fullListen"><span>我已完整听完全文，并确认除上述重点项外，其余字幕内容与时间轴可接受（覆盖率达到 95% 后可勾选）。</span></label>
    <div class="toolbar"><button id="download" disabled>校验并下载正式决策 JSON</button><button id="reset" class="secondary">清除本机草稿</button></div>
    <p id="message" class="errors"></p>
  </section>
</main>
<script>
const initial=${embedded};
const transcript=${transcriptEmbedded};
const storageKey='tingyue-review-'+initial.pieceId+'-'+initial.audio.sha256;
let state=loadState();
const audio=document.getElementById('audio');let clipEnd=null;let lastTime=null;let seeking=false;let activeTranscriptId=null;
function loadState(){try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved&&saved.pieceId===initial.pieceId)return saved}catch{}return {...initial,decisions:initial.decisions.map(x=>({...x})),listenSeconds:[]}}
function save(){localStorage.setItem(storageKey,JSON.stringify(state))}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function ms(value){const s=Math.max(0,Math.round(value/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}
function playRange(start,end){clipEnd=end/1000;audio.currentTime=start/1000;audio.play()}
function renderTranscript(){const root=document.getElementById('transcript');root.innerHTML=transcript.map((cue,index)=>'<button class="cue-row'+(cue.omittedCandidate?' omitted':'')+'" data-cue-index="'+index+'" id="cue-'+esc(cue.id)+'"><span class="cue-time">'+ms(cue.startMs)+'</span><span class="cue-text">'+esc(cue.text)+'</span><span class="cue-issues">'+cue.issueIds.map(id=>'<span class="badge">'+esc(id)+'</span>').join('')+'</span></button>').join('');root.querySelectorAll('[data-cue-index]').forEach(row=>row.onclick=()=>{const cue=transcript[+row.dataset.cueIndex];clipEnd=null;audio.currentTime=cue.startMs/1000;audio.play()})}
function updateTranscript(timeSeconds){const now=Math.round(timeSeconds*1000);const cue=transcript.find(item=>!item.omittedCandidate&&now>=item.startMs&&now<item.endMs)||transcript.find(item=>item.omittedCandidate&&now>=item.startMs&&now<item.endMs);const nextId=cue?cue.id:null;if(nextId===activeTranscriptId)return;const previous=activeTranscriptId&&document.getElementById('cue-'+activeTranscriptId);if(previous)previous.classList.remove('current');activeTranscriptId=nextId;const current=nextId&&document.getElementById('cue-'+nextId);if(current){current.classList.add('current');current.scrollIntoView({block:'nearest',behavior:'smooth'})}}
function render(){const root=document.getElementById('cards');root.innerHTML='';state.decisions.forEach((d,i)=>{const card=document.createElement('article');card.className='card'+(d.confirmed?' done':'');const omitted=d.type==='omittedCue';card.innerHTML='<h3>'+esc(d.id)+' <span class="badge">'+esc(omitted?'整句漏读':d.matchKind)+'</span></h3>'+
  '<p class="quote">'+esc(omitted?d.canonicalText:d.cueText)+'</p>'+
  (omitted?'':'<p>原词：<b>'+esc(d.canonical)+'</b>　识别：<b>'+esc(d.recognized)+'</b></p>')+
  '<button data-play="'+i+'">播放 '+ms(d.listenStartMs)+'–'+ms(d.listenEndMs)+'</button>'+
  '<label class="field"><span>裁决</span><select data-field="action" data-i="'+i+'"><option value="">请选择</option>'+
  (omitted?'<option value="omitCue">录音略读，维持移除</option><option value="restoreCue">录音有该句，按实际文字重建</option>':'<option value="keepCanonical">保留标准文本</option><option value="replaceSurface">按录音替换文本</option><option value="adjustTiming">仅调整时间</option>')+'</select></label>'+
  '<div data-extra="'+i+'"></div><label class="check"><input type="checkbox" data-confirm="'+i+'" '+(d.confirmed?'checked':'')+'><span>我已听判并确认本项</span></label>';
  root.appendChild(card);card.querySelector('select').value=d.action||'';renderExtra(card,d,i)});
  root.querySelectorAll('[data-play]').forEach(b=>b.onclick=()=>{const d=state.decisions[+b.dataset.play];playRange(d.listenStartMs,d.listenEndMs)});
  root.querySelectorAll('[data-field]').forEach(el=>el.onchange=()=>{const d=state.decisions[+el.dataset.i];d[el.dataset.field]=el.value||null;d.confirmed=false;save();render()});
  root.querySelectorAll('[data-confirm]').forEach(el=>el.onchange=()=>{const d=state.decisions[+el.dataset.confirm];d.confirmed=el.checked;save();render()});
  updateSummary()}
function renderExtra(card,d,i){const box=card.querySelector('[data-extra]');let html='';if(d.action==='replaceSurface')html='<label class="field"><span>按录音替换为</span><input data-text="replacementText" data-i="'+i+'" value="'+esc(d.replacementText||'')+'"></label>';if(d.action==='adjustTiming'||d.action==='restoreCue')html+=(d.action==='restoreCue'?'<label class="field"><span>录音实际文字</span><textarea data-text="actualText" data-i="'+i+'">'+esc(d.actualText||'')+'</textarea></label>':'')+'<div class="toolbar"><label class="field"><span>开始 ms</span><input type="number" data-num="startMs" data-i="'+i+'" value="'+esc(d.startMs??'')+'"></label><label class="field"><span>结束 ms</span><input type="number" data-num="endMs" data-i="'+i+'" value="'+esc(d.endMs??'')+'"></label></div>';if(d.action==='omitCue')html='<label class="field"><span>略读理由（必填）</span><textarea data-text="reason" data-i="'+i+'">'+esc(d.reason||'')+'</textarea></label>';box.innerHTML=html;box.querySelectorAll('[data-text]').forEach(el=>el.oninput=()=>{state.decisions[+el.dataset.i][el.dataset.text]=el.value;save()});box.querySelectorAll('[data-num]').forEach(el=>el.oninput=()=>{state.decisions[+el.dataset.i][el.dataset.num]=el.value===''?null:Number(el.value);save()})}
function coverage(){const total=Math.ceil(initial.audio.durationMs/1000);const valid=new Set((state.listenSeconds||[]).filter(second=>Number.isInteger(second)&&second>=0&&second<total));const raw=valid.size/total;return raw>=.995?1:raw}
function updateSummary(){const done=state.decisions.filter(d=>d.confirmed).length;const cov=coverage();document.getElementById('decisionStats').textContent=done+'/'+state.decisions.length;document.getElementById('listenStats').textContent='完整试听覆盖率 '+(cov*100).toFixed(1)+'%';document.getElementById('listenBar').style.width=Math.min(100,cov*100)+'%';const check=document.getElementById('fullListen');check.disabled=cov<.95;if(cov<.95){check.checked=false;state.signoff.fullListenCompleted=false}document.getElementById('reviewer').value=state.signoff.reviewer||'';document.getElementById('download').disabled=!(done===state.decisions.length&&cov>=.95&&state.signoff.fullListenCompleted&&state.signoff.reviewer);save()}
function validate(){const errors=[];state.decisions.forEach(d=>{if(!d.confirmed)errors.push(d.id+' 未确认');if(!d.action)errors.push(d.id+' 未选择裁决');if(d.action==='replaceSurface'&&!String(d.replacementText||'').trim())errors.push(d.id+' 缺少替换文本');if(d.action==='omitCue'&&!String(d.reason||'').trim())errors.push(d.id+' 缺少略读理由');if((d.action==='adjustTiming'||d.action==='restoreCue')&&!(Number.isInteger(d.startMs)&&Number.isInteger(d.endMs)&&d.endMs>d.startMs))errors.push(d.id+' 时间无效');if(d.action==='restoreCue'&&!String(d.actualText||'').trim())errors.push(d.id+' 缺少录音实际文字')});if(!state.signoff.reviewer)errors.push('缺少审核人');if(!state.signoff.fullListenCompleted||coverage()<.95)errors.push('尚未完成全文试听签署');return errors}
audio.addEventListener('seeking',()=>{seeking=true});audio.addEventListener('seeked',()=>{seeking=false;lastTime=audio.currentTime;updateTranscript(audio.currentTime)});audio.addEventListener('timeupdate',()=>{const now=audio.currentTime;updateTranscript(now);if(!seeking&&!audio.paused&&lastTime!==null&&now>=lastTime&&now-lastTime<2.5){state.listenSeconds=state.listenSeconds||[];const seen=new Set(state.listenSeconds);for(let s=Math.floor(lastTime);s<=Math.floor(now);s++)seen.add(s);state.listenSeconds=[...seen];updateSummary()}lastTime=now;if(clipEnd!==null&&now>=clipEnd){audio.pause();clipEnd=null}});audio.addEventListener('ended',()=>{state.listenSeconds=state.listenSeconds||[];const seen=new Set(state.listenSeconds);seen.add(Math.floor(initial.audio.durationMs/1000));state.listenSeconds=[...seen];lastTime=audio.duration;updateTranscript(audio.duration);updateSummary()});
document.getElementById('playFull').onclick=()=>{clipEnd=null;audio.currentTime=0;audio.play()};document.getElementById('reviewer').oninput=e=>{state.signoff.reviewer=e.target.value;updateSummary()};document.getElementById('fullListen').onchange=e=>{state.signoff.fullListenCompleted=e.target.checked;state.signoff.fullListenCoverage=coverage();state.signoff.fullListenCompletedAt=e.target.checked?new Date().toISOString():null;updateSummary()};document.getElementById('download').onclick=()=>{const errors=validate();const message=document.getElementById('message');if(errors.length){message.textContent=errors.join('\\n');return}state.status='completed';state.signoff.fullListenCoverage=coverage();state.signoff.reviewedAt=new Date().toISOString();const exportState={...state};delete exportState.listenSeconds;const blob=new Blob([JSON.stringify(exportState,null,2)+'\\n'],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='review-decisions.completed.json';a.click();URL.revokeObjectURL(a.href);message.className='ok';message.textContent='已下载。请把文件放进 review/ 后运行 npm run content:peter:review:check，再运行 apply。';save()};document.getElementById('reset').onclick=()=>{if(confirm('确定清除本机审核草稿？')){localStorage.removeItem(storageKey);location.reload()}};
renderTranscript();render();
</script></body></html>`

fs.mkdirSync(reviewDir, { recursive: true })
writeJson(draftPath, draft)
fs.writeFileSync(htmlPath, html, 'utf8')
console.log(`Built review workbench: ${htmlPath}`)
console.log(`Draft decisions: ${draftPath} (${draft.decisions.length} decisions)`)
