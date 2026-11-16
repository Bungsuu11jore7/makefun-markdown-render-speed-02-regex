# makefun-markdown-render-speed-02-regex

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Bungsuu11jore7/makefun-markdown-render-speed-02-regex/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Bungsuu11jore7/makefun-markdown-render-speed-02-regex/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)


An entry for the make.fun `markdown-render-speed-02` competition ($250).

`parse.js` is a dependency-free ES module. Its `parse(markdown)` returns
the exact HTML that marked 18.1.3 produces with its default settings
(GFM on, `breaks` off, `pedantic` off) — the same string, character for
character, on every case in the practice set.

## How it works

The parser is written as three layers that stay close to the reference
semantics while skipping work the reference repeats:

- **Block pass.** A scanner walks the document top to bottom and tries
  block constructs in the reference's order, but each attempt is guarded
  by the first character (after at most three spaces), so a line that
  cannot be a heading, a fence, a quote or a list never pays for those
  patterns. Tables and setext headings get an extra cheap guard: they
  are only attempted when a following line looks like a delimiter row or
  an underline. Indented code merges into a preceding paragraph exactly
  like the reference; fenced code never does.
- **Inline pass.** Inline content is queued during the block pass and
  resolved only afterwards, so a link definition may appear after the
  link that uses it. The inline scanner dispatches on the first
  character too — escape, tag, link, emphasis, code span, hard break,
  strikethrough, autolink and extended autolink are each tried only
  where they can match — and extended autolinks get a small prefix
  pre-check before the wide pattern runs. Emphasis and strikethrough
  use the reference's masking trick: link, code and HTML spans are
  replaced by same-length filler first, so a delimiter inside them can
  never close a span.
- **Rendering.** Block tokens render to strings directly, and image alt
  text is rendered through a plain-text renderer that drops markup and
  keeps the words.

Patterns are composed from shared cores (paragraph, setext heading,
table, blockquote, HTML block) so the interruption rules are identical
wherever they are used, and every pattern is compiled once at module
load.

## Layout

- `parse.js` — the parser; the only file that matters for scoring.
- `main.ts` — the driver: reads `MAKEFUN_INPUT_DIR/cases.json`, renders
  each case alone with `parse`, writes `MAKEFUN_OUTPUT_DIR/html.json`.
- `.makefun/owner.json` — the owner's wallet claim.

## Running it

```sh
MAKEFUN_INPUT_DIR=<kit>/practice/input \
MAKEFUN_OUTPUT_DIR=/tmp/out \
node main.ts
```

That writes `/tmp/out/html.json`, a JSON array of one HTML string per
case, in the cases' order. The kit scorer checks it against the
reference:

```sh
MAKEFUN_OUTPUT_DIR=/tmp/out \
MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
MAKEFUN_SCORES_DIR=/tmp/scores \
node <kit>/program/scorer/main.ts
```

## Verification

- Practice set: **720/720 cases identical** to the reference
  (`scores.json` reports `passed: 1`).
- Extra fuzzing against marked 18.1.3 on this build: 3,500 generated
  documents (spec-example concatenations, inline-heavy random strings
  and mutated spec examples) plus 840 document slices, document mixes
  and emphasis/link torture cases — **0 differences**.
- Speed on the practice set, fresh `node` process per run: **~1.30x**
  faster than the house baseline (marked itself behind the same
  driver), median over 5 runs each; in-process median over repeated
  runs is ~1.36x.
---

<sub>Entered on [make.fun](https://make.fun/?ref=6wtj6288&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
