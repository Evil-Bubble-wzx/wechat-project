const fields=['studentCode','revision','status','campusId','campusName','campusActive','grade','readingLevel','source','verifiedAt','effectiveFrom']
const date=value=>{if(!value)return '—';const d=new Date(Date.parse(value)+8*3600000);return Number.isFinite(d.getTime())?d.toISOString().slice(0,16).replace('T',' '):'—'}
function normalize(value){
 if(!value||!/^student_[a-f0-9]{32}$/.test(value.studentCode||'')||!/^(0|[1-9][0-9]{0,18})$/.test(value.revision||'')||!['verified','unverified','unassigned'].includes(value.status))throw Error('invalid_profile')
 const result={};for(const key of fields)result[key]=value[key]??null
 return Object.assign(result,{campusLabel:value.campusName||'Unassigned',gradeLabel:result.grade===null?'Pending':result.grade==='k'?'Kindergarten':'Grade '+result.grade,
  levelLabel:result.readingLevel===null?'Pending':'Lv '+result.readingLevel+'.x',statusLabel:value.status==='verified'?'Verified':value.status==='unassigned'?'Unassigned':'Awaiting verification',
  verifiedLabel:date(value.verifiedAt),effectiveLabel:date(value.effectiveFrom)})
}
module.exports={normalize,date}
