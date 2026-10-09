import assert from "node:assert/strict";
import test from "node:test";
import {RANKING_RULE_VERSION,LEARNING_POINT_RULES,scoreLearningEvents,scoreRankingCohort,type LearningScoreFact} from "../src/ranking/score.ts";
const fact=(id:string,kind:LearningScoreFact["kind"],points:string):LearningScoreFact=>({id,kind,points});
test("v2 has explicit additive unit rules and no maximum",()=>{
 assert.equal(RANKING_RULE_VERSION,"learning-points-v2");
 assert.deepEqual(Object.values(LEARNING_POINT_RULES).map(rule=>rule.pointsPerUnit),["1","50","10"]);
});
test("each new learning portion increases points even before any Quiz",()=>{
 const before=scoreLearningEvents([fact("p1","listening","12")]);
 const after=scoreLearningEvents([fact("p1","listening","12"),fact("p2","listening","3"),fact("q1","quizCorrect","10"),fact("done","completion","50")]);
 assert.equal(before.score,"12");assert.equal(after.score,"75");
 assert.equal(after.breakdown.reduce((sum,part)=>sum+BigInt(part.points),0n).toString(),after.score);
});
test("replaying an event cannot increase points; conflicting IDs fail closed",()=>{
 const event=fact("once","listening","100");
 assert.equal(scoreLearningEvents([event,event]).score,"100");
 assert.throws(()=>scoreLearningEvents([event,{...event,points:"101"}]),/Conflicting/);
});
test("points exceed 1000 and JS safe integers without truncation",()=>{
 const huge="900719925474099312345678901";
 assert.equal(scoreLearningEvents([fact("large","listening",huge),fact("more","quizCorrect","10")]).score,(BigInt(huge)+10n).toString());
});
test("cohort changes never change personal scores; equal totals share rank",()=>{
 const a={participantId:"a",attempts:[],events:[fact("a","listening","1250")]};
 const b={participantId:"b",attempts:[],events:[fact("b","listening","1250")]};
 const c={participantId:"c",attempts:[],events:[fact("c","listening","1")]};
 assert.equal(scoreRankingCohort([a])[0]?.score,"1250");
 assert.deepEqual(scoreRankingCohort([a,b,c]).map(item=>[item.score,item.rank]),[["1250",1],["1250",1],["1",3]]);
});
test("partial listening is eligible without a completed Quiz, zero learners are not",()=>{
 assert.deepEqual(scoreRankingCohort([{participantId:"empty",attempts:[],events:[]},{participantId:"partial",attempts:[],events:[fact("new","listening","1")]}]).map(item=>item.participantId),["partial"]);
});
test("malformed, negative, fractional, unknown or mismatched credit facts are rejected",()=>{
 for(const points of ["0","-1","1.5","NaN","01"])assert.throws(()=>scoreLearningEvents([fact("bad","listening",points)]));
 assert.throws(()=>scoreLearningEvents([fact("bad","completion","49")]),/rule unit/);
});
