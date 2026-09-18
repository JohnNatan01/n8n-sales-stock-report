#!/usr/bin/env node
// Fails (exit 1) if anything that looks like a secret or instance-specific data
// is found in the repo. Runs as a pre-commit hook and can be run by hand:
//   node scripts/check-secrets.mjs
//
// Extra forbidden words (client names, domains...) can be listed one per line in
// `.secret-denylist`, which is git-ignored so the list itself never gets published.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const SCAN_EXT = new Set(['.json', '.md', '.csv', '.mjs', '.js', '.txt', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SELF = path.join('scripts', 'check-secrets.mjs');

const RULES = [
  ['HTTP Basic credentials', /Basic\s+[A-Za-z0-9+/]{20,}={0,2}/],
  ['Bearer token literal', /Bearer\s+(?!\{\{)[A-Za-z0-9._-]{20,}/],
  ['Session cookie', /PHPSESSID=|sessionid=/i],
  ['Google Sheets URL', /docs\.google\.com\/spreadsheets\/d\/(?!YOUR_)/],
  ['Google Drive file ID', /["'/]1[A-Za-z0-9_-]{40,44}["'/]/],
  // example.com / .org / .net, including subdomains, are the documentation domains.
  ['E-mail address', /[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*\bexample\.(com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['Private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['API key-like value', /(api[_-]?key|client[_-]?secret|access[_-]?token)"?\s*[:=]\s*"(?![={])[A-Za-z0-9._-]{16,}"/i],
];

const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const denylist = (() => {
  const file = path.join(ROOT, '.secret-denylist');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
})();

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCAN_EXT.has(path.extname(entry.name)) || entry.name === 'pre-commit') yield full;
  }
}

// n8n-specific checks that are easier on the parsed workflow than with regexes.
function checkWorkflow(wf) {
  const issues = [];
  if (wf.id) issues.push('top-level workflow "id" (instance-specific)');
  if (wf.versionId) issues.push('"versionId" (instance-specific)');
  if (wf.meta?.instanceId) issues.push('"meta.instanceId" (identifies your n8n instance)');
  if (wf.active) issues.push('workflow exported as active');
  if (wf.pinData && Object.keys(wf.pinData).length) issues.push('"pinData" may contain real execution data');
  for (const n of wf.nodes ?? []) {
    for (const [type, cred] of Object.entries(n.credentials ?? {})) {
      if (cred?.id) issues.push(`node "${n.name}": ${type} credential id`);
    }
  }
  return issues;
}

const findings = [];
for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  if (rel === SELF) continue;
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    for (const [label, re] of RULES) if (re.test(line)) findings.push(`${rel}:${i + 1}  ${label}`);
    const folded = fold(line);
    for (const word of denylist) if (folded.includes(fold(word))) findings.push(`${rel}:${i + 1}  denylisted term`);
  });

  if (rel.startsWith('workflows') && rel.endsWith('.json')) {
    try {
      for (const issue of checkWorkflow(JSON.parse(text))) findings.push(`${rel}  ${issue}`);
    } catch (e) {
      findings.push(`${rel}  invalid JSON: ${e.message}`);
    }
  }
}

if (findings.length) {
  console.error(`✗ ${findings.length} potential secret(s) / private data found:\n`);
  for (const f of findings) console.error('  ' + f);
  console.error('\nSanitize these before committing.');
  process.exit(1);
}
console.log(`✓ No secrets found (${denylist.length} denylisted terms checked).`);
