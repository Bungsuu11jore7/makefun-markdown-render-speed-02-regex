# makefun-markdown-render-speed-02-regex

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Bungsuu11jore7/makefun-markdown-render-speed-02-regex/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Bungsuu11jore7/makefun-markdown-render-speed-02-regex/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, regex-driven Markdown renderer whose `parse(markdown)`
returns byte-identical HTML to marked 18.1.3 with default options
(GFM on, breaks off, pedantic off), but faster.

## How it works

Three layers, mirroring marked's semantics without its token-tree overhead:

1. **Block pass** — scans the document top to bottom with anchored
   regexes (fenced/indented code, ATX/setext headings, hr, blockquote,
   lists incl. task items, HTML blocks, link reference definitions,
   GFM tables, paragraphs). Inline rendering is deferred so a link
   definition may appear after its use.
2. **Inline pass** — runs after all blocks are lexed, over each block's
   text: escapes, inline HTML/tags, links and reference links, emphasis
   and strong emphasis (with marked's delimiter-run rules), code spans,
   hard breaks, strikethrough, autolinks and extended autolinks,
   entities. Image alt text is rendered through a plain-text renderer.
3. **Direct rendering** — block and inline results are rendered straight
   to strings; no intermediate token objects are kept for inline content.

## Run

```sh
node main.ts
```

It reads `$MAKEFUN_INPUT_DIR/cases.json` (default `/input`) and writes
the HTML array to `$MAKEFUN_OUTPUT_DIR/html.json` (default `/output`).
Node 22, standard library only, no install step.

## Verification

Measured on the practice set (720 cases) on this machine:

- **Scorer: 720/720 identical, `passed: 1`** (kit scorer vs
  `practice/reference`).
- **Determinism:** two runs of `main.ts` produce byte-identical
  `html.json`, sha256
  `e7e89c4fba2c45b1c4aa96c46c987e46c75a9fcdd08916b58ae7f2a7d7851724`
  for both runs (and identical to the marked baseline's output).
- **Speed (in-process, 5 runs over the practice set):** median
  625 ms vs marked 18.1.3 median 978 ms — **1.57x faster**.
- **Fuzz:** 1000 randomly generated documents compared against
  marked 18.1.3 — **0 differences**.

## Files

- `parse.js` — the renderer (`export function parse(markdown)`).
- `main.ts` — the harness driver.

<sub>Entered on [make.fun](https://make.fun/?ref=6wtj6288&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
