import assert from "node:assert/strict";
import test from "node:test";
import {canonicalParts,validateStorageParts} from "../src/ingestion/upload-recovery.ts";
test("completion parts are canonical, consecutive and immutable candidates",()=>{
 assert.deepEqual(canonicalParts([{partNumber:2,etag:'"b"'},{partNumber:1,etag:'"a"'}]),[{partNumber:1,etag:'"a"'},{partNumber:2,etag:'"b"'}]);
 for(const parts of [[],[{partNumber:2,etag:'x'}],[{partNumber:1,etag:'a'},{partNumber:1,etag:'b'}],[{partNumber:1,etag:''}]])assert.throws(()=>canonicalParts(parts));
});
test("object-storage part sizes must exactly match declaration, including tail",()=>{
 const upload={part_size_bytes:8388608,part_count:2,expected_size_bytes:'8388617'},parts=[{partNumber:1,etag:'a',sizeBytes:8388608},{partNumber:2,etag:'b',sizeBytes:9}];
 validateStorageParts(upload,parts);assert.throws(()=>validateStorageParts(upload,[parts[0]!]));assert.throws(()=>validateStorageParts(upload,[parts[0]!,{...parts[1]!,sizeBytes:10}]));
});
