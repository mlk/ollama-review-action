# Ollama PR Review

A GitHub Action that sends your pull request diff to an [Ollama Cloud](https://ollama.com/cloud) model and posts the result back as **inline review comments** plus an overall summary.

- No OpenAI, no Anthropic - just an Ollama API key and a model name.
- Uses the model of your choice: `glm-5.3`, `kimi-k3.1-pro`, `deepseek-v4.1-flash`, ... whatever your account has access to.
- Comments land on the exact lines that changed, so they show up in the "Files changed" tab.
- Never runs code from the pull request - the diff is fetched through the GitHub API, so it is safe on untrusted forks.

## Setup

**1. Create an Ollama API key** at [ollama.com/settings/keys](https://ollama.com/settings/keys).

**2. Add it as a repository secret** (`Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`):

| Secret | Value |
| --- | --- |
| `OLLAMA_API_KEY` | your Ollama API key |

**3. Add the workflow** to `.github/workflows/ollama-review.yml` in the repository you want to review:

```yaml
name: Ollama Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: mlk/ollama-review-action@v1
        with:
          model: glm-5.3
        env:
          OLLAMA_API_KEY: ${{ secrets.OLLAMA_API_KEY }}
```

`actions/checkout` is not required by the action itself (it reads the diff from the API), but keeping it lets the model see the full repository if you extend the prompt later.

### Pull requests from forks

Workflows triggered by `pull_request` from a fork get a read-only token, so posting the review fails. Use `pull_request_target` if you review fork PRs:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened]
```

This is safe here because the action never checks out or executes code from the pull request. It only reads the diff through the API.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `model` | _required_ | Ollama Cloud model id, e.g. `glm-5.3`. There is deliberately no default - pick the one that fits your budget and latency needs. |
| `ollama_api_key` | `OLLAMA_API_KEY` env | Ollama API key. Prefer passing it as an environment variable from a secret. |
| `ollama_host` | `https://ollama.com` | Base URL of the Ollama API. Point this at a self-hosted proxy if you use one. |
| `github-token` | `GITHUB_TOKEN` env | Token used to read the PR and post the review. |
| `prompt` | - | Extra review instructions appended to the default reviewer prompt. |
| `max_diff_chars` | `60000` | Maximum characters of diff per request. Larger diffs are split across several requests. |
| `max_files` | `50` | Maximum number of changed files to review. |
| `exclude_paths` | - | Comma-separated glob patterns to skip, e.g. `**/*.lock,dist/**,docs/**`. |
| `reasoning_effort` | model default | Thinking budget for reasoning models: `low`, `medium`, `high`. |
| `temperature` | `0.2` | Sampling temperature. |
| `fail_on` | `none` | Fail the job when a finding of this severity or worse appears: `none`, `nit`, `minor`, `major`, `critical`, `blocker`. |
| `post_review` | `true` | Set to `false` to print the review to the job log without posting it. |

## Outputs

| Output | Description |
| --- | --- |
| `summary` | The overall review summary. |
| `findings_count` | Number of findings posted as inline comments. |
| `review_id` | ID of the review that was created or updated. |
| `failed` | `true` when a finding reached the `fail_on` threshold. |

## Blocking a pull request

```yaml
- uses: mlk/ollama-review-action@v1
  with:
    model: glm-5.3
    fail_on: critical
  env:
    OLLAMA_API_KEY: ${{ secrets.OLLAMA_API_KEY }}
```

The review is always posted first; the job fails afterwards if the model reported a finding at or above the threshold. Combine it with a required status check to block merges.

## Customising the review

Add repository-specific instructions with the `prompt` input:

```yaml
- uses: mlk/ollama-review-action@v1
  with:
    model: glm-5.3
    prompt: |
      Our API must stay backwards compatible.
      Focus on database migrations and transaction handling.
      Ignore changes to generated files.
```

## How it works

1. The action fetches the changed files and their patches from the GitHub API and parses each hunk, tracking line numbers in both the old and new revision.
2. The diff is rendered with explicit line numbers, so the model can point at a specific line instead of guessing.
3. Diffs larger than `max_diff_chars` are split into chunks and reviewed in separate requests; the findings are merged afterwards.
4. The model returns JSON (`summary` + `findings`). The action parses it, tolerating markdown fences and reasoning blocks.
5. Each finding is anchored to a line GitHub accepts a comment on. Findings that land on a line outside the diff are either snapped to the nearest valid line or listed in the summary under "Other observations".
6. The review is posted through `POST /pulls/{n}/reviews` with `event: COMMENT`. On a new push to an already-reviewed PR, the previous review is updated instead of adding another one, so the conversation does not fill up with stale reviews.

## Troubleshooting

**"Input \"model\" is required"** - pass a `model` input. The action ships without a default model on purpose.

**"No Ollama API key found"** - make sure the secret is named `OLLAMA_API_KEY` and is passed via `env:` on the step.

**401 from Ollama** - the key is wrong or expired. Check <https://ollama.com/settings/keys>.

**"Model not found"** - the model id must match one from <https://ollama.com/search?c=cloud> and be available to your account.

**The review has no inline comments** - GitHub omits the patch for very large diffs, and only lines that appear in the diff can be commented on. Those files are skipped and listed in the job log. Raise `max_diff_chars` or lower `max_files` to focus the review.

**Timeouts on large pull requests** - the default timeout is 3 minutes per request. Split the work by lowering `max_diff_chars`, or use a faster model.

## Development

```bash
npm install
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # unit tests
npm run build       # bundle to dist/index.js with ncc
```

`dist/` is committed because GitHub Actions runs the bundled JavaScript directly. After changing anything under `src/`, run `npm run build` and commit the updated bundle - CI fails if `dist/` is out of date.

## License

MIT
