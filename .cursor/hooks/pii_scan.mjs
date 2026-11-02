#!/usr/bin/env node
/** Scan agent file edits for likely PII and secrets. Logs findings to stderr (Hooks output). */

import fs from "node:fs";
import path from "node:path";
const MAX_FILE_BYTES = 512 * 1024;

const SKIP_SUFFIXES = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".wasm",
  ".zip",
  ".pdf",
  ".mp4",
  ".mp3",
]);

const RULES = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "email address"],
  [/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, "phone number"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "SSN-like (###-##-####)"],
  [
    /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    "credit-card-like number",
  ],
  [/\bsk-(?:live|test|proj)-[A-Za-z0-9]{10,}\b/g, "OpenAI-style API key"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "AWS access key id"],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, "GitHub personal access token"],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, "GitHub OAuth token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "Slack token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g, "JWT"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "private key block"],
];

function scanText(text, source) {
  if (!text) return [];

  const hits = [];
  for (const [pattern, label] of RULES) {
    pattern.lastIndex = 0;
    if (!pattern.test(text)) continue;
    if (
      label === "email address" &&
      /@example\.|noreply@|@users\.noreply|@domain\.com/i.test(text)
    ) {
      continue;
    }
    hits.push(`${source}: possible ${label}`);
  }
  return hits;
}

function readFileSnippet(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (SKIP_SUFFIXES.has(ext)) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw || "{}");
} catch {
  console.error("[pii_scan] invalid hook JSON on stdin");
  process.stdout.write("{}");
  process.exit(0);
}

const filePath = payload.file_path ?? "";
const edits = Array.isArray(payload.edits) ? payload.edits : [];
const findings = [];

for (let index = 0; index < edits.length; index += 1) {
  const edit = edits[index];
  if (!edit || typeof edit !== "object") continue;
  findings.push(...scanText(edit.new_string ?? "", `edit[${index}]`));
}

if (filePath) {
  const body = readFileSnippet(filePath);
  if (body) findings.push(...scanText(body, "file"));
}

const unique = [...new Set(findings)];
if (unique.length) {
  console.error(`[pii_scan] ${filePath}`);
  for (const item of unique.slice(0, 12)) console.error(`  - ${item}`);
  if (unique.length > 12) console.error(`  - … and ${unique.length - 12} more`);
}

process.stdout.write("{}");
