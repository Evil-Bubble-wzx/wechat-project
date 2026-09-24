import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Pool } from "pg";

import { ApiError } from "../api/errors.ts";
import { decodeKey, hmacSha256 } from "../security/crypto.ts";

type CursorPayload = { after: string };

export class ContentService {
  private readonly pool: Pool;
  private readonly s3: S3Client;
  private readonly cursorKey: Buffer;

  constructor(
    pool: Pool,
    s3: S3Client,
    cursorKeyBase64: string,
  ) {
    this.pool = pool;
    this.s3 = s3;
    this.cursorKey = decodeKey(cursorKeyBase64);
  }

  private encodeCursor(after: string): string {
    const payload = Buffer.from(JSON.stringify({ after } satisfies CursorPayload)).toString("base64url");
    return `${payload}.${hmacSha256(payload, this.cursorKey)}`;
  }

  private decodeCursor(cursor: string | undefined): string | null {
    if (!cursor) return null;
    const [payload, signature, extra] = cursor.split(".");
    if (!payload || !signature || extra || hmacSha256(payload, this.cursorKey) !== signature) {
      throw new ApiError("INVALID_REQUEST", 400, false, "Cursor is invalid");
    }
    try {
      const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as CursorPayload;
      if (typeof value.after !== "string" || value.after.length === 0) throw new Error();
      return value.after;
    } catch {
      throw new ApiError("INVALID_REQUEST", 400, false, "Cursor is invalid");
    }
  }

  async listWorks(cursor: string | undefined, limit: number) {
    const after = this.decodeCursor(cursor);
    const result = await this.pool.query<{
      id: string;
      title: string;
      access_type: "free" | "restricted";
      piece_count: string;
    }>(
      `SELECT w.id, w.title, w.access_type, count(p.id)::text AS piece_count
       FROM works w
       LEFT JOIN pieces p ON p.work_id = w.id AND p.status = 'published'
       WHERE w.status = 'published' AND ($1::text IS NULL OR w.id > $1)
       GROUP BY w.id
       ORDER BY w.id
       LIMIT $2`,
      [after, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((work) => ({
        workId: work.id,
        title: work.title,
        coverUrl: null,
        pieceCount: Number(work.piece_count),
        access: work.access_type,
      })),
      nextCursor: hasMore ? this.encodeCursor(rows.at(-1)!.id) : null,
    };
  }

  async getWork(workId: string) {
    const work = await this.pool.query<{
      id: string;
      title: string;
      access_type: "free" | "restricted";
    }>(
      "SELECT id, title, access_type FROM works WHERE id = $1 AND status = 'published'",
      [workId],
    );
    if (!work.rows[0]) throw new ApiError("RESOURCE_NOT_FOUND", 404, false, "Work not found");
    const pieces = await this.pool.query<{
      id: string;
      title: string;
      access_type: "free" | "restricted";
      content_version: number;
      quiz_version: number | null;
    }>(
      `SELECT p.id, p.title, p.access_type, cv.content_version,
              max(qp.quiz_version)::integer AS quiz_version
       FROM pieces p
       JOIN content_versions cv ON cv.id = p.current_content_version_id AND cv.status = 'published'
       LEFT JOIN quiz_packages qp
         ON qp.piece_id = p.id AND qp.content_version = cv.content_version AND qp.status = 'published'
       WHERE p.work_id = $1 AND p.status = 'published'
       GROUP BY p.id, cv.content_version
       ORDER BY p.sort_order, p.id`,
      [workId],
    );
    return {
      work: {
        workId: work.rows[0].id,
        title: work.rows[0].title,
        coverUrl: null,
        pieceCount: pieces.rows.length,
        access: work.rows[0].access_type,
      },
      pieces: pieces.rows.map((piece) => ({
        pieceId: piece.id,
        title: piece.title,
        currentContentVersion: piece.content_version,
        quizVersion: piece.quiz_version,
        access: piece.access_type,
      })),
    };
  }

  async getManifest(pieceId: string, requestedVersion?: number) {
    const version = await this.pool.query<{
      id: string;
      work_id: string;
      piece_id: string;
      access_type: "free" | "restricted";
      content_version: number;
      manifest_sha256: string;
      quiz_version: number | null;
    }>(
      `SELECT cv.id, p.work_id, p.id AS piece_id, p.access_type,
              cv.content_version, cv.manifest_sha256,
              max(qp.quiz_version)::integer AS quiz_version
       FROM pieces p
       JOIN content_versions cv
         ON cv.piece_id = p.id
        AND cv.status = 'published'
        AND (($2::integer IS NULL AND cv.id = p.current_content_version_id) OR cv.content_version = $2)
       LEFT JOIN quiz_packages qp
         ON qp.piece_id = p.id AND qp.content_version = cv.content_version AND qp.status = 'published'
       WHERE p.id = $1 AND p.status = 'published'
       GROUP BY cv.id, p.work_id, p.id
       LIMIT 1`,
      [pieceId, requestedVersion ?? null],
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
    if (selected.access_type === "restricted") {
      throw new ApiError(
        "CONTENT_ACCESS_DENIED",
        403,
        false,
        "Restricted content entitlement is not available in this phase",
      );
    }
    const assets = await this.pool.query<{
      id: string;
      asset_type: string;
      bucket: string;
      object_key: string;
      sha256: string;
      size_bytes: string;
      mime_type: string;
    }>(
      `SELECT id, asset_type, bucket, object_key, sha256, size_bytes, mime_type
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
      assets: signedAssets,
    };
  }
}
