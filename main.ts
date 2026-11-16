// Driver for the markdown-render-speed-02 regex entry.
//
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (default /input),
// renders each one alone with parse() from ./parse.js, and writes the
// HTML strings, in order, to $MAKEFUN_OUTPUT_DIR/html.json (default
// /output). Node 22+, type stripping, erasable syntax only.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "./parse.js";

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";

const cases = JSON.parse(readFileSync(join(INPUT_DIR, "cases.json"), "utf8")) as {
  id: string;
  markdown: string;
}[];

const html: string[] = [];
for (const c of cases) html.push(parse(c.markdown));
writeFileSync(join(OUTPUT_DIR, "html.json"), JSON.stringify(html));
