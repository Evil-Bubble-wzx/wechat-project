export type StableErrorCode =
  | "INVALID_REQUEST"
  | "AUTH_CODE_INVALID"
  | "UNAUTHENTICATED"
  | "ACCESS_TOKEN_EXPIRED"
  | "REFRESH_TOKEN_REUSED"
  | "FORBIDDEN"
  | "RESOURCE_NOT_FOUND"
  | "ROUTE_NOT_FOUND"
  | "CONFLICT"
  | "IDEMPOTENCY_KEY_REUSED"
  | "CONTENT_VERSION_UNAVAILABLE"
  | "CONTENT_ACCESS_DENIED"
  | "QUIZ_PACKAGE_MISMATCH"
  | "QUIZ_ATTEMPT_REJECTED"
  | "RANKING_UNAVAILABLE"
  | "RANKING_PERIOD_INVALID"
  | "RANKING_FILTER_INVALID"
  | "UPLOAD_SESSION_EXPIRED"
  | "ASSET_CHECKSUM_MISMATCH"
  | "INGESTION_BATCH_CONFLICT"
  | "INGESTION_JOB_FAILED"
  | "SUBTITLE_VALIDATION_FAILED"
  | "PUBLISH_GATE_NOT_SATISFIED"
  | "RATE_LIMITED"
  | "DEPENDENCY_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  readonly code: StableErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(
    code: StableErrorCode,
    statusCode: number,
    retryable: boolean,
    message: string,
    details: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.details = details;
  }
}
