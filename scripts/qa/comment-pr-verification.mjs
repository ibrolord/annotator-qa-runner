#!/usr/bin/env node
import { readFile } from 'node:fs/promises';

const token = process.env.GITHUB_TOKEN ?? '';
const repository = process.env.GITHUB_REPOSITORY ?? '';
const eventPath = process.env.GITHUB_EVENT_PATH ?? '';
const githubApiUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '');
const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const runId = process.env.GITHUB_RUN_ID ?? '';
const reportId = process.env.ANNOTATE_REPORT_ID ?? '';
const verificationRunId = process.env.ANNOTATE_VERIFICATION_RUN_ID ?? '';
const status = process.env.ANNOTATE_VERIFICATION_STATUS ?? 'failed';
const summary = process.env.ANNOTATE_VERIFICATION_SUMMARY ?? '';

function fail(message) {
  throw new Error(message);
}

async function github(pathname, options = {}) {
  const response = await fetch(`${githubApiUrl}${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`GitHub ${pathname} failed (${response.status}): ${body?.message ?? text}`);
  }
  return body;
}

function statusLabel(value) {
  return value.replace(/_/g, ' ');
}

async function main() {
  if (!token) fail('GITHUB_TOKEN is required to comment on a pull request.');
  if (!repository.includes('/')) fail('GITHUB_REPOSITORY is required.');
  if (!eventPath) fail('GITHUB_EVENT_PATH is required.');

  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullNumber = event.pull_request?.number;
  if (!pullNumber) {
    console.log('No pull_request payload found; skipping Annotate QA comment.');
    return;
  }

  const marker = `<!-- annotate-qa-verification:${reportId || 'unknown'} -->`;
  const runUrl = runId ? `${serverUrl}/${repository}/actions/runs/${runId}` : null;
  const body = [
    marker,
    '## Annotate QA Verification',
    '',
    `- Status: **${statusLabel(status)}**`,
    reportId ? `- Report ID: \`${reportId}\`` : null,
    verificationRunId ? `- Verification run ID: \`${verificationRunId}\`` : null,
    summary ? `- Result: ${summary}` : null,
    runUrl ? `- Workflow run: ${runUrl}` : null,
  ].filter(Boolean).join('\n');

  const comments = await github(`/repos/${repository}/issues/${pullNumber}/comments?per_page=100`);
  const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.includes(marker));
  if (existing) {
    await github(`/repos/${repository}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
    console.log(`Updated Annotate QA verification comment on PR #${pullNumber}.`);
    return;
  }

  await github(`/repos/${repository}/issues/${pullNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  console.log(`Created Annotate QA verification comment on PR #${pullNumber}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
