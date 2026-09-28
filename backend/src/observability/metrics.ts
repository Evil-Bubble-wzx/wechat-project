import type { Pool } from "pg";

const LATENCY_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

type HttpObservation = {
  route: string;
  method: string;
  statusCode: number;
  errorCode: string;
  durationSeconds: number;
};

type Histogram = { count: number; sum: number; buckets: number[] };

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labels(values: Record<string, string>): string {
  return `{${Object.entries(values).map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`;
}

export class MetricsRegistry {
  private readonly requests = new Map<string, number>();
  private readonly histograms = new Map<string, Histogram>();
  private readonly domain = new Map<string, number>();

  incrementDomain(metric: "tingyue_quiz_submissions_total" | "tingyue_ranking_queries_total", outcome: string, errorCode = "NONE"): void {
    const key = `${metric}${labels({ outcome, error_code: errorCode })}`;
    this.domain.set(key, (this.domain.get(key) ?? 0) + 1);
  }

  observeHttp(observation: HttpObservation): void {
    const status = String(observation.statusCode);
    const requestLabels = labels({
      method: observation.method,
      route: observation.route,
      status,
      error_code: observation.errorCode,
    });
    this.requests.set(requestLabels, (this.requests.get(requestLabels) ?? 0) + 1);

    const histogramLabels = labels({ method: observation.method, route: observation.route });
    const histogram = this.histograms.get(histogramLabels) ?? {
      count: 0,
      sum: 0,
      buckets: LATENCY_BUCKETS.map(() => 0),
    };
    histogram.count += 1;
    histogram.sum += observation.durationSeconds;
    LATENCY_BUCKETS.forEach((upperBound, index) => {
      if (observation.durationSeconds <= upperBound) histogram.buckets[index]! += 1;
    });
    this.histograms.set(histogramLabels, histogram);

    const outcome = observation.statusCode < 400 ? "success" : "failure";
    let metric: string | null = null;
    if (observation.route === "/api/v1/session/wechat") metric = "tingyue_login_attempts_total";
    else if (observation.route.includes("/manifest")) metric = "tingyue_content_resource_requests_total";
    if (metric) {
      const key = `${metric}${labels({ outcome, error_code: observation.errorCode })}`;
      this.domain.set(key, (this.domain.get(key) ?? 0) + 1);
    }
  }

  render(): string {
    const lines = [
      "# HELP tingyue_http_requests_total Completed HTTP requests.",
      "# TYPE tingyue_http_requests_total counter",
    ];
    for (const [metricLabels, value] of this.requests) {
      lines.push(`tingyue_http_requests_total${metricLabels} ${value}`);
    }
    lines.push(
      "# HELP tingyue_http_request_duration_seconds HTTP request latency; use histogram_quantile for P95.",
      "# TYPE tingyue_http_request_duration_seconds histogram",
    );
    for (const [metricLabels, histogram] of this.histograms) {
      LATENCY_BUCKETS.forEach((upperBound, index) => {
        const withLe = metricLabels.slice(0, -1) + `,le="${upperBound}"}`;
        lines.push(`tingyue_http_request_duration_seconds_bucket${withLe} ${histogram.buckets[index]}`);
      });
      const infinity = metricLabels.slice(0, -1) + ',le="+Inf"}';
      lines.push(`tingyue_http_request_duration_seconds_bucket${infinity} ${histogram.count}`);
      lines.push(`tingyue_http_request_duration_seconds_sum${metricLabels} ${histogram.sum}`);
      lines.push(`tingyue_http_request_duration_seconds_count${metricLabels} ${histogram.count}`);
    }
    for (const [metric, value] of this.domain) lines.push(`${metric} ${value}`);
    lines.push(
      "# HELP process_uptime_seconds API process uptime.",
      "# TYPE process_uptime_seconds gauge",
      `process_uptime_seconds ${process.uptime()}`,
      "# HELP process_resident_memory_bytes API process resident memory.",
      "# TYPE process_resident_memory_bytes gauge",
      `process_resident_memory_bytes ${process.memoryUsage().rss}`,
    );
    return `${lines.join("\n")}\n`;
  }
}

export class OperationalMetricsCollector {
  private readonly pool: Pool;
  constructor(pool: Pool) { this.pool = pool; }

  async render(): Promise<string> {
    const result = await this.pool.query<{
      ingestion_queued: string;
      ingestion_retry: string;
      ingestion_dead: string;
      ingestion_oldest_seconds: string | null;
      review_backlog: string;
      uploads_total: string;
      uploads_completed: string;
      ranking_pending: string;
      ranking_failed: string;
      ranking_oldest_seconds: string | null;
      ranking_build_seconds: string | null;
      ranking_source_lag_seconds: string | null;
      ingestion_processing_seconds: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM processing_jobs WHERE status='queued') AS ingestion_queued,
         (SELECT count(*)::text FROM processing_jobs WHERE status='retry_wait') AS ingestion_retry,
         (SELECT count(*)::text FROM processing_jobs WHERE status='dead_letter') AS ingestion_dead,
         (SELECT extract(epoch FROM now()-min(created_at))::text FROM processing_jobs WHERE status IN ('queued','retry_wait')) AS ingestion_oldest_seconds,
         (SELECT count(*)::text FROM ingestion_batches WHERE status='ready_for_review') AS review_backlog,
         (SELECT count(*)::text FROM upload_sessions) AS uploads_total,
         (SELECT count(*)::text FROM upload_sessions WHERE status='completed') AS uploads_completed,
         (SELECT count(*)::text FROM ranking_rebuild_events WHERE status IN ('pending','processing')) AS ranking_pending,
         (SELECT count(*)::text FROM ranking_rebuild_events WHERE status='failed') AS ranking_failed,
         (SELECT extract(epoch FROM now()-min(created_at))::text FROM ranking_rebuild_events WHERE status IN ('pending','processing','failed')) AS ranking_oldest_seconds,
         (SELECT (avg((metadata->>'durationMs')::numeric)/1000)::text FROM audit_events WHERE action='ranking_snapshot_generated' AND metadata ? 'durationMs') AS ranking_build_seconds,
         (SELECT extract(epoch FROM max(generated_at-source_max_verified_at))::text FROM ranking_snapshots WHERE generated_at IS NOT NULL AND source_max_verified_at IS NOT NULL) AS ranking_source_lag_seconds,
         (SELECT avg(extract(epoch FROM finished_at-started_at))::text FROM processing_jobs WHERE status='succeeded' AND started_at IS NOT NULL AND finished_at IS NOT NULL) AS ingestion_processing_seconds`,
    );
    const row = result.rows[0]!;
    const values: Array<[string, string | null]> = [
      ["tingyue_ingestion_queue_depth", row.ingestion_queued],
      ["tingyue_ingestion_retry_wait", row.ingestion_retry],
      ["tingyue_ingestion_dead_letter", row.ingestion_dead],
      ["tingyue_ingestion_oldest_wait_seconds", row.ingestion_oldest_seconds],
      ["tingyue_ingestion_review_backlog", row.review_backlog],
      ["tingyue_upload_sessions_total", row.uploads_total],
      ["tingyue_upload_sessions_completed", row.uploads_completed],
      ["tingyue_ranking_rebuild_queue_depth", row.ranking_pending],
      ["tingyue_ranking_rebuild_failures", row.ranking_failed],
      ["tingyue_ranking_rebuild_oldest_wait_seconds", row.ranking_oldest_seconds],
      ["tingyue_ranking_snapshot_build_duration_seconds", row.ranking_build_seconds],
      ["tingyue_ranking_source_lag_seconds", row.ranking_source_lag_seconds],
      ["tingyue_ingestion_processing_duration_seconds", row.ingestion_processing_seconds],
    ];
    return `${values.map(([name, value]) => `${name} ${value ?? 0}`).join("\n")}\n`;
  }
}
