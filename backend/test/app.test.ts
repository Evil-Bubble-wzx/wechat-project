import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/api/app.ts";

test("GET /health/live reports the API process as alive", async () => {
  const app = createApp();
  const response = await app.inject({ method: "GET", url: "/health/live" });
  const payload = response.json();

  assert.equal(response.statusCode, 200);
  assert.equal(payload.status, "ok");
  assert.equal(payload.service, "tingyue-api");
  assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(String(response.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  await app.close();
});

test("GET /health/ready reports successful dependency checks", async () => {
  const app = createApp({
    readinessChecks: [
      { name: "postgres", check: async () => undefined },
      { name: "redis", check: async () => undefined },
    ],
  });
  const response = await app.inject({ method: "GET", url: "/health/ready" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    status: "ready",
    dependencies: [
      { name: "postgres", status: "ok" },
      { name: "redis", status: "ok" },
    ],
  });
  await app.close();
});

test("GET /health/ready returns 503 without leaking dependency errors", async () => {
  const app = createApp({
    readinessChecks: [
      {
        name: "postgres",
        check: async () => {
          throw new Error("postgresql://user:secret@example.invalid/database");
        },
      },
    ],
  });
  const response = await app.inject({ method: "GET", url: "/health/ready" });
  const body = response.body;

  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "DEPENDENCY_UNAVAILABLE");
  assert.equal(body.includes("secret"), false);
  await app.close();
});

test("unknown routes return a stable error code", async () => {
  const app = createApp();
  const response = await app.inject({ method: "GET", url: "/missing" });

  assert.equal(response.statusCode, 404);
  assert.match(response.json().requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(response.json().error, {
    code: "ROUTE_NOT_FOUND",
    message: "The requested route does not exist.",
    retryable: false,
    details: null,
  });
  await app.close();
});
