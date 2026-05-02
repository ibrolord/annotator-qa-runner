#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';

const REPORT_ID_RE = /(?:annotate|annotator)?\s*(?:report[\s_-]*id|report)\s*[:#`\s-]+([a-f0-9]{32})/i;
const REPORT_URL_RE = /\/reports\/([a-f0-9]{32})(?:\b|[/?#])/i;

function findReportId(text) {
  if (!text) return null;
  return text.match(REPORT_ID_RE)?.[1] ?? text.match(REPORT_URL_RE)?.[1] ?? null;
}

async function writeOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await appendFile(outputPath, `${name}=${value}\n`, 'utf8');
}

async function writeResolved(reportId) {
  await writeOutput('report_id', reportId);
  await writeOutput('report_found', 'true');
}

async function writeSkipped() {
  await writeOutput('report_id', '');
  await writeOutput('report_found', 'false');
}

async function main() {
  const explicit = findReportId(process.env.ANNOTATE_REPORT_ID ?? '');
  if (explicit) {
    await writeResolved(explicit);
    console.log(`Resolved Annotate report ID from action input: ${explicit}`);
    return;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    const candidates = [
      event.pull_request?.body,
      event.pull_request?.title,
      event.issue?.body,
      event.issue?.title,
    ];
    for (const candidate of candidates) {
      const reportId = findReportId(typeof candidate === 'string' ? candidate : '');
      if (reportId) {
        await writeResolved(reportId);
        console.log(`Resolved Annotate report ID from GitHub event: ${reportId}`);
        return;
      }
    }
  }

  if (process.env.GITHUB_EVENT_NAME === 'pull_request') {
    await writeSkipped();
    console.log('No Annotate report ID found in PR; skipping Annotate QA verification.');
    return;
  }

  throw new Error('No Annotate report ID found. Pass report-id, or include "Annotate Report ID: <32 hex id>" in the PR body.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
