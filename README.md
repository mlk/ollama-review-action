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

concurrency:
  group: ollama-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: >-
      github.event.pull_request.draft == false &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: mlk/ollama-review-action@637b8047b5f317fe1576941dc98ee5475414c5f7 # v1
        with:
          model: glm-5.3
        env:
          OLLAMA_API_KEY: ${{ secrets.OLLAMA_API_KEY }}
```

There is deliberately no `actions/checkout` step: the action reads the diff through the GitHub API and never touches the working tree, so checking out the repository would download it for nothing on every push. Add a checkout only if you extend the action to read files from the repository.

The details in that snippet are worth keeping:

| Line | Why |
| --- | --- |
| `permissions` | The action only needs to read the repo and write to the pull request. Anything broader is a risk if the action is ever compromised. |
| `if` | Skips draft pull requests (every push to a draft would otherwise spend a model call) and pull requests from forks (secrets are withheld there, so the action would fail with no API key). See [Pull requests from forks](#pull-requests-from-forks) to review those too. |
| `concurrency` | `synchronize` fires on every push. Without a group, rapid pushes start overlapping runs that post reviews on top of each other. `cancel-in-progress` keeps only the newest one. |
| `timeout-minutes` | The runner default is 6 hours. A stuck model call should fail in minutes, not hold a runner. |
| Commit SHA pin | See below. |

### Pinning to a commit SHA

The example pins the action to a commit SHA rather than the `v1` tag. Tags are mutable - anyone who can push to this repository can repoint `v1` at different code, and that code runs in your workflow with access to your `OLLAMA_API_KEY` and a token with `pull-requests: write`. A SHA is immutable.

The trailing `# v1` comment is just for humans; GitHub ignores it. To move to a newer release, look up the SHA for the tag you want and replace it:

```bash
gh api repos/mlk/ollama-review-action/commits/v1 --jq .sha
```

Use that rather than `git ls-remote ... refs/tags/v1`, which prints the SHA of the *annotated tag object* rather than the commit it points at, and so looks like a mismatch when it is not.

Pin the same SHA in the README and in your own workflow - CI in this repository checks that the two never drift apart. Pinning to a SHA means you do not get new releases automatically. If you would rather track the tag, use `mlk/ollama-review-action@v1` and accept the tradeoff.

### Pull requests from forks

The example above skips pull requests from forks, because GitHub withholds repository secrets there - the action would start up with no API key and fail. To review them as well, switch the trigger to `pull_request_target` and drop the repository check from the `if` condition:

```yaml
on:
  pull_request_target:
    types: [opened, synchronize, reopened]

jobs:
  review:
    if: github.event.pull_request.draft == false
```

This is safe here because the action never checks out or executes code from the pull request. It only reads the diff through the API. Note that `pull_request_target` runs with the secrets of the base repository, so treat it as you would any other workflow that holds your API key.

### Before you trust it with a secret

The action needs `pull-requests: write` and your `OLLAMA_API_KEY`, so it is worth reading the source before you wire it into a repository you care about. It is a few hundred lines in `src/`, and the bundled `dist/index.js` is the exact artifact that runs - the SHA pin in the example is what makes that review meaningful, since a tag could be repointed later.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `model` | _required_ | Ollama Cloud model id, e.g. `glm-5.3`. There is deliberately no default - pick the one that fits your budget and latency needs. |
| `ollama_api_key` | `OLLAMA_API_KEY` env | Ollama API key. Prefer passing it as an environment variable from a secret. |
| `ollama_host` | `https://ollama.com` | Base URL of the Ollama API. Must use `https://`. Plain `http://` is only accepted for loopback addresses (`localhost`, `127.0.0.0/8`, `[::1]`) for local development; anything else is rejected when the action starts. The Ollama API key is never sent to a different origin - see "The Ollama host and TLS" below. |
| `github-token` | `${{ github.token }}` | Token used to read the PR and post the review. The workflow token is picked up automatically - you only need to override this to use a PAT. |
| `prompt` | - | Extra review instructions appended to the default reviewer prompt. |
| `max_diff_chars` | `60000` | Maximum characters of diff per request. Larger diffs are split across several requests. |
| `max_files` | `50` | Maximum number of changed files to review. |
| `exclude_paths` | - | Comma-separated glob patterns to skip, e.g. `**/*.lock,dist/**,docs/**`. |
| `context_files` | `AGENTS.md,README.md` | Comma-separated repository files to include in the prompt as review context, read at the base commit (so a pull request cannot inject its own guidance). Missing files are skipped; set to `none` to disable. |
| `context_max_chars` | `12000` | Maximum characters per context file before it is truncated. |
| `reasoning_effort` | model default | Thinking budget for reasoning models: `low`, `medium`, `high`. |
| `temperature` | `0.2` | Sampling temperature. |
| `fail_on` | `none` | Fail the job when a finding of this severity or worse appears: `none`, `nit`, `minor`, `major`, `critical`, `blocker`. |
| `post_review` | `true` | Set to `false` to print the review to the job log without posting it. |

## The Ollama host and TLS

The Ollama API key is sent as a bearer token with every request, so `ollama_host` is validated
before any request is made:

- The host must use `https://`. Plain `http://` is only accepted for loopback addresses
  (`localhost`, anything under `127.0.0.0/8`, or `[::1]`), which is meant for a local Ollama
  server during development, e.g. `ollama_host: http://localhost:11434`.
- The URL must be valid and must not embed credentials (`https://user:pass@host` is rejected).
- Redirects are followed only within the same origin. If the API answers with a redirect to a
  different origin, the request is refused rather than re-sending the key there.

Anything else fails the action at startup with a clear error, before any network call is made.

## Outputs

| Output | Description |
| --- | --- |
| `summary` | The overall review summary. |
| `findings_count` | Number of findings posted as inline comments. |
| `comment_id` | ID of the pull request comment holding the review summary. |
| `failed` | `true` when a finding reached the `fail_on` threshold. |

## Blocking a pull request

```yaml
- uses: mlk/ollama-review-action@637b8047b5f317fe1576941dc98ee5475414c5f7 # v1
  with:
    model: glm-5.3
    fail_on: critical
  env:
    OLLAMA_API_KEY: ${{ secrets.OLLAMA_API_KEY }}
```

The review is always posted first; the job fails afterwards if the model reported a finding at or above the threshold. Combine it with a required status check to block merges.

## Customising the review

The reviewer automatically reads `AGENTS.md` and `README.md` from the base commit of the pull request and treats them as project context, so the conventions you document there are applied without having to repeat them per review. Change the list with `context_files` (for example add `CONTRIBUTING.md`), or set it to `none` to disable.

You can also add one-off instructions with the `prompt` input:

```yaml
- uses: mlk/ollama-review-action@637b8047b5f317fe1576941dc98ee5475414c5f7 # v1
  with:
    model: glm-5.3
    prompt: |
      Our API must stay backwards compatible.
      Focus on database migrations and transaction handling.
      Ignore changes to generated files.
```

## How it works

1. The action fetches the changed files and their patches from the GitHub API and parses each hunk, tracking line numbers in both the old and new revision. It also reads the files listed in `context_files` (`AGENTS.md` and `README.md` by default) from the base commit - so a pull request cannot inject its own guidance - to give the model the project's own conventions.
2. The diff is rendered with explicit line numbers, so the model can point at a specific line instead of guessing.
3. Diffs larger than `max_diff_chars` are split into chunks and reviewed in separate requests; the findings are merged afterwards.
4. The model returns JSON (`summary` + `findings`). The action parses it, tolerating markdown fences and reasoning blocks.
5. Each finding is anchored to a line GitHub accepts a comment on. Findings that land on a line outside the diff are either snapped to the nearest valid line or listed in the summary under "Other observations".
6. The summary is posted as a sticky pull request comment and each finding is posted as an inline review comment on the changed line.
7. When the pull request is pushed to again, the previous summary comment is edited in place and the previous inline comments are removed before the new ones are posted, so a busy pull request does not fill up with stale reviews.

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
npm run coverage    # unit tests with a coverage report and thresholds
npm run build       # bundle to dist/index.js with ncc
```

`dist/` is committed because GitHub Actions runs the bundled JavaScript directly. After changing anything under `src/`, run `npm run build` and commit the updated bundle - CI fails if `dist/` is out of date.

`npm run coverage` enforces a floor of 85% line coverage, 78% branch coverage and 85% function coverage over `src/`, so a change that quietly drops the tests fails the build. `src/main.ts` is excluded because it is only the entrypoint that calls `run()` and reports failures.

### Cutting a release

```bash
git fetch origin && git switch main && git pull
git tag -fa v1 -m "v1"   # move the existing annotated tag to the merge commit
git push origin v1 --force
```

`v1` is a moving tag - it always points at the release commit. Do not create per-release tags. Then bump the pinned SHA in `README.md` and `.github/workflows/self-review.yml` to the commit the tag now points at, so the example always points at the release it documents. CI fails if those two pins drift apart.

```bash
gh api repos/mlk/ollama-review-action/commits/v1 --jq .sha
```

## License

MIT
