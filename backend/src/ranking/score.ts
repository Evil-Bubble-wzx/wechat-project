// Historical v1 snapshots stay intact. v2 sums independent, earned learning facts.
export const RANKING_RULE_VERSION = "learning-points-v2";
export const LEARNING_POINT_RULES = {
  listening: { label: "有效听读", pointsPerUnit: "1", unit: "秒" },
  completion: { label: "首次完成篇章", pointsPerUnit: "50", unit: "篇" },
  quizCorrect: { label: "首次答对题目", pointsPerUnit: "10", unit: "题" },
} as const;
export type RankingFeatureKey = keyof typeof LEARNING_POINT_RULES;
export type LearningScoreFact = { id:string; kind:RankingFeatureKey; points:string };
export type RankingAttemptFact = { workId:string; submittedAt:string; accuracyPercent:number; wordCount:number; bookLevel?:number|null; category?:"fiction"|"nonfiction"|null };
export type RankingParticipantFacts = { participantId:string; attempts:RankingAttemptFact[]; events:LearningScoreFact[] };
export type RankingScoreBreakdown = { key:RankingFeatureKey; label:string; points:string; quantity:string; unit:string };
export type RankingScoreResult = { participantId:string; rank:number; score:string; completedBooks:number; totalWords:number; adjustedAccuracy:number; breakdown:RankingScoreBreakdown[] };

export function selectRankingAttempts(attempts:RankingAttemptFact[]):RankingAttemptFact[] {
  const seen=new Set<string>();
  return [...attempts].sort((a,b)=>Date.parse(a.submittedAt)-Date.parse(b.submittedAt))
    .filter(attempt=>!!attempt.workId.trim()&&Number.isFinite(attempt.accuracyPercent))
    .filter(attempt=>{if(seen.has(attempt.workId))return false;seen.add(attempt.workId);return true});
}
export function scoreLearningEvents(events:LearningScoreFact[]):{score:string;breakdown:RankingScoreBreakdown[]} {
  const totals={listening:0n,completion:0n,quizCorrect:0n},seen=new Map<string,string>();
  for(const event of events){
    if(!event.id||!Object.hasOwn(LEARNING_POINT_RULES,event.kind)||!/^[1-9]\d*$/.test(event.points))throw new Error("Invalid learning score fact");
    const identity=event.kind+":"+event.points;
    if(seen.has(event.id)){if(seen.get(event.id)!==identity)throw new Error("Conflicting learning score event ID");continue}
    seen.set(event.id,identity);
    const points=BigInt(event.points),unit=BigInt(LEARNING_POINT_RULES[event.kind].pointsPerUnit);
    if(points%unit!==0n)throw new Error("Learning score points do not match rule unit");
    totals[event.kind]+=points;
  }
  const breakdown=(Object.keys(LEARNING_POINT_RULES) as RankingFeatureKey[]).map(key=>({
    key,label:LEARNING_POINT_RULES[key].label,points:totals[key].toString(),
    quantity:(totals[key]/BigInt(LEARNING_POINT_RULES[key].pointsPerUnit)).toString(),unit:LEARNING_POINT_RULES[key].unit,
  }));
  return {score:(totals.listening+totals.completion+totals.quizCorrect).toString(),breakdown};
}
export function scoreRankingCohort(participants:RankingParticipantFacts[]):RankingScoreResult[] {
  const seen=new Set<string>();
  const scored=participants.flatMap(participant=>{
    if(!participant.participantId.trim()||seen.has(participant.participantId))throw new Error("Ranking participant IDs must be non-empty and unique");
    seen.add(participant.participantId);
    const points=scoreLearningEvents(participant.events);if(points.score==="0")return [];
    const attempts=selectRankingAttempts(participant.attempts);
    return [{participantId:participant.participantId,rank:0,...points,completedBooks:attempts.length,
      totalWords:attempts.reduce((sum,attempt)=>sum+Math.max(0,Math.round(attempt.wordCount||0)),0),
      adjustedAccuracy:attempts.length?Number((attempts.reduce((sum,attempt)=>sum+Math.max(0,Math.min(100,attempt.accuracyPercent)),0)/attempts.length).toFixed(2)):0}];
  });
  scored.sort((a,b)=>BigInt(a.score)>BigInt(b.score)?-1:BigInt(a.score)<BigInt(b.score)?1:a.participantId.localeCompare(b.participantId));
  scored.forEach((entry,index)=>{entry.rank=index&&entry.score===scored[index-1]!.score?scored[index-1]!.rank:index+1});
  return scored;
}
