# AGENTS.md

Guidance for AI agents (and humans) working in this repository.

## Project

`ollama-review-action` is a GitHub Action that reviews a pull request with an Ollama Cloud model
and posts the result back as inline review comments plus an overall summary. It is a JavaScript
action: a TypeScript source tree compiled and bundled into `dist/index.js`, which is what the
runner actually executes.

| Part | Choice |
| --- | --- |
| Language | TypeScript (strict), compiled to CommonJS |
| Action runtime | `node24` |
| Runtime deps | `@actions/core`, `@actions/github` (octokit) |
| Model API | Ollama, OpenAI-compatible `/v1/chat/completions` |
| GitHub API | REST via octokit: pull request files, reviews, comments |
| Bundler | `@vercel/ncc` - `dist/index.js` is committed |
| Quality | ESLint, `tsc --noEmit`, node:test, c8 thresholds (global, `src/main.ts` excluded), GitHub Actions |

## Architecture

```
src/
├── main.ts     # Entry point. Calls run() and reports a failure.
├── app.ts      # The orchestration, behind an injectable dependency object.
├── config.ts   # Reads and validates the action inputs.
├── diff.ts     # Parses unified diffs, renders them with line numbers, chunks them.
├── github.ts   # The GitHub API layer: fetch files, anchor findings, post comments.
├── ollama.ts   # The model client: chat completions, retries, fallbacks.
├── parse.ts    # Turns the model response into a summary and a list of findings.
├── prompt.ts   # The reviewer prompt and the output schema.
├── render.ts   # Renders a finding and a summary as markdown.
├── select.ts   # Picks the files worth reviewing.
└── types.ts    # The shared types and the severity scale.
```

The flow is: `config` → `github` (fetch the diff) → `diff` (parse and render it) → `prompt` →
`ollama` (ask the model) → `parse` (read the answer) → `github` (post it). `app.ts` wires those
together and `render.ts` / `select.ts` hold the parts that are worth testing on their own.

`app.ts` takes its dependencies through the `Deps` object rather than importing them directly.
That is what makes the whole flow testable against fakes - it is not a mocking framework and not
a testing seam added for its own sake.

## Conventions

### Always use a pull request

**Never push directly to `main`.** Every change goes through a branch and a pull request, and
`main` is protected so a direct push is refused. The same applies to this repository's own
workflow: the CI and the self-review run on pull requests, so a change that is pushed straight to
`main` skips the checks it is supposed to pass.

Open the pull request, let CI run, then merge. Do not merge your own pull request without saying
so explicitly - the branch protection requires a pull request, not an approval, so the merge is
yours to make.

### `dist/` is committed and must be rebuilt

The runner executes `dist/index.js`, not `src/`. A change under `src/` that is not rebuilt is a
change that does not happen. CI fails when `dist/` is out of date, which catches this, but the
commit should still contain the rebuilt bundle.

### The pinned SHA has to be moved by hand

The action is pinned to a full commit SHA in `README.md` and in `.github/workflows/self-review.yml`.
A SHA is immutable, which is the point - but it means a new release is not picked up on its own.
CI fails if the two pins drift apart.

There is one release tag, `v1`, and it is a *moving* annotated tag: it always points at the commit
that consumers should be on. It is only bumped at release time, and it is never created per-fix.
Consumers who pin a SHA (as our own docs recommend) never notice the tag moving; `v1` exists for
people who prefer `uses: mlk/ollama-review-action@v1`. `package.json`'s `version` field is not used
to drive releases.

Cutting a release is therefore two pull requests plus one tag move:

1. The change itself. Merge it, then move the tag to the merge commit **from an up-to-date `main`**
   (tagging your local branch or a stale `main` tags the wrong commit):

   ```bash
   git fetch origin && git switch main && git pull
   git tag -fa v1 -m v1          # -f is required once v1 exists; -a keeps it annotated
   git push origin v1 --force
   ```

2. A pull request that moves both pins (`README.md` and `.github/workflows/self-review.yml`) to the
   SHA the tag now points at: `gh api repos/{owner}/{repo}/commits/v1 --jq .sha`.

The order matters: tag first, then move the pins, so the pins never point at a commit that is not
released.

### Coverage is a floor, not a target

`npm run coverage` enforces global (not per-file) thresholds on `src/` - see `package.json` for the current values. `src/main.ts` is excluded because it is only the entrypoint that calls `run()` and reports failures.

A new behaviour without a test is not finished. When a module is hard to test, that is a signal
about the shape of the module, not a reason to leave it untested - `app.ts` and `render.ts` were
both extracted from `main.ts` for exactly this reason.

### Keep the model honest

The model is asked to report only what it can point at in the diff. Two rules in `prompt.ts`
exist because the model got it wrong in practice:

* it must not assert facts the diff cannot show - whether a library, model or version exists is
  not checkable from a diff, so it has to be raised as a question;
* it must not pad the review. An empty finding list is a valid answer.

Do not weaken these to make a run look better.

### Only retry what a retry can fix

The model client retries rate limits and server errors. A 401, a 404 or a 400 is a fact about
the request, and retrying it just burns the backoff before failing the same way. If a new error
is added to the client, decide deliberately whether a retry can help.

### Findings are anchored to real lines

A review comment can only be attached to a line that is part of the diff. `github.ts` snaps a
finding to the nearest valid line, or drops it to the summary. Do not relax that: a comment on a
line GitHub rejects makes the whole review fail with a 422.

## Commands

```bash
npm install
npm run lint        # ESLint over src and test
npm run typecheck   # tsc --noEmit
npm test            # The unit tests
npm run coverage    # The unit tests plus the coverage report and the thresholds
npm run build       # Bundle src/main.ts into dist/index.js
```

Run `npm run all` before opening a pull request - it runs the lint, typecheck, coverage and build steps that CI also runs. CI additionally verifies the bundle is complete (`verify:bundle`), that `dist/` matches `src/`, and that the pinned action SHA in `README.md` and `.github/workflows/self-review.yml` agree.

## Development

The usual loop is: change `src/`, add or update a test, run `npm run all`, rebuild `dist/`, and
open a pull request.

Pull requests to this repo get an automated review from the action itself
(`.github/workflows/self-review.yml`). Treat its findings as input, not verdicts: fix what is real,
and say why the rest does not apply.

### Testing conventions

- Tests use the `node:test` runner and `node:assert/strict`, live in `test/`, and mirror the
  module they cover.
- `npm test` first compiles to `lib/` (`tsc -p tsconfig.test.json`) and then runs
  `node --test lib/test/*.test.js`. `lib/` is gitignored build output.
- The model client is tested by stubbing `globalThis.fetch` and restoring it in `afterEach`.
- The GitHub API is faked with plain object literals cast `as unknown as Octokit` - no mocking
  library, and fakes stay minimal on purpose.
- Tests that touch `github.context.payload` or `GITHUB_REF` save and restore them around the test.
- Tests must not hit the network, the clock or the filesystem.

## Traps

- Never hand-edit `dist/index.js` - rebuild it. CI rejects a stale bundle.
- Never push to `main`. Open a pull request; the self-review and CI run there.
- Never weaken the two honesty rules in `prompt.ts`, and never relax the line-anchoring in
  `github.ts` to make a test pass.
- Never merge your own pull request or tag a release without saying so explicitly.
- Reviewers see `dist/` in the diff - an unexplained `dist/` change is a red flag in review.
- This file is loaded into the reviewer's context on releases that include `context_files`, so it
  is worth keeping accurate. A stale AGENTS.md teaches every future review the wrong conventions.
