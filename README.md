# Annotator QA Runner

Public runner scripts for customer-owned repositories that use Annotator QA verification.

## Scripts

- `scripts/qa/resolve-report-id.mjs`: resolves an Annotator report ID from workflow input or PR title/body.
- `scripts/qa/run-verification.mjs`: fetches the generated Playwright regression, runs it in the customer repository, and reports the verification status back to Annotator.
- `scripts/qa/comment-pr-verification.mjs`: adds or updates an Annotator QA verification comment on the pull request.

## Required Environment

- `ANNOTATE_API_URL`
- `ANNOTATE_RUNNER_TOKEN`
- `ANNOTATE_REPORT_ID`
- `ANNOTATE_TARGET_URL`
- `ANNOTATE_REPRO_BASE_URL`
- `ANNOTATE_GIT_REF`
- `ANNOTATE_REPO_DIR`

The customer repository must install its own app dependencies and Playwright before invoking `run-verification.mjs`.
