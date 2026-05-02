#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

const apiBase = (process.env.ANNOTATE_API_URL ?? '').replace(/\/+$/, '');
const token = process.env.ANNOTATE_RUNNER_TOKEN ?? process.env.ANNOTATE_API_TOKEN ?? process.env.ANNOTATE_AUTH_TOKEN ?? '';
const reportId = process.env.ANNOTATE_REPORT_ID ?? process.argv[2] ?? '';
const verificationRunId = process.env.ANNOTATE_VERIFICATION_RUN_ID ?? '';
const targetUrl = process.env.ANNOTATE_TARGET_URL ?? process.argv[3] ?? '';
const gitRef = process.env.ANNOTATE_GIT_REF ?? process.env.GITHUB_SHA ?? '';
const repoDir = path.resolve(process.env.ANNOTATE_REPO_DIR ?? process.cwd());
const runner = process.env.ANNOTATE_RUNNER ?? 'customer_runner';
const command = process.env.ANNOTATE_PLAYWRIGHT_COMMAND ?? 'pnpm exec playwright test';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!apiBase) fail('ANNOTATE_API_URL is required, for example https://annotate-api.example.com/api');
if (!token) fail('ANNOTATE_RUNNER_TOKEN is required. Create one in Project Settings, or use ANNOTATE_API_TOKEN for local dashboard-JWT testing.');
if (!/^[a-f0-9]{32}$/i.test(reportId)) fail('ANNOTATE_REPORT_ID or argv[2] must be a 32-character report id.');
if (verificationRunId && !/^[a-f0-9]{32}$/i.test(verificationRunId)) fail('ANNOTATE_VERIFICATION_RUN_ID must be a 32-character verification run id.');

function apiUrl(pathname) {
  return `${apiBase}${pathname}`;
}

function truncate(value, max = 20000) {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}\n[truncated ${value.length - max} chars]` : value;
}

async function requestJson(pathname, options = {}) {
  const response = await fetch(apiUrl(pathname), {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    const message = body?.message ?? body?.error ?? text ?? `HTTP ${response.status}`;
    throw new Error(`${pathname} failed: ${message}`);
  }
  return body;
}

function rewriteTargetUrl(content, nextTargetUrl) {
  if (!nextTargetUrl) return { content, effectiveTargetUrl: null };
  const capturedUrlMatch = /const\s+capturedReportUrl\s*=\s*("([^"]+)"|'([^']+)');/.exec(content);
  if (capturedUrlMatch) {
    const originalUrl = capturedUrlMatch[2] ?? capturedUrlMatch[3] ?? '';
    const effective = effectiveReplayTargetUrl(originalUrl, nextTargetUrl);
    return {
      content: content.replace(capturedUrlMatch[0], `const capturedReportUrl = ${JSON.stringify(effective)};`),
      effectiveTargetUrl: effective,
    };
  }

  const match = /page\.goto\(("([^"]+)"|'([^']+)')\)/.exec(content);
  if (!match) return { content, effectiveTargetUrl: nextTargetUrl };

  const originalUrl = match[2] ?? match[3] ?? '';
  const effective = effectiveReplayTargetUrl(originalUrl, nextTargetUrl);

  return {
    content: content.replace(match[0], `page.goto(${JSON.stringify(effective)})`),
    effectiveTargetUrl: effective,
  };
}

function effectiveReplayTargetUrl(originalUrl, nextTargetUrl) {
  try {
    const original = new URL(originalUrl);
    const target = new URL(nextTargetUrl);
    if (target.pathname === '/' && !target.search && !target.hash) {
      return `${target.origin}${original.pathname}${original.search}${original.hash}`;
    }
  } catch {
    return nextTargetUrl;
  }
  return nextTargetUrl;
}

function runPlaywright(testFile, reproBaseUrl = '') {
  const parts = command.split(/\s+/).filter(Boolean);
  const executable = parts.shift();
  if (!executable) throw new Error('ANNOTATE_PLAYWRIGHT_COMMAND cannot be empty.');

  return new Promise((resolve) => {
    const child = spawn(executable, [...parts, testFile, '--reporter=json'], {
      cwd: repoDir,
      env: {
        ...process.env,
        ...(reproBaseUrl ? { ANNOTATE_REPRO_BASE_URL: reproBaseUrl } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function statusFromResult(result) {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (result.code === 0) return 'fixed';
  if (combined.includes('no tests found')) return 'unable_to_reproduce';
  if (combined.includes('syntaxerror') || combined.includes('cannot find module') || combined.includes('failed to load')) {
    return 'changed_failure';
  }
  return 'still_failing';
}

function outputValue(name, value) {
  const text = String(value ?? '');
  if (!text.includes('\n')) return `${name}=${text}\n`;
  const delimiter = `annotate_${name}_${Date.now()}`;
  return `${name}<<${delimiter}\n${text}\n${delimiter}\n`;
}

async function writeGithubOutputs(outputs) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  await appendFile(
    outputPath,
    Object.entries(outputs).map(([name, value]) => outputValue(name, value)).join(''),
    'utf8'
  );
}

async function main() {
  let run = verificationRunId
    ? await requestJson(`/reports/${reportId}/verification-runs/${verificationRunId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'running',
          target_url: targetUrl || null,
          git_ref: gitRef || null,
          runner,
          result_summary: 'Verification runner started.',
          evidence: {
            command,
            repo_dir: repoDir,
          },
        }),
      })
    : await requestJson(`/reports/${reportId}/verification-runs/start`, {
        method: 'POST',
        body: JSON.stringify({
          target_url: targetUrl || null,
          git_ref: gitRef || null,
          runner,
          result_summary: 'Verification runner started.',
          evidence: {
            command,
            repo_dir: repoDir,
          },
        }),
      });

  let tempDir = null;
  try {
    const artifacts = await requestJson(`/reports/${reportId}/qa-artifacts`);
    const generatedTest = artifacts?.generated_tests?.[0];
    if (!generatedTest?.content) {
      run = await requestJson(`/reports/${reportId}/verification-runs/${run.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'unable_to_reproduce',
          result_summary: 'No generated Playwright test was available for this report.',
          evidence: { generated_test_available: false },
        }),
      });
      console.log(JSON.stringify({ report_id: reportId, run_id: run.id, status: run.status }, null, 2));
      await writeGithubOutputs({
        report_id: reportId,
        verification_run_id: run.id,
        status: run.status,
        result_summary: run.result_summary,
      });
      return;
    }

    const rewritten = rewriteTargetUrl(generatedTest.content, targetUrl);
    tempDir = await mkdtemp(path.join(repoDir, `.annotate-qa-${reportId}-`));
    const testFile = path.join(tempDir, `${reportId}.spec.ts`);
    await writeFile(testFile, rewritten.content, 'utf8');

    const result = await runPlaywright(testFile, rewritten.effectiveTargetUrl ?? targetUrl);
    const status = statusFromResult(result);
    const summary = status === 'fixed'
      ? 'Generated Playwright reproduction passed.'
      : status === 'unable_to_reproduce'
        ? 'Generated Playwright reproduction could not be executed.'
        : status === 'changed_failure'
          ? 'Generated Playwright reproduction failed before reaching the original assertion.'
          : 'Generated Playwright reproduction still fails.';

    run = await requestJson(`/reports/${reportId}/verification-runs/${run.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status,
        target_url: rewritten.effectiveTargetUrl ?? (targetUrl || null),
        git_ref: gitRef || null,
        result_summary: summary,
        evidence: {
          generated_test_id: generatedTest.id,
          generated_test_path: generatedTest.file_path,
          command,
          repo_dir: repoDir,
          test_file: testFile,
          exit_code: result.code,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
        },
      }),
    });

    console.log(JSON.stringify({
      report_id: reportId,
      run_id: run.id,
      status: run.status,
      result_summary: run.result_summary,
    }, null, 2));
    await writeGithubOutputs({
      report_id: reportId,
      verification_run_id: run.id,
      status: run.status,
      result_summary: run.result_summary,
    });
    if (status !== 'fixed') process.exitCode = 1;
  } catch (error) {
    if (run?.id) {
      const failedRun = await requestJson(`/reports/${reportId}/verification-runs/${run.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'failed',
          result_summary: error instanceof Error ? error.message : String(error),
          evidence: { runner_error: error instanceof Error ? error.stack ?? error.message : String(error) },
        }),
      }).catch(() => undefined);
      if (failedRun) {
        await writeGithubOutputs({
          report_id: reportId,
          verification_run_id: failedRun.id,
          status: failedRun.status,
          result_summary: failedRun.result_summary,
        }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (tempDir && process.env.ANNOTATE_KEEP_TEST_ARTIFACTS !== '1') {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
