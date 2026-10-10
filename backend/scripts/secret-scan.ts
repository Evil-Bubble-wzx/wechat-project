import { readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath,pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = new URL("..", import.meta.url);
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
  const backendRoot=fileURLToPath(directory);
  const repo=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:backendRoot,encoding:'utf8'}).trim();
  // Scan tracked files even if now ignored, plus all nonignored untracked files.
  // Local secret env files intentionally excluded by Git are runtime inputs.
  const names=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z','--','backend'],{cwd:repo,encoding:'utf8'}).split('\0').filter(Boolean);
  return names.map(name=>resolve(repo,name)).filter(name=>name.startsWith(resolve(backendRoot)+sep))
    .filter(name=>textExtensions.has(extname(name))||name.split(sep).at(-1)!.startsWith('.env')).map(name=>pathToFileURL(name));
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
