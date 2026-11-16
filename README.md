# makefun-markdown-render-speed-02-regex

Entry for the make.fun `markdown-render-speed-02` competition ($250).

`parse.js` is a dependency-free ES module exporting `parse(markdown)`, which
returns HTML byte-for-byte identical to marked 18.1.3 with default options
(GFM on) for every case in the practice set (720/720).

## Approach

Regex / state-machine hybrid, tuned for speed:

- anchored regexes with minimal backtracking for block and inline parsing;
- a fast plain-text scan (`textChunkLen`) that replaces the inline text
  regex — one combined scan for stop characters, hard breaks, protocols,
  `mailto:`/`xmpp:`/`www.` and email runs;
- first-character dispatch in the block loop and in the list-item loop, so
  tokenizers that cannot match are never run;
- a per-document pre-scan is implicit: link-definition masking, table
  parsing and setext-heading matching are all guarded by cheap checks, so
  documents without those constructs skip the expensive paths entirely;
- regexes compiled once at module level, outside `parse`; no global regex
  is reset per call (except the two scanners in `textChunkLen`, whose
  `lastIndex` is managed explicitly);
- no token objects: the block phase builds a light node tree and inline
  rendering writes straight to strings.

## Layout

- `parse.js` — the parser (entrypoint).
- `main.ts` — driver: reads `MAKEFUN_INPUT_DIR/cases.json`, renders each
  case alone with `parse`, writes `MAKEFUN_OUTPUT_DIR/html.json`.
- `.makefun/owner.json` — owner wallet.

## Local verification

720/720 cases identical to the reference on the practice set (kit scorer
passes), plus 0 diffs on 3,000 randomized fuzz documents against marked
18.1.3 and 0 mismatches on 30,720 targeted text-chunk cases.
