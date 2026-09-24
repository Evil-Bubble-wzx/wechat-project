import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import SwaggerParser from "@apidevtools/swagger-parser";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;

type Parameter = {
  name?: string;
  in?: string;
};

type Response = {
  headers?: Record<string, unknown>;
};

type Operation = {
  operationId?: string;
  parameters?: Parameter[];
  responses?: Record<string, Response>;
};

type OpenApiDocument = {
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
};

type ContractSchema = {
  $id: string;
  $defs: Record<string, unknown>;
};

type ErrorCatalog = {
  contractVersion: string;
  errors: Array<{
    code: string;
    httpStatus: number;
    retryable: boolean;
    description: string;
  }>;
};

const contractsDirectory = fileURLToPath(new URL("../contracts/", import.meta.url));
const openApiPath = fileURLToPath(new URL("../contracts/openapi.json", import.meta.url));
const schemaPath = fileURLToPath(
  new URL("../contracts/schemas/api-v1.schema.json", import.meta.url),
);

async function readJson<T>(relativePath: string): Promise<T> {
  const content = await readFile(`${contractsDirectory}${relativePath}`, "utf8");
  return JSON.parse(content) as T;
}

function operationEntries(document: OpenApiDocument) {
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  return Object.entries(document.paths).flatMap(([path, pathItem]) =>
    Object.entries(pathItem)
      .filter(([method]) => methods.has(method))
      .map(([method, operation]) => ({ path, method, operation })),
  );
}

test("OpenAPI 3.1 document and external schemas are valid", async () => {
  const document = (await SwaggerParser.validate(openApiPath)) as unknown as OpenApiDocument;

  assert.equal(document.info.version, "1.0.0");
  assert.ok(Object.keys(document.paths).length >= 10);
});

test("all operations expose request IDs and all mutations require idempotency keys", async () => {
  const document = (await SwaggerParser.dereference(openApiPath)) as unknown as OpenApiDocument;
  const entries = operationEntries(document);
  const operationIds = entries.map(({ operation }) => operation.operationId);

  assert.equal(operationIds.every(Boolean), true, "every operation must have operationId");
  assert.equal(new Set(operationIds).size, operationIds.length, "operationId values must be unique");

  for (const { path, method, operation } of entries) {
    assert.ok(operation.responses, `${method.toUpperCase()} ${path} must define responses`);
    for (const [status, response] of Object.entries(operation.responses ?? {})) {
      assert.ok(
        response.headers?.["X-Request-Id"],
        `${method.toUpperCase()} ${path} response ${status} must expose X-Request-Id`,
      );
    }

    if (["post", "put", "patch", "delete"].includes(method)) {
      const hasIdempotencyKey = operation.parameters?.some(
        (parameter) => parameter.in === "header" && parameter.name === "Idempotency-Key",
      );
      assert.equal(
        hasIdempotencyKey,
        true,
        `${method.toUpperCase()} ${path} must require Idempotency-Key`,
      );
    }
  }
});

test("error catalog exactly matches the stable ErrorCode enum", async () => {
  const schema = await readJson<ContractSchema>("schemas/api-v1.schema.json");
  const catalog = await readJson<ErrorCatalog>("errors.v1.json");
  const version = (await readFile(`${contractsDirectory}VERSION`, "utf8")).trim();
  const errorCode = schema.$defs.ErrorCode as { enum: string[] };
  const schemaCodes = [...errorCode.enum].sort();
  const catalogCodes = catalog.errors.map(({ code }) => code).sort();

  assert.equal(version, "api-contract-v1.0.0");
  assert.equal(catalog.contractVersion, version);
  assert.deepEqual(catalogCodes, schemaCodes);
  assert.equal(new Set(catalogCodes).size, catalogCodes.length);
  for (const error of catalog.errors) {
    assert.match(error.code, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(error.httpStatus >= 400 && error.httpStatus <= 599);
    assert.ok(error.description.length > 0);
  }
});

test("contract examples validate against JSON Schema 2020-12", async () => {
  const schema = await readJson<ContractSchema>("schemas/api-v1.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);

  const examples: Array<[string, string]> = [
    ["examples/session-wechat.request.json", "SessionWechatRequest"],
    ["examples/session-wechat.response.json", "SessionResponse"],
    ["examples/quiz-attempt.request.json", "QuizAttemptRequest"],
    ["examples/quiz-attempt.response.json", "QuizAttemptResponse"],
    ["examples/ranking-options.response.json", "RankingOptionsResponse"],
    ["examples/ranking-ready.response.json", "RankingsResponse"],
    ["examples/ranking-quiz-detail.response.json", "RankingQuizDetailResponse"],
    ["examples/ranking-unavailable.response.json", "ErrorResponse"],
    ["examples/error.response.json", "ErrorResponse"],
    ["examples/ingestion-batch.request.json", "IngestionBatchCreateRequest"],
  ];

  for (const [path, definition] of examples) {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${definition}`);
    assert.ok(validate, `schema definition ${definition} must compile`);
    const example = await readJson<unknown>(path);
    assert.equal(validate(example), true, `${path}: ${ajv.errorsText(validate.errors)}`);
  }
});

test("ranking metric accepts the bounded algorithm score and rejects raw book counts", async () => {
  const schema = await readJson<ContractSchema>("schemas/api-v1.schema.json");
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(schema);
  const validate = ajv.getSchema(`${schema.$id}#/$defs/RankingMetric`);
  assert.ok(validate);
  assert.equal(validate({key:"rankingScore",label:"Quiz Score",value:782,unit:"points"}),true);
  assert.equal(validate({key:"completedQuizBooks",label:"Quiz Books",value:7,unit:"books"}),false);
  assert.equal(validate({key:"rankingScore",label:"Quiz Score",value:1001,unit:"points"}),false);
  assert.equal(validate({key:"rankingScore",label:"Quiz Score",value:782.5,unit:"points"}),false);
});
