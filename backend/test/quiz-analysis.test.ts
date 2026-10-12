import assert from "node:assert/strict";
import test from "node:test";
import {quizAnalysis,type AnalysisFact} from "../src/ranking/quiz-analysis.ts";
import {normalizeAnalysis} from "../src/ranking/analysis-query.ts";
const fact=(id:string,patch:Partial<AnalysisFact>={}):AnalysisFact=>({attemptId:id,pieceId:id,verifiedAt:"2026-10-10T01:00:00.000Z",passed:true,correctPercent:90,wordCount:100,level:3.2,category:"fiction",...patch});
test("analysis selects latest confirmed attempt per piece, not first attempt or one per book",()=>{
 const s=quizAnalysis([fact("a",{pieceId:"chapter-1"}),fact("b",{pieceId:"chapter-1",verifiedAt:"2026-10-10T02:00:00.000Z",passed:false,correctPercent:60}),fact("c",{pieceId:"chapter-2"})]);
 assert.equal(s.attempts,3);assert.equal(s.all.pieces,2);assert.equal(s.passed.pieces,1);assert.equal(s.all.words,"200");assert.equal(s.all.averageCorrect,75);
});
test("passed follows immutable server mastery even with a nondefault threshold",()=>{
 const s=quizAnalysis([fact("a",{correctPercent:90,passed:false}),fact("b",{correctPercent:70,passed:true})]);
 assert.equal(s.passed.pieces,1);assert.equal(s.passed.averageCorrect,70);
});
test("unknown words, levels and categories stay unknown and expose their sample counts",()=>{
 const s=quizAnalysis([fact("a",{wordCount:null,level:null,category:null}),fact("b",{wordCount:0,category:"nonfiction"})]);
 assert.equal(s.all.words,null);assert.equal(s.all.averageLevel,3.2);assert.equal(s.all.leveledPieces,1);assert.equal(s.all.fictionPercent,0);assert.equal(s.all.categorizedPieces,1);
 const empty=quizAnalysis([]);assert.equal(empty.all.words,"0");assert.equal(empty.all.averageCorrect,null);assert.equal(empty.all.fictionPercent,null);
});
test("early and recent require six distinct pieces and do not overlap",()=>{
 const rows=Array.from({length:6},(_,i)=>fact(String(i),{verifiedAt:"2026-10-10T0"+i+":00:00.000Z",correctPercent:50+i*10,level:i+1}));
 const s=quizAnalysis(rows);assert.equal(s.all.earlyCorrect,60);assert.equal(s.all.recentCorrect,90);assert.equal(s.all.earlyLevel,2);assert.equal(s.all.recentLevel,5);
 assert.equal(quizAnalysis(rows.slice(0,5)).all.earlyCorrect,null);
 rows[0]!.level=null;assert.equal(quizAnalysis(rows).all.earlyLevel,null);
});
test("timestamp ties are deterministic and search and sort inputs are validated",()=>{
 assert.equal(quizAnalysis([fact("z",{pieceId:"p",passed:false}),fact("a",{pieceId:"p"})]).passed.pieces,0);
 assert.deepEqual(normalizeAnalysis({query:" %_ 文本 ",sort:"words",direction:"asc"}),{query:"%_ 文本",sort:"words",direction:"asc"});
 for(const input of [{query:"x".repeat(129)},{sort:"user_id"},{direction:"DESC;DELETE"}])assert.throws(()=>normalizeAnalysis(input));
});
