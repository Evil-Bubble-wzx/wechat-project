import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Pool, PoolClient } from "pg";
import { ApiError } from "../api/errors.ts";
import { assertContentAccess,hasPurchasedVersion } from '../commerce/access.ts';
import { decodeKey, hmacSha256 } from "../security/crypto.ts";
import type { CatalogMetadata } from "./package-validation.ts";

export type CatalogFilters = { query?: string; category?: "all" | "fiction" | "nonfiction" | "available" };
type Filters = { query: string; category: string };
type WorkRow = { id: string; title: string; description: string | null; author: string | null; series: string | null; ranking_category: "fiction" | "nonfiction" | null; access_type: "free" | "restricted"; piece_count: string; word_count: string | null; duration_ms: string | null; catalog_metadata: Partial<CatalogMetadata>; cover_bucket: string | null; cover_key: string | null };
const normalize = (value: CatalogFilters): Filters => ({ query: (value.query ?? "").trim().toLowerCase(), category: value.category ?? "all" });
const workSql = `SELECT w.*, totals.piece_count::text, totals.word_count::text, totals.duration_ms::text,
  coalesce(first_piece.catalog_metadata,'{}'::jsonb) AS catalog_metadata,
  cover.bucket AS cover_bucket,cover.object_key AS cover_key
FROM works w
JOIN LATERAL (
  SELECT count(*) AS piece_count,
    CASE WHEN count(coalesce((cv.catalog_metadata->>'wordCount')::integer,p.word_count))=count(*) THEN sum(coalesce((cv.catalog_metadata->>'wordCount')::integer,p.word_count)) END AS word_count,
    CASE WHEN count(audio.duration_ms)=count(*) THEN sum(audio.duration_ms) END AS duration_ms
  FROM pieces p JOIN content_versions cv ON cv.id=p.current_content_version_id AND cv.status='published'
  LEFT JOIN content_assets audio ON audio.piece_id=p.id AND audio.content_version=cv.content_version AND audio.asset_type='audio' AND audio.status='published'
  WHERE p.work_id=w.id AND p.status='published'
) totals ON totals.piece_count>0
LEFT JOIN LATERAL (
  SELECT cv.catalog_metadata FROM pieces p JOIN content_versions cv ON cv.id=p.current_content_version_id AND cv.status='published'
  WHERE p.work_id=w.id AND p.status='published' ORDER BY p.sort_order,p.id LIMIT 1
) first_piece ON true
LEFT JOIN LATERAL (
  SELECT a.bucket,a.object_key FROM pieces p JOIN content_versions cv ON cv.id=p.current_content_version_id AND cv.status='published'
  JOIN content_assets a ON a.piece_id=p.id AND a.content_version=cv.content_version AND a.asset_type='cover' AND a.status='published'
  WHERE p.work_id=w.id AND p.status='published' ORDER BY p.sort_order,p.id LIMIT 1
) cover ON true
WHERE w.status='published'`;

export class ContentService {
  private readonly pool: Pool;
  private readonly simulation: boolean;
  private readonly s3: S3Client;
  private readonly cursorKey: Buffer;

  constructor(
    pool: Pool,
    s3: S3Client,
    cursorKeyBase64: string,
    simulation = false,
  ) {
    this.pool = pool;
    this.simulation=simulation;
    this.s3 = s3;
    this.cursorKey = decodeKey(cursorKeyBase64);
  }
  private encodeCursor(after: string, filters: Filters): string {
    const payload = Buffer.from(JSON.stringify({ after, filters })).toString("base64url");
    return payload+"."+hmacSha256(payload,this.cursorKey);
  }
  private decodeCursor(cursor: string | undefined, filters: Filters): string | null {
    if (!cursor) return null;
    const [payload,signature,extra]=cursor.split(".");
    if (!payload||!signature||extra||hmacSha256(payload,this.cursorKey)!==signature) throw new ApiError("INVALID_REQUEST",400,false,"Cursor is invalid");
    try {
      const value=JSON.parse(Buffer.from(payload,"base64url").toString("utf8")) as {after:string;filters?:Filters};
      if(typeof value.after!=="string"||!value.after||value.after.length>128||JSON.stringify(value.filters??normalize({}))!==JSON.stringify(filters))throw new Error();
      return value.after;
    } catch {throw new ApiError("INVALID_REQUEST",400,false,"Cursor does not match this catalog query")}
  }
  private async summary(row: WorkRow) {
    const meta=row.catalog_metadata??{};
    return {
      workId:row.id,title:row.title,pieceCount:Number(row.piece_count),access:row.access_type,
      coverUrl:row.cover_bucket&&row.cover_key?await getSignedUrl(this.s3,new GetObjectCommand({Bucket:row.cover_bucket,Key:row.cover_key}),{expiresIn:300}):null,
      metadata:{
        titleZh:meta.titleZh??null,author:meta.author??row.author??null,series:meta.series??row.series??null,
        editionLabel:meta.editionLabel??null,internalContentNumber:meta.internalContentNumber??null,
        description:row.description??meta.description??null,category:meta.category??row.ranking_category??null,
        level:meta.level??null,pageCount:meta.pageCount??null,wordCount:row.word_count===null?null:Number(row.word_count),
        durationMs:row.duration_ms===null?null:Number(row.duration_ms),narrator:meta.narrator??null,
        audioSource:meta.audioSource??null,audioSourceUrl:meta.audioSourceUrl??null,
      } satisfies CatalogMetadata,
    };
  }
  async listWorks(cursor: string | undefined, limit: number, input: CatalogFilters={}) {
    const filters=normalize(input),after=this.decodeCursor(cursor,filters);
    if(filters.query.length>120||!["all","fiction","nonfiction","available"].includes(filters.category)||!Number.isInteger(limit)||limit<1||limit>100)throw new ApiError("INVALID_REQUEST",400,false,"Catalog query is invalid");
    const result=await this.pool.query<WorkRow>(workSql+`
      AND ($1::text IS NULL OR w.id>$1)
      AND ($2='' OR position($2 IN lower(concat_ws(' ',w.title,w.author,w.series,w.id,first_piece.catalog_metadata->>'titleZh',first_piece.catalog_metadata->>'author',first_piece.catalog_metadata->>'series',first_piece.catalog_metadata->>'editionLabel',first_piece.catalog_metadata->>'internalContentNumber')))>0)
      AND ($3='all' OR ($3='available' AND w.access_type='free' AND EXISTS (
        SELECT 1 FROM pieces available_piece JOIN content_versions available_version ON available_version.id=available_piece.current_content_version_id AND available_version.status='published'
        WHERE available_piece.work_id=w.id AND available_piece.status='published' AND available_piece.access_type='free'
      )) OR $3=coalesce(first_piece.catalog_metadata->>'category',w.ranking_category))
      ORDER BY w.id LIMIT $4`,[after,filters.query,filters.category,limit+1]);
    const rows=result.rows.slice(0,limit);
    return {items:await Promise.all(rows.map(row=>this.summary(row))),nextCursor:result.rows.length>limit?this.encodeCursor(rows.at(-1)!.id,filters):null};
  }
  private async snapshot<T>(read:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");const result=await read(client);await client.query("COMMIT");return result}
    catch(error){await client.query("ROLLBACK");throw error}finally{client.release()}
  }
  async getWork(workId:string){
    return this.snapshot(async client=>{
      const row=(await client.query<WorkRow>(workSql+" AND w.id=$1",[workId])).rows[0];
      if(!row)throw new ApiError("RESOURCE_NOT_FOUND",404,false,"Work not found");
      const pieces=await client.query<{id:string;title:string;access_type:"free"|"restricted";content_version:number;quiz_version:number|null;duration_ms:string|null;catalog_metadata:CatalogMetadata}>(`
        SELECT p.id,p.title,p.access_type,cv.content_version,cv.catalog_metadata,a.duration_ms::text,
          (SELECT max(qp.quiz_version)::integer FROM quiz_packages qp WHERE qp.piece_id=p.id AND qp.content_version=cv.content_version AND qp.status='published') AS quiz_version
        FROM pieces p JOIN content_versions cv ON cv.id=p.current_content_version_id AND cv.status='published'
        LEFT JOIN content_assets a ON a.piece_id=p.id AND a.content_version=cv.content_version AND a.asset_type='audio' AND a.status='published'
        WHERE p.work_id=$1 AND p.status='published' ORDER BY p.sort_order,p.id`,[workId]);
      return {work:await this.summary(row),pieces:pieces.rows.map(piece=>({
        pieceId:piece.id,title:piece.title,currentContentVersion:piece.content_version,quizVersion:piece.quiz_version,
        access:row.access_type==='restricted'?'restricted':piece.access_type,durationMs:piece.duration_ms===null?null:Number(piece.duration_ms),
        metadata:piece.catalog_metadata,
      }))};
    });
  }

  async getManifest(pieceId: string, requestedVersion?: number, userId?: string) {
    return this.snapshot(async client=>{
    const version = await client.query<{
      id: string;
      work_id: string;
      piece_id: string;
      access_type: "free" | "restricted";
      content_version: number;
      manifest_sha256: string;
      quiz_version: number | null;
      catalog_metadata: CatalogMetadata;
    }>(
      `SELECT cv.id, p.work_id, p.id AS piece_id, p.access_type,
              cv.content_version, cv.manifest_sha256, cv.catalog_metadata,
              max(qp.quiz_version)::integer AS quiz_version
       FROM pieces p
       JOIN content_versions cv
         ON cv.piece_id = p.id
        AND (cv.status = 'published' OR ($2::integer IS NOT NULL AND $3::boolean AND cv.status='superseded'))
        AND (($2::integer IS NULL AND cv.id = p.current_content_version_id) OR cv.content_version = $2)
       LEFT JOIN quiz_packages qp
         ON qp.piece_id = p.id AND qp.content_version = cv.content_version AND qp.status = 'published'
       WHERE p.id = $1 AND p.status = 'published'
       GROUP BY cv.id, p.work_id, p.id
       LIMIT 1`,
      [pieceId, requestedVersion ?? null, await hasPurchasedVersion(client,userId,pieceId,requestedVersion ?? 0,this.simulation)],
    );
    const selected = version.rows[0];
    if (!selected) {
      throw new ApiError(
        requestedVersion ? "CONTENT_VERSION_UNAVAILABLE" : "RESOURCE_NOT_FOUND",
        requestedVersion ? 409 : 404,
        false,
        "Published content version is unavailable",
      );
    }
    await assertContentAccess(client,userId,pieceId,selected.content_version,this.simulation);
    const assets = await client.query<{
      id: string;
      asset_type: string;
      bucket: string;
      object_key: string;
      sha256: string;
      size_bytes: string;
      mime_type: string;
      duration_ms: string | null;
    }>(
      `SELECT id, asset_type, bucket, object_key, sha256, size_bytes, mime_type, duration_ms::text
       FROM content_assets
       WHERE piece_id = $1 AND content_version = $2 AND status = 'published'
       ORDER BY asset_type`,
      [pieceId, selected.content_version],
    );
    if (assets.rows.length === 0) {
      throw new ApiError("CONTENT_VERSION_UNAVAILABLE", 409, false, "Published assets are unavailable");
    }
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
    const signedAssets = await Promise.all(
      assets.rows.map(async (asset) => ({
        assetId: asset.id,
        type: asset.asset_type,
        url: await getSignedUrl(
          this.s3,
          new GetObjectCommand({ Bucket: asset.bucket, Key: asset.object_key }),
          { expiresIn: 5 * 60 },
        ),
        expiresAt: expiresAt.toISOString(),
        sha256: asset.sha256.trim(),
        sizeBytes: Number(asset.size_bytes),
        mimeType: asset.mime_type,
      })),
    );
    return {
      workId: selected.work_id,
      pieceId: selected.piece_id,
      contentVersion: selected.content_version,
      quizVersion: selected.quiz_version,
      manifestSha256: selected.manifest_sha256.trim(),
      metadata: selected.catalog_metadata,
      durationMs: assets.rows.find(a=>a.asset_type==='audio')?.duration_ms==null?null:Number(assets.rows.find(a=>a.asset_type==='audio')!.duration_ms),
      assets: signedAssets,
    };
    });
  }
}
