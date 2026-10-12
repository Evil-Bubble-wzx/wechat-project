export type AnalysisFact = {
  attemptId:string;pieceId:string;verifiedAt:string;passed:boolean;correctPercent:number;
  wordCount:number|null;level:number|null;category:"fiction"|"nonfiction"|null;
};
const average=(values:number[])=>values.length?Number((values.reduce((a,b)=>a+b,0)/values.length).toFixed(2)):null;
function group(rows:AnalysisFact[]){
  const levels=(input:AnalysisFact[])=>input.flatMap(row=>row.level===null?[]:[row.level]);
  const chronological=[...rows].sort((a,b)=>a.verifiedAt.localeCompare(b.verifiedAt)||a.attemptId.localeCompare(b.attemptId));
  const trendReady=rows.length>=6,early=chronological.slice(0,3),recent=chronological.slice(-3);
  const categorized=rows.filter(row=>row.category!==null);
  return {
    pieces:rows.length,words:rows.some(row=>row.wordCount===null)?null:rows.reduce((sum,row)=>sum+BigInt(row.wordCount!),0n).toString(),
    averageCorrect:average(rows.map(row=>row.correctPercent)),averageLevel:average(levels(rows)),
    fictionPercent:categorized.length?Number((categorized.filter(row=>row.category==="fiction").length/categorized.length*100).toFixed(2)):null,
    categorizedPieces:categorized.length,leveledPieces:levels(rows).length,trendReady,
    earlyCorrect:trendReady?average(early.map(row=>row.correctPercent)):null,
    recentCorrect:trendReady?average(recent.map(row=>row.correctPercent)):null,
    earlyLevel:trendReady&&levels(early).length===3?average(levels(early)):null,
    recentLevel:trendReady&&levels(recent).length===3?average(levels(recent)):null
  };
}
export function quizAnalysis(rows:AnalysisFact[]){
  const latest=new Map<string,AnalysisFact>();
  for(const row of rows){
    const previous=latest.get(row.pieceId);
    if(!previous||row.verifiedAt>previous.verifiedAt||row.verifiedAt===previous.verifiedAt&&row.attemptId>previous.attemptId)latest.set(row.pieceId,row);
  }
  const selected=[...latest.values()];
  return {schemaVersion:1 as const,unit:"pieces" as const,selection:"latest_verified_per_piece" as const,
    attempts:rows.length,passedAttempts:rows.filter(row=>row.passed).length,
    passed:group(selected.filter(row=>row.passed)),all:group(selected)};
}
