const fs = require('node:fs')
const path = require('node:path')
const {
  bindPendingVocabulary,
  createVocabularyCandidates,
  createVocabularyReviewDraft,
  readJson,
  writeJson
} = require('./vocab-review-workflow')

const packageDir = path.resolve(process.argv[2] || 'content/peter-rabbit/peter-rabbit-01')
const reviewDir = path.join(packageDir, 'review')
const workDir = path.join(packageDir, 'work')
const candidates = createVocabularyCandidates(packageDir)
const draft = createVocabularyReviewDraft(candidates)
const reboundCues = bindPendingVocabulary(packageDir, candidates)
writeJson(path.join(workDir, 'vocab.candidates.json'), candidates)
writeJson(path.join(reviewDir, 'vocab-decisions.json'), draft)

const qaPath = path.join(packageDir, 'dist', 'qa-report.json')
const manifestPath = path.join(packageDir, 'dist', 'manifest.json')
const qa = readJson(qaPath)
const manifest = readJson(manifestPath)
qa.generatedAt = new Date().toISOString()
qa.checks.vocabularyApproved = false
qa.checks.humanReviewComplete = false
qa.publishable = false
qa.counts.cues = reboundCues.length
qa.counts.clickableTokens = candidates.counts.clickableTokens
qa.counts.vocabEntries = candidates.counts.reviewUnits
qa.vocabularyReview = {
  status: 'ready_for_review',
  reviewUnitCount: candidates.counts.reviewUnits,
  evidenceMatchedUnits: candidates.counts.evidenceMatchedUnits,
  highRiskUnits: candidates.counts.highRiskUnits,
  sourceCueSha256: candidates.sourceCueSha256
}
qa.blockers = [
  `${candidates.counts.reviewUnits} vocabulary review units require human editorial approval.`,
  'Vocabulary editorial review is pending.',
  'Rights need release-jurisdiction review.'
]
manifest.publishable = false
manifest.status = 'needs_review'
manifest.counts.cues = reboundCues.length
manifest.counts.clickableTokens = candidates.counts.clickableTokens
manifest.counts.vocabEntries = candidates.counts.reviewUnits
manifest.vocabularyReview = qa.vocabularyReview
manifest.artifacts.vocabCandidates = 'work/vocab.candidates.json'
manifest.artifacts.vocabReviewDecisions = 'review/vocab-decisions.json'
manifest.artifacts.vocabReviewWorkbench = 'review/vocab-index.html'
manifest.blockers = [...qa.blockers]
writeJson(qaPath, qa)
writeJson(manifestPath, manifest)

const embedded = JSON.stringify(draft).replace(/</g, '\\u003c')
const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Peter Rabbit 词汇编辑审核</title>
<style>
:root{font-family:Inter,"Microsoft YaHei",sans-serif;color:#17211b;background:#f4f1e8;line-height:1.5}*{box-sizing:border-box}body{margin:0}.shell{max-width:1180px;margin:auto;padding:22px}.panel,.editor,.signoff{background:#fff;border:1px solid #d8d2c3;border-radius:14px;padding:18px;margin-bottom:16px;box-shadow:0 5px 18px #4b443414}h1,h2,h3{margin-top:0}.muted{color:#69716a}.warning{padding:10px 12px;border-left:4px solid #bd8100;background:#fff3cd}.toolbar{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.toolbar>*{min-width:0}button{border:0;border-radius:8px;padding:9px 13px;background:#2f7a53;color:#fff;cursor:pointer}button.secondary{background:#657068}button.danger{background:#9d3535}button:disabled{opacity:.45;cursor:not-allowed}input,select,textarea{width:100%;padding:8px;border:1px solid #b9b5aa;border-radius:7px;background:#fff}.search{flex:1;min-width:220px}.progress{height:11px;background:#e5e0d3;border-radius:99px;overflow:hidden}.progress span{display:block;height:100%;background:#2f7a53}.layout{display:grid;grid-template-columns:280px 1fr;gap:15px}.list{max-height:70vh;overflow:auto;border:1px solid #ddd6c7;border-radius:9px}.list button{display:block;width:100%;border-radius:0;border-bottom:1px solid #eee8db;background:#fff;color:#17211b;text-align:left}.list button.active{background:#dceee2}.list button.done{box-shadow:inset 4px 0 #2f7a53}.badge{display:inline-block;border-radius:999px;padding:2px 7px;background:#ece8df;font-size:12px;margin:2px}.risk{background:#ffe4d6}.field{display:block;margin:10px 0}.field>span{display:block;color:#59615a;font-size:13px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.sense{border:1px solid #d9d3c5;border-radius:10px;padding:12px;margin:12px 0}.evidence{max-height:220px;overflow:auto;background:#f7f5ef;border-radius:8px;padding:10px}.occurrence{padding:8px;border-bottom:1px solid #e8e1d5}.occurrence:last-child{border:0}.quote{background:#f7f5ef;border-radius:8px;padding:10px}.errors{color:#a42424;white-space:pre-wrap}.ok{color:#1e6a45}.signoff{border:2px solid #2f7a53}.sticky{position:sticky;bottom:0}audio{width:100%}@media(max-width:760px){.shell{padding:10px}.layout{grid-template-columns:1fr}.list{max-height:260px}.grid{grid-template-columns:1fr}}
</style></head><body><main class="shell">
<section class="panel"><h1>Peter Rabbit 词汇编辑审核</h1><p class="muted">机器候选不是人工批准 · 以 59 条已审核字幕为唯一输入 · 英式 IPA 优先</p><p class="warning">共 <b>${draft.counts.reviewUnits}</b> 个动态审核单元、${draft.counts.clickableTokens} 个可收录 token。每个最终义项都必须人工确认 lemma、词性、IPA、儿童化英文释义和中文释义；未达到 100% 不可导出 completed 文件。</p><audio id="audio" controls preload="metadata" src="../source/audio-original.mp3"></audio><div class="toolbar"><input class="search" id="search" placeholder="搜索词形、lemma、例句"><select id="risk"><option value="all">全部风险</option><option value="high">有风险标记</option><option value="unmatched">无开放来源匹配</option><option value="done">已确认</option><option value="todo">未确认</option></select><span id="stats"></span></div><div class="progress"><span id="bar"></span></div></section>
<section class="layout"><div class="list" id="list"></div><article class="editor" id="editor"></article></section>
<section class="signoff sticky"><h2>人工签署</h2><div class="toolbar"><label class="field" style="flex:1"><span>审核人（最终填写 wzx）</span><input id="reviewer" placeholder="审核标识"></label><button id="saveDraft" class="secondary">下载草稿</button><label><input type="file" id="importFile" accept="application/json" hidden><button id="importButton" type="button" class="secondary">导入草稿</button></label><button id="download" disabled>校验并下载 completed</button><button id="reset" class="danger">清除本机草稿</button></div><p id="message" class="errors"></p></section>
</main><script>
const initial=${embedded};const storageKey='tingyue-vocab-review-'+initial.pieceId+'-'+initial.sourceCueSha256;let state=load();let selectedId=state.entries[0]?.id||null;let clipEnd=null;
function clone(x){return JSON.parse(JSON.stringify(x))}function load(){try{const x=JSON.parse(localStorage.getItem(storageKey));if(x?.pieceId===initial.pieceId&&x?.sourceCueSha256===initial.sourceCueSha256)return x}catch{}return clone(initial)}function save(){localStorage.setItem(storageKey,JSON.stringify(state))}function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}function ms(v){const s=Math.max(0,Math.round(v/1000));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')}function current(){return state.entries.find(x=>x.id===selectedId)}
function filtered(){const q=document.getElementById('search').value.trim().toLowerCase(),risk=document.getElementById('risk').value;return state.entries.filter(e=>{const text=[e.normalized,...e.surfaces,...e.senses.map(s=>s.lemma)].join(' ').toLowerCase();if(q&&!text.includes(q))return false;if(risk==='high'&&!e.riskFlags.length)return false;if(risk==='unmatched'&&!e.riskFlags.includes('no_open_source_match'))return false;if(risk==='done'&&!e.confirmed)return false;if(risk==='todo'&&e.confirmed)return false;return true})}
function renderList(){const root=document.getElementById('list'),items=filtered();if(!items.some(e=>e.id===selectedId)&&items[0])selectedId=items[0].id;root.innerHTML=items.map(e=>'<button data-id="'+e.id+'" class="'+(e.id===selectedId?'active ':'')+(e.confirmed?'done':'')+'"><b>'+esc(e.reviewId)+' · '+esc(e.normalized)+'</b><br><span class="muted">'+e.occurrences.length+' 次 · '+e.riskFlags.length+' 风险</span></button>').join('');root.querySelectorAll('[data-id]').forEach(b=>b.onclick=()=>{selectedId=b.dataset.id;render()})}
function senseHtml(s,i,e){const pos=['noun','verb','adjective','adverb','pronoun','determiner','preposition','conjunction','auxiliary','interjection','numeral','particle','other'];return '<section class="sense"><div class="toolbar"><h3 style="margin:0">义项 '+(i+1)+'</h3>'+(e.senses.length>1?'<button class="danger" data-remove-sense="'+i+'">删除义项</button>':'')+'</div><div class="grid"><label class="field"><span>Lemma</span><input data-s="'+i+'" data-f="lemma" value="'+esc(s.lemma||'')+'"></label><label class="field"><span>词性</span><select data-s="'+i+'" data-f="partOfSpeech"><option value="">请选择</option>'+pos.map(p=>'<option '+(s.partOfSpeech===p?'selected':'')+'>'+p+'</option>').join('')+'</select></label><label class="field"><span>义项号</span><input type="number" min="1" data-s="'+i+'" data-f="senseNo" value="'+esc(s.senseNo||1)+'"></label><label class="field"><span>英式 IPA（含 / /）</span><input data-s="'+i+'" data-f="phonetic" value="'+esc(s.phonetic||'')+'"></label></div><label class="field"><span>儿童化英文释义（当前语境）</span><textarea data-s="'+i+'" data-f="definitionEn">'+esc(s.definitionEn||'')+'</textarea></label><label class="field"><span>中文释义（当前语境）</span><textarea data-s="'+i+'" data-f="definitionZh">'+esc(s.definitionZh||'')+'</textarea></label></section>'}
function renderEditor(){const e=current(),root=document.getElementById('editor');if(!e){root.innerHTML='<p>没有匹配项。</p>';return}root.innerHTML='<div class="toolbar"><h2 style="margin:0">'+esc(e.reviewId)+' · '+esc(e.normalized)+'</h2>'+e.riskFlags.map(x=>'<span class="badge risk">'+esc(x)+'</span>').join('')+'</div><p>表面形式：'+e.surfaces.map(x=>'<span class="badge">'+esc(x)+'</span>').join('')+'</p><label class="field"><span>裁决</span><select id="action"><option value="">请选择</option><option value="approve" '+(e.action==='approve'?'selected':'')+'>纳入正式词表</option><option value="excludeProperNoun" '+(e.action==='excludeProperNoun'?'selected':'')+'>重新分类为专名并排除</option></select></label>'+(e.action==='excludeProperNoun'?'<label class="field"><span>排除理由</span><textarea id="exclusion">'+esc(e.exclusionReason||'')+'</textarea></label>':e.senses.map((s,i)=>senseHtml(s,i,e)).join('')+'<button id="addSense" class="secondary">拆分新义项</button>')+'<h3>出现位置</h3><div>'+e.occurrences.map((o,i)=>'<div class="occurrence"><div class="toolbar"><button data-play="'+i+'">播放 '+ms(o.startMs)+'–'+ms(o.endMs)+'</button><b>'+esc(o.surface)+'</b>'+(e.action==='approve'&&e.senses.length>1?'<select data-occ="'+i+'">'+e.senses.map((s,si)=>'<option value="'+si+'" '+((s.occurrenceTokenIds||[]).includes(o.tokenId)?'selected':'')+'>义项 '+(si+1)+'</option>').join('')+'</select>':'')+'</div><div class="quote">'+esc(o.cueText)+'</div></div>').join('')+'</div><h3>开放来源证据（仅供选义，不可直接视为审核结论）</h3><div class="evidence">'+(e.evidence.length?e.evidence.map((x,i)=>'<p><button data-use="'+i+'">采用词形/POS/IPA</button> <b>'+esc(x.lemma)+' · '+esc(x.partOfSpeech||'?')+' · '+esc(x.phonetic||'无 IPA')+'</b><br>'+esc(x.gloss||'无释义')+'<br><small>'+esc(x.ref)+'</small></p>').join(''):'<p>无匹配；必须人工填写并说明。</p>')+'</div><label class="field"><span>审核备注</span><textarea id="note">'+esc(e.note||'')+'</textarea></label><label><input type="checkbox" id="confirmed" '+(e.confirmed?'checked':'')+'> 我已核对全部字段、例句和出现位置</label>';
document.getElementById('action').onchange=x=>{e.action=x.target.value||null;e.confirmed=false;save();render()};const exclusion=document.getElementById('exclusion');if(exclusion)exclusion.oninput=x=>{e.exclusionReason=x.target.value;e.confirmed=false;save()};root.querySelectorAll('[data-s][data-f]').forEach(x=>x.oninput=()=>{const s=e.senses[+x.dataset.s];s[x.dataset.f]=x.dataset.f==='senseNo'?Number(x.value):x.value;e.confirmed=false;save()});root.querySelectorAll('[data-play]').forEach(x=>x.onclick=()=>{const o=e.occurrences[+x.dataset.play],a=document.getElementById('audio');clipEnd=o.endMs/1000;a.currentTime=Math.max(0,o.startMs/1000-.5);a.play()});root.querySelectorAll('[data-use]').forEach(x=>x.onclick=()=>{const v=e.evidence[+x.dataset.use],s=e.senses[0];s.lemma=v.lemma;s.partOfSpeech=v.partOfSpeech||s.partOfSpeech;s.phonetic=v.phonetic||s.phonetic;s.evidenceRefs=[v.ref];e.confirmed=false;save();render()});root.querySelectorAll('[data-remove-sense]').forEach(x=>x.onclick=()=>{const index=+x.dataset.removeSense;e.senses.splice(index,1);for(const o of e.occurrences){if(!e.senses.some(s=>(s.occurrenceTokenIds||[]).includes(o.tokenId)))e.senses[0].occurrenceTokenIds.push(o.tokenId)}e.confirmed=false;save();render()});root.querySelectorAll('[data-occ]').forEach(x=>x.onchange=()=>{const o=e.occurrences[+x.dataset.occ];for(const s of e.senses)s.occurrenceTokenIds=(s.occurrenceTokenIds||[]).filter(id=>id!==o.tokenId);e.senses[+x.value].occurrenceTokenIds.push(o.tokenId);e.confirmed=false;save()});const add=document.getElementById('addSense');if(add)add.onclick=()=>{e.senses.push({entryId:null,lemma:e.senses[0].lemma,partOfSpeech:e.senses[0].partOfSpeech,senseNo:e.senses.length+1,phonetic:e.senses[0].phonetic,definitionEn:null,definitionZh:null,occurrenceTokenIds:[],evidenceRefs:[]});e.confirmed=false;save();render()};document.getElementById('note').oninput=x=>{e.note=x.target.value;save()};document.getElementById('confirmed').onchange=x=>{e.confirmed=x.target.checked;save();render()}}
function validateEntry(e){const errors=[];if(!e.confirmed)errors.push(e.reviewId+' 未确认');if(!e.action)errors.push(e.reviewId+' 未选择裁决');if(e.action==='excludeProperNoun'&&!String(e.exclusionReason||'').trim())errors.push(e.reviewId+' 缺少排除理由');if(e.action==='approve'){const assigned=[];for(const [i,s] of e.senses.entries()){if(!s.lemma||!s.partOfSpeech||!s.phonetic||!s.definitionEn||!s.definitionZh)errors.push(e.reviewId+' 义项 '+(i+1)+' 字段不完整');const ipa=String(s.phonetic||'');if(!(ipa.length>2&&ipa.startsWith('/')&&ipa.endsWith('/')))errors.push(e.reviewId+' 义项 '+(i+1)+' IPA 必须包含 / /');assigned.push(...(s.occurrenceTokenIds||[]))}const expected=e.occurrences.map(o=>o.tokenId);if(new Set(assigned).size!==assigned.length||expected.some(id=>!assigned.includes(id))||assigned.some(id=>!expected.includes(id)))errors.push(e.reviewId+' 出现位置未恰好分配一次')}return errors}
function summary(){const done=state.entries.filter(e=>e.confirmed).length,pct=done/state.entries.length*100;document.getElementById('stats').textContent=done+'/'+state.entries.length+' 已确认';document.getElementById('bar').style.width=pct+'%';document.getElementById('reviewer').value=state.signoff.reviewer||'';document.getElementById('download').disabled=!(done===state.entries.length&&state.signoff.reviewer)}function render(){renderList();renderEditor();summary();save()}
function download(name,value){const blob=new Blob([JSON.stringify(value,null,2)+'\\n'],{type:'application/json'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();URL.revokeObjectURL(a.href)}
document.getElementById('search').oninput=render;document.getElementById('risk').onchange=render;document.getElementById('reviewer').oninput=e=>{state.signoff.reviewer=e.target.value;save();summary()};document.getElementById('saveDraft').onclick=()=>download('vocab-decisions.json',state);document.getElementById('importButton').onclick=()=>document.getElementById('importFile').click();document.getElementById('importFile').onchange=async e=>{try{const x=JSON.parse(await e.target.files[0].text());if(x.pieceId!==initial.pieceId||x.sourceCueSha256!==initial.sourceCueSha256)throw Error('文件与当前字幕版本不匹配');state=x;selectedId=state.entries[0]?.id;save();render()}catch(err){document.getElementById('message').textContent=err.message}};document.getElementById('download').onclick=()=>{const errors=state.entries.flatMap(validateEntry);if(!state.signoff.reviewer)errors.push('缺少审核人');if(errors.length){document.getElementById('message').textContent=errors.slice(0,80).join('\\n');return}state.status='completed';state.signoff.reviewedAt=new Date().toISOString();download('vocab-decisions.completed.json',state);document.getElementById('message').className='ok';document.getElementById('message').textContent='已下载；请放入 review/ 后运行词汇校验与应用命令。';save()};document.getElementById('reset').onclick=()=>{if(confirm('确定清除本机词汇审核草稿？')){localStorage.removeItem(storageKey);location.reload()}};document.getElementById('audio').addEventListener('timeupdate',e=>{if(clipEnd!==null&&e.target.currentTime>=clipEnd){e.target.pause();clipEnd=null}});render();
</script></body></html>`

fs.writeFileSync(path.join(reviewDir, 'vocab-index.html'), html, 'utf8')
console.log(JSON.stringify({
  workbench: path.join(reviewDir, 'vocab-index.html'),
  reviewUnits: candidates.counts.reviewUnits,
  clickableTokens: candidates.counts.clickableTokens,
  evidenceMatchedUnits: candidates.counts.evidenceMatchedUnits,
  highRiskUnits: candidates.counts.highRiskUnits,
  vocabularyApproved: false,
  publishable: false
}, null, 2))
