import { readFile, readdir } from "node:fs/promises";
import { extname, relative } from "node:path";

const root = new URL("..", import.meta.url);
const ignoredDirectories = new Set([".git", "node_modules", "artifacts", "coverage", "dist"]);
const textExtensions = new Set([".ts", ".js", ".json", ".md", ".sql", ".yaml", ".yml", ".env", ".example", ".ps1"]);
const allowedLocalValues = new Set([
  "tingyue-local",
  "change-me-local-only",
  "tingyue-app-local",
  "tingyue-app-secret-local",
  "local-test-secret",
]);
const patterns: Array<{ name: string; expression: RegExp }> = [
  { name: "private key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", expression: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", expression: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Slack token", expression: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
];
const assignment = /^(WECHAT_APP_SECRET|TOKEN_SIGNING_KEY_BASE64|IDENTITY_HASH_KEY_BASE64|DATA_ENCRYPTION_KEY_BASE64|METRICS_BEARER_TOKEN|OBJECT_STORAGE_SECRET_KEY|MINIO_ROOT_PASSWORD)[ \t]*=[ \t]*["']?([^\s"'#]+)?/gm;

async function files(directory: URL): Promise<URL[]> {
  const found: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) found.push(...await files(child));
    else if (textExtensions.has(extname(entry.name)) || entry.name.startsWith(".env")) found.push(child);
  }
  return found;
}

const findings: string[] = [];
for (const file of await files(root)) {
  const content = await readFile(file, "utf8");
  const display = relative(new URL(root).pathname, file.pathname).replaceAll("\\", "/");
  for (const pattern of patterns) {
    if (pattern.expression.test(content)) findings.push(`${display}: ${pattern.name}`);
  }
  for (const match of content.matchAll(assignment)) {
    const value = match[2] ?? "";
    if (value && value !== "<redacted>" && !value.startsWith("${") && !allowedLocalValues.has(value)) {
      findings.push(`${display}: non-placeholder ${match[1]}`);
    }
  }
}

if (findings.length) {
  process.stderr.write(`secret.scan.failed\n${findings.join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("secret.scan.passed\n");
}
