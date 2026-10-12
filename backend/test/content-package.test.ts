import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateCatalogMetadata,validateQuizPackage,validateVocabularyPackage,validateSubtitleReferences } from "../src/content/package-validation.ts";
const identity={workId:"peter-rabbit",pieceId:"peter-rabbit-01",contentVersion:1};
test("content metadata keeps unknown fields null and binds declared identity",async()=>{
  const value=JSON.parse(await readFile(new URL("../../content/peter-rabbit/peter-rabbit-01/dist/metadata.json",import.meta.url),"utf8"));
  const result=validateCatalogMetadata(value,identity);
  assert.equal(result.wordCount,952);assert.equal(result.pageCount,null);assert.equal(result.level,null);assert.equal(result.author,"Beatrix Potter");
  assert.throws(()=>validateCatalogMetadata({...value,pieceId:"wrong"},identity),/identity/);
  assert.throws(()=>validateCatalogMetadata({...value,wordCount:{value:-1}},identity),/number/);
  assert.throws(()=>validateCatalogMetadata({...value,level:{}},identity),/level/);
});
test("content Quiz is versioned and validates exact ordered question identities",async()=>{
  const value=JSON.parse(await readFile(new URL("../../content/peter-rabbit/peter-rabbit-01/dist/quiz.json",import.meta.url),"utf8"));
  const result=validateQuizPackage(value,identity);assert.equal(result.questions.length,10);assert.equal(result.questions[0]!.id,"PRQ-001");
  assert.throws(()=>validateQuizPackage({...value,questions:[value.questions[0],value.questions[0]]},identity),/duplicate/);
  assert.throws(()=>validateQuizPackage({...value,contentVersion:2},identity),/identity/);
  assert.throws(()=>validateQuizPackage({...value,questions:Array(101).fill(value.questions[0])},identity),/package/);
});

test("subtitle and vocabulary projections keep contextual references and reject malformed entries",async()=>{
  const cues=JSON.parse(await readFile(new URL("../../content/peter-rabbit/peter-rabbit-01/dist/cues.json",import.meta.url),"utf8"));
  const vocabulary=JSON.parse(await readFile(new URL("../../content/peter-rabbit/peter-rabbit-01/dist/vocab.json",import.meta.url),"utf8"));
  const keys=validateVocabularyPackage(vocabulary).vocabularyKeys;
  assert.ok(validateSubtitleReferences(cues).vocabularyReferences.every(key=>keys.includes(key)));
  assert.throws(()=>validateVocabularyPackage({cloud:{entryId:"unstable",lemma:"cloud"}}),/stable/);
  assert.throws(()=>validateSubtitleReferences([{id:"c1",text:"cloud",tokens:{}}]),/tokens/);
});
