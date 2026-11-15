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
| Quality | ESLint, `tsc --noEmit`, node:test, c8 (80%+ coverage enforced), GitHub Actions |

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

Cutting a release is therefore two pull requests:

1. The change itself. Merge it, then tag the merge commit: `git tag -a v1 -m v1 && git push origin v1`.
2. A pull request that moves both pins to the new commit.

### Coverage is a floor, not a target

`npm run coverage` fails the build below 85% line, 80% branch, 85% function and 85% statement
coverage of `src/`. `src/main.ts` is excluded because it is only the entrypoint that calls
`run()` and reports failures.

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

`npm run all` runs lint, typecheck, test and build in one go.

## Development

The usual loop is: change `src/`, add or update a test, run `npm run all`, rebuild `dist/`, and
open a pull request.

The tests use the node:test runner and `node:assert/strict`. They live in `test/` and mirror the
module they cover. Fakes are plain objects - a fake octokit is an object literal, and the model
client is tested by replacing `globalThis.fetch` for the duration of a test.
