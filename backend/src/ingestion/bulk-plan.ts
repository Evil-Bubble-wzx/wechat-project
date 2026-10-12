import {ApiError} from "../api/errors.ts";
import type {IngestionItemInput} from "./service.ts";
export const bulkAssetTypes=["audio","subtitles","text","vocabulary","quiz","cover","metadata"] as const;
export type BulkItem=IngestionItemInput&{relativePath:string};
export type BulkPiece={pieceId:string;title:string;sortOrder:number;accessType:"free"|"restricted";contentVersion:number;items:BulkItem[]};
export type BulkWork={workId:string;title:string;description:string|null;accessType:"free"|"restricted";pieces:BulkPiece[]};
export type BulkPlan={schemaVersion:1;source:string;sourceCommitSha:string;toolVersion:string;works:BulkWork[]};
const invalid=()=>new ApiError("INVALID_REQUEST",400,false,"Invalid bulk import declaration");
function object(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value as Record<string,unknown>;}
function text(value:unknown,max=128):string{if(typeof value!=="string"||!value.trim()||value.length>max||/[\u0000-\u001f\u007f]/.test(value))throw invalid();return value.trim();}
function id(value:unknown):string{const result=text(value);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result))throw invalid();return result;}
function integer(value:unknown,min=0,max=2147483647):number{if(!Number.isSafeInteger(value)||Number(value)<min||Number(value)>max)throw invalid();return Number(value);}
function access(value:unknown):"free"|"restricted"{if(value!=="free"&&value!=="restricted")throw invalid();return value;}
export function safeRelativePath(value:unknown):string{
 if(typeof value!=="string"||!value.length||value.length>1024||/[\\:\u0000-\u001f\u007f]/.test(value)||value.startsWith("/"))throw invalid();
 if(value.split("/").some(part=>!part||part==="."||part===".."||part.length>255))throw invalid();return value;
}
const m=1024*1024,limits:Record<string,number>={audio:5*1024*m,subtitles:100*m,text:100*m,vocabulary:8*m,quiz:8*m,cover:50*m,metadata:8*m};
const mimes:Record<string,string[]>={audio:["audio/mpeg","audio/mp4","audio/x-m4a","audio/wav","audio/x-wav","audio/flac","application/octet-stream"],subtitles:["application/json","text/vtt","application/x-subrip","text/plain","application/octet-stream"],text:["text/plain","text/markdown","application/json","application/octet-stream"],vocabulary:["application/json"],quiz:["application/json"],cover:["image/jpeg","image/png","image/webp","image/svg+xml","application/octet-stream"],metadata:["application/json"]};
export function parseBulkPlan(value:unknown):BulkPlan{
 const input=object(value,["schemaVersion","source","sourceCommitSha","toolVersion","works"]);if(input.schemaVersion!==1||!Array.isArray(input.works)||input.works.length<1||input.works.length>100)throw invalid();
 const workIds=new Set<string>(),pieceIds=new Set<string>(),paths=new Map<string,string>();let count=0,total=0;
 const works=input.works.map(raw=>{
  const work=object(raw,["workId","title","description","accessType","pieces"]),workId=id(work.workId);if(workIds.has(workId)||!Array.isArray(work.pieces)||!work.pieces.length)throw invalid();workIds.add(workId);const orders=new Set<number>();
  const description=work.description===null?null:text(work.description,10000);
  const pieces=work.pieces.map(rawPiece=>{
   const piece=object(rawPiece,["pieceId","title","sortOrder","accessType","contentVersion","items"]),pieceId=id(piece.pieceId),sortOrder=integer(piece.sortOrder);if(pieceIds.has(pieceId)||orders.has(sortOrder)||++count>1000||!Array.isArray(piece.items)||piece.items.length!==7)throw invalid();pieceIds.add(pieceId);orders.add(sortOrder);
   const types=new Set<string>();const items=piece.items.map(rawItem=>{
    const item=object(rawItem,["clientFileId","assetType","fileName","sizeBytes","mimeType","sha256","relativePath"]),type=text(item.assetType,32);if(!bulkAssetTypes.includes(type as any)||types.has(type)||item.clientFileId!==type)throw invalid();types.add(type);
    const relativePath=safeRelativePath(item.relativePath),fileName=text(item.fileName,255),mimeType=text(item.mimeType,255).toLowerCase(),sizeBytes=integer(item.sizeBytes,1,limits[type]),sha256=text(item.sha256,64);
    if(relativePath.split("/").at(-1)!==fileName||!mimes[type]!.includes(mimeType)||!/^[a-f0-9]{64}$/.test(sha256)||(type==="subtitles"&&mimeType==="application/json"&&sizeBytes>8*m))throw invalid();
    const fingerprint=JSON.stringify([type,fileName,sizeBytes,mimeType,sha256]);if(paths.has(relativePath)&&paths.get(relativePath)!==fingerprint)throw invalid();paths.set(relativePath,fingerprint);total+=sizeBytes;if(total>100*1024*m)throw invalid();
    return{clientFileId:type,assetType:type as IngestionItemInput["assetType"],fileName,sizeBytes,mimeType,sha256,relativePath};
   }).sort((a,b)=>bulkAssetTypes.indexOf(a.assetType)-bulkAssetTypes.indexOf(b.assetType));
   return{pieceId,title:text(piece.title,1000),sortOrder,accessType:access(piece.accessType),contentVersion:integer(piece.contentVersion,1),items};
  });return{workId,title:text(work.title,1000),description,accessType:access(work.accessType),pieces};
 });return{schemaVersion:1,source:text(input.source),sourceCommitSha:text(input.sourceCommitSha,64),toolVersion:text(input.toolVersion),works};
}
