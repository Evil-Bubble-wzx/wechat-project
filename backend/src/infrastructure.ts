import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import pg, { type Pool as PgPool } from "pg";

import type { ReadinessCheck } from "./api/app.ts";
import type { RuntimeConfig } from "./config.ts";

const { Pool } = pg;

export type Infrastructure = {
  postgres: PgPool;
  redis: Redis;
  objectStorage: S3Client;
  readinessChecks: ReadinessCheck[];
  close: () => Promise<void>;
};

export function createInfrastructure(config: RuntimeConfig): Infrastructure {
  const postgres = new Pool({
    connectionString: config.databaseUrl,
    max: 5,
    connectionTimeoutMillis: 2_000,
  });
  const objectStorage = new S3Client({
    endpoint: `${config.objectStorage.useSsl ? "https" : "http"}://${config.objectStorage.endpoint}:${config.objectStorage.port}`,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.objectStorage.accessKey,
      secretAccessKey: config.objectStorage.secretKey,
    },
  });
  const redis = new Redis(config.redisUrl, {
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
  });
  redis.on("error", () => undefined);

  const readinessChecks: ReadinessCheck[] = [
    {
      name: "postgres",
      check: async () => {
        await postgres.query("SELECT 1");
      },
    },
    {
      name: "redis",
      check: async () => {
        await redis.ping();
      },
    },
    {
      name: "object-storage",
      check: async () => {
        await objectStorage.send(
          new HeadBucketCommand({ Bucket: config.objectStorage.incomingBucket }),
        );
        await objectStorage.send(
          new HeadBucketCommand({ Bucket: config.objectStorage.publishedBucket }),
        );
      },
    },
  ];

  return {
    postgres,
    redis,
    objectStorage,
    readinessChecks,
    close: async () => {
      await Promise.allSettled([
        postgres.end(),
        redis.quit(),
      ]);
      objectStorage.destroy();
    },
  };
}
