import assert from "node:assert/strict";
import test from "node:test";

import { ApiError } from "../src/api/errors.ts";
import { parseBatch } from "../src/api/ingestion-routes.ts";

function batch(items: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    source: "test",
    sourceCommitSha: "a".repeat(40),
    toolVersion: "test-1",
    workId: "work-1",
    pieceId: "piece-1",
    contentVersion: 1,
    items,
  };
}

function audio(index: number, sizeBytes: number, mimeType = "audio/mpeg"): Record<string, unknown> {
  return {
    clientFileId: `audio-${index}`,
    assetType: "audio",
    fileName: `audio-${index}.mp3`,
    sizeBytes,
    mimeType,
    sha256: "a".repeat(64),
  };
}

test("large audio declarations are allowed up to 5 GiB", () => {
  const parsed = parseBatch(batch([audio(1, 5 * 1024 * 1024 * 1024)]));
  assert.equal(parsed.items[0]?.sizeBytes, 5 * 1024 * 1024 * 1024);
});

test("ingestion rejects oversized assets, unsupported MIME and oversized batches", () => {
  for (const input of [
    batch([audio(1, 5 * 1024 * 1024 * 1024 + 1)]),
    batch([audio(1, 1024, "application/x-msdownload")]),
    batch(Array.from({ length: 21 }, (_, index) => audio(index, 5 * 1024 * 1024 * 1024))),
  ]) {
    assert.throws(
      () => parseBatch(input),
      (error: unknown) => error instanceof ApiError && error.code === "INVALID_REQUEST",
    );
  }
});
