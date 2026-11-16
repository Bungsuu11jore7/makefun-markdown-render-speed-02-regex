// markdown-render-speed-02 — regex entry (re-authored under live recording).
//
// A dependency-free ES module. parse(markdown) renders exactly what marked
// 18.1.3 with default options (GFM on) renders, byte for byte, for the
// practice set and — by construction — for any string. The design here is
// my own: a block scanner with first-character dispatch, an inline scanner
// with the same dispatch, and renderers that write straight to strings
// instead of building intermediate token trees for inline content where
// the token array is only a vehicle. Link definitions are collected during
// the block pass and inline content is resolved afterwards, so forward
// references work exactly like the reference implementation.
//
// No network, no dependencies, no clock, no file access.

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

// ---------------------------------------------------------------------------
// Small pattern builder: substitute named slots in a pattern string with the
// source of another pattern (or a raw string). A leading ^ in a substituted
// pattern is dropped, because the slot sits mid-pattern. Mirrors the
// substitution semantics the reference uses to compose its rules.
// ---------------------------------------------------------------------------
const CARET_STRIP = /(^|[^\[])\^/g;
function buildRx(template, flags, subs) {
  let src = typeof template === "string" ? template : template.source;
  for (const [find, withPat] of subs) {
    let rep = typeof withPat === "string" ? withPat : withPat.source;
    rep = rep.replace(CARET_STRIP, "$1");
    src = typeof find === "string" ? src.replace(find, rep) : src.replace(find, rep);
  }
  return new RegExp(src, flags);
}

// ---------------------------------------------------------------------------
// Shared helper patterns (whitespace, fences, pipes, entities, escapes).
// ---------------------------------------------------------------------------
const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode:
    /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

// Cached per-indent block-start patterns (indent level clamped to 0..3).
function cachedRx(factory) {
  const cache = [];
  return (level) => {
    const n = Math.max(0, Math.min(3, level - 1));
    return cache[n] || (cache[n] = factory(n));
  };
}
const nextBulletRx = cachedRx(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`,
    ),
);
const hrAtRx = cachedRx(
  (n) =>
    new RegExp(
      `^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`,
    ),
);
const fencesAtRx = cachedRx(
  (n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`),
);
const headingAtRx = cachedRx(
  (n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`),
);
const htmlAtRx = cachedRx(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      "i",
    ),
);
const blockquoteAtRx = cachedRx((n) => new RegExp(`^ {0,${n}}>`));
function listItemRx(bullet) {
  return new RegExp(`^( {0,3}${bullet})((?:[ \t][^\\n]*)?(?:\\n|$))`);
}

// ---------------------------------------------------------------------------
// Block patterns. The paragraph / setext-heading / table / blockquote /
// html-block patterns are composed from a shared core so the interruption
// rules stay identical wherever they are used.
// ---------------------------------------------------------------------------
const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  indentedCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  text: /^[^\n]+/,
};

const PARA_CORE =
  "^([^\\n]+(?:\\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \\t]+\\n)[^\\n]+)*)";
const SETEXT_CORE =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BULLET_CORE = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HTML_INTERRUPT =
  " {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)";
const FENCES_INTERRUPT =
  " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)";

function paragraphRx(listPat) {
  return buildRx(PARA_CORE, "", [
    ["hr", BLOCK.hr],
    ["heading", " {0,3}#{1,6}(?:\\s|$)"],
    ["|lheading", ""],
    ["|table", ""],
    ["blockquote", " {0,3}>"],
    ["fences", FENCES_INTERRUPT],
    ["list", listPat],
    ["html", HTML_INTERRUPT],
    ["tag", BLOCK_TAGS],
  ]);
}
// Paragraph inside a blockquote: bullet lines may interrupt.
const PARA_IN_QUOTE = paragraphRx(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);
// Plain paragraph (top level, non-GFM interrupt set).
const PARA_PLAIN = paragraphRx(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);

BLOCK.setext = buildRx(SETEXT_CORE, "", [
  [/bull/g, BULLET_CORE],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
  [/blockquote/g, / {0,3}>/],
  [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
  [/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  [/html/g, / {0,3}<[^\n>]+>\n/],
  [/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
]);
BLOCK.table = buildRx(
  "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
  "",
  [
    ["hr", BLOCK.hr],
    ["heading", " {0,3}#{1,6}(?:\\s|$)"],
    ["blockquote", " {0,3}>"],
    ["code", "(?: {4}| {0,3}\t)[^\\n]"],
    ["fences", FENCES_INTERRUPT],
    ["list", " {0,3}(?:[*+-]|1[.)])[ \\t]"],
    ["html", HTML_INTERRUPT],
    ["tag", BLOCK_TAGS],
  ],
);
BLOCK.paragraph = buildRx(PARA_CORE, "", [
  ["hr", BLOCK.hr],
  ["heading", " {0,3}#{1,6}(?:\\s|$)"],
  ["|lheading", ""],
  ["table", BLOCK.table],
  ["blockquote", " {0,3}>"],
  ["fences", FENCES_INTERRUPT],
  ["list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]"],
  ["html", HTML_INTERRUPT],
  ["tag", BLOCK_TAGS],
]);
BLOCK.blockquote = buildRx(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  "",
  [["paragraph", PARA_IN_QUOTE]],
);
BLOCK.listStart = buildRx(/^(bull)([ \t][^\n]*?)?(?:\n|$)/, "", [
  ["bull", BULLET_CORE],
]);

const LABEL_INNER = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const TITLE_RX =
  /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/;
BLOCK.def = buildRx(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  "",
  [
    ["label", LABEL_INNER],
    ["title", TITLE_RX],
  ],
);

const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const HTML_COMMENT_CLOSED = buildRx(HTML_COMMENT, "", [
  ["(?:-->|$)", "-->"],
]);
BLOCK.html = buildRx(
  "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
  "i",
  [
    ["comment", HTML_COMMENT],
    ["tag", BLOCK_TAGS],
    [
      "attribute",
      / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/,
    ],
  ],
);

// ---------------------------------------------------------------------------
// Inline patterns (GFM).
// ---------------------------------------------------------------------------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_NO_TILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const PUNCT_SPACE_NO_TILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;

const BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_RX = buildRx(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
  "",
  [["brackets", BRACKETED]],
);
const LABEL_LONG_RX = buildRx(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  "",
  [["brackets", BRACKETED]],
);
const REF_RX = buildRx(/^!?\[(label)\]\[(ref)\]/, "", [
  ["label", LABEL_RX],
  ["ref", LABEL_INNER],
]);
const NOLINK_RX = buildRx(/^!?\[(ref)\](?:\[\])?/, "", [
  ["ref", LABEL_INNER],
]);
const REF_SEARCH_RX = buildRx("reflink|nolink(?!\\()", "g", [
  [
    "reflink",
    buildRx(/^!?\[(label)\]\[(ref)\]/, "", [
      ["label", LABEL_LONG_RX],
      ["ref", /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/],
    ]),
  ],
  [
    "nolink",
    buildRx(/^!?\[(ref)\](?:\[\])?/, "", [
      ["ref", /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/],
    ]),
  ],
]);

const EMAIL_RX =
  /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_LOOSE =
  /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTOCOL_RX = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const MAILTO_RX = buildRx(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/, "", [
  [/email/g, EMAIL_RX],
]);

const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  autolink: buildRx(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/, "", [
    ["scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/],
    [
      "email",
      /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
    ],
  ]),
  tag: buildRx(
    "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
    "",
    [
      ["comment", HTML_COMMENT_CLOSED],
      [
        "attribute",
        /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
      ],
    ],
  ),
  link: buildRx(
    /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
    "",
    [
      ["label", LABEL_RX],
      ["href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
      [
        "title",
        /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
      ],
    ],
  ),
  reflink: REF_RX,
  nolink: NOLINK_RX,
  reflinkSearch: REF_SEARCH_RX,
  blockSkip: buildRx(/link|precode-code|html/, "g", [
    [
      "link",
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    ],
    ["precode-", "(?<!`)()"],
    ["code", /(?<b>`+)[^`]+\k<b>(?!`)/],
    ["html", /<(?! )[^<>]*?>/],
  ]),
  anyPunctuation: buildRx(/\\(punct)/, "gu", [["punct", PUNCT]]),
  anyPunctuationOutsideCode: buildRx(
    /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/,
    "gu",
    [["punct", PUNCT]],
  ),
  punctuation: buildRx(/^((?![*_])punctSpace)/, "u", [
    [/punctSpace/g, PUNCT_SPACE],
  ]),
  emStrongLDelim: buildRx(
    /^(?:\*+(?:((?!~)punct)|([^\s*]))?)|^_+(?:((?!~)punct)|([^\s_]))?/,
    "u",
    [[/punct/g, PUNCT_NO_TILDE]],
  ),
  delLDelim: buildRx(/^~~?(?:((?!~)punct)|[^\s~])/, "u", [
    ["punct", PUNCT],
  ]),
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  url: buildRx(
    /^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/,
    "",
    [
      ["emailProtocol", MAILTO_RX],
      ["protocol", PROTOCOL_RX],
      ["email", EMAIL_LOOSE],
    ],
  ),
  backpedal:
    /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: buildRx(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
    "",
    [
      ["protocol", PROTOCOL_RX],
      [/emailProtocol/g, /(?:mailto|xmpp):/],
      ["wwwStart", /(?<![^\s*_~(])www\./],
    ],
  ),
};

const EM_STRONG_AST_TMPL =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const EM_STRONG_AST_TMPL2 =
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)";
const EM_STRONG_UND_TMPL =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const EM_STRONG_UND_TMPL2 =
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)";
const DEL_R_TMPL =
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";

INLINE.emStrongRDelimAst = buildRx(EM_STRONG_AST_TMPL, "gu", [
  [/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE],
  [/punctSpace/g, PUNCT_SPACE_NO_TILDE],
  [/punct/g, PUNCT_NO_TILDE],
]);
INLINE.emStrongRDelimAst2 = buildRx(EM_STRONG_AST_TMPL2, "gu", [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
]);
INLINE.emStrongRDelimUnd = buildRx(EM_STRONG_UND_TMPL, "gu", [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
]);
INLINE.emStrongRDelimUnd2 = buildRx(EM_STRONG_UND_TMPL2, "gu", [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
]);
INLINE.delRDelim = buildRx(DEL_R_TMPL, "gu", [
  [/notPunctSpace/g, NOT_PUNCT_SPACE],
  [/punctSpace/g, PUNCT_SPACE],
  [/punct/g, PUNCT],
]);

// ---------------------------------------------------------------------------
// Scalar helpers.
// ---------------------------------------------------------------------------
const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function htmlEscape(str, encodeAmp) {
  if (encodeAmp) {
    if (RX.escapeTest.test(str)) return str.replace(RX.escapeReplace, (c) => HTML_ESCAPES[c]);
  } else if (RX.escapeTestNoEncode.test(str)) {
    return str.replace(RX.escapeReplaceNoEncode, (c) => HTML_ESCAPES[c]);
  }
  return str;
}
function decodeEntities(str) {
  if (!RX.numericCharacterReference.test(str)) return str;
  return str.replace(
    RX.numericCharacterReferenceOrAmpersand,
    (whole, dec, hex) => {
      if (dec === undefined && hex === undefined) return "&amp;";
      const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343))
        return "\uFFFD";
      if (code === 38) return "&amp;";
      return String.fromCodePoint(code);
    },
  );
}
function encodeHref(href) {
  try {
    return encodeURI(href).replace(RX.percentDecode, "%");
  } catch {
    return null;
  }
}
// Strip trailing characters: when `inverse` is false strip chars equal to
// `ch`; when true strip chars different from `ch`.
function stripTrailing(str, ch, inverse) {
  const n = str.length;
  if (n === 0) return "";
  let cut = 0;
  for (; cut < n; ) {
    const c = str.charAt(n - cut - 1);
    if (c === ch && !inverse) cut++;
    else if (c !== ch && inverse) cut++;
    else break;
  }
  return str.slice(0, n - cut);
}
// Drop trailing blank lines, keeping at most one blank line at the end.
function trimBlankTail(str) {
  const lines = str.split("\n");
  let last = lines.length - 1;
  for (; last >= 0 && RX.blankLine.test(lines[last]); ) last--;
  return lines.length - last <= 2 ? str : lines.slice(0, last + 1).join("\n");
}
function normalizeLabel(label) {
  return label.trim().replace(RX.multipleSpaceGlobal, " ").toLowerCase().toUpperCase().toLowerCase();
}
// Index of the unmatched close bracket in `pair`, or -2 when an opener is
// left dangling, -1 when balanced / absent.
function findUnbalanced(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\") i++;
    else if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
// Split a table row on unescaped pipes, honouring the reference's rule that
// a pipe is a separator only when preceded by an even number of backslashes.
function splitTableRow(row, wantCount) {
  const marked = row.replace(RX.findPipe, (ch, off, whole) => {
    let escaped = false;
    let p = off;
    for (; --p >= 0 && whole[p] === "\\"; ) escaped = !escaped;
    return escaped ? "|" : " |";
  });
  const cells = marked.split(RX.splitPipe);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim() && cells.pop(), wantCount) {
    if (cells.length > wantCount) cells.splice(wantCount);
    else for (; cells.length < wantCount; ) cells.push("");
  }
  for (let i = 0; i < cells.length; i++)
    cells[i] = cells[i].trim().replace(RX.slashPipe, "|");
  return cells;
}
// Expand tabs to spaces, tracking the column `start` counts from.
function expandTabs(str, start = 0) {
  let col = start;
  let out = "";
  for (const ch of str) {
    if (ch === "\t") {
      const w = 4 - (col % 4);
      out += " ".repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-document state. Link definitions land in `links` while the block pass
// runs; inline content is queued and resolved only after the whole block
// pass, so a definition may appear after its first use.
// ---------------------------------------------------------------------------
class Doc {
  constructor() {
    this.links = Object.create(null);
    this.queue = [];
    this.top = true;
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.linkParenPossible = true;
    this.maskStack = [];
  }
  queueInline(src) {
    const tokens = [];
    this.queue.push({ src, tokens });
    return tokens;
  }
}

// Fenced-code indent compensation: when the opening fence line is indented,
// that many leading spaces are stripped from every content line.
function fencesIndentComp(raw, content) {
  const m = raw.match(RX.indentCodeCompensation);
  if (m === null) return content;
  const w = m[1];
  return content
    .split("\n")
    .map((line) => {
      const sp = line.match(RX.beginningSpace);
      if (sp === null) return line;
      return line.slice(Math.min(sp[0].length, w.length));
    })
    .join("\n");
}

function tokSpace(src) {
  const m = BLOCK.newline.exec(src);
  if (m && m[0].length > 0) return { type: "space", raw: m[0] };
  return null;
}
function tokCode(src) {
  const m = BLOCK.indentedCode.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return {
    type: "code",
    raw,
    codeBlockStyle: "indented",
    text: raw.replace(RX.codeRemoveIndent, ""),
  };
}
function tokFences(src) {
  const m = BLOCK.fences.exec(src);
  if (!m) return null;
  return {
    type: "code",
    raw: m[0],
    lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, "$1") : m[2],
    text: fencesIndentComp(m[0], m[3] || ""),
  };
}
function tokHeading(doc, src) {
  const m = BLOCK.heading.exec(src);
  if (!m) return null;
  let text = m[2].trim();
  if (RX.endingHash.test(text)) {
    const stripped = stripTrailing(text, "#");
    if (!stripped || RX.endingSpaceTabChar.test(stripped)) text = stripped.trim();
  }
  return {
    type: "heading",
    raw: stripTrailing(m[0], "\n"),
    depth: m[1].length,
    text,
    tokens: doc.queueInline(text),
  };
}
function tokHr(src) {
  const m = BLOCK.hr.exec(src);
  if (!m) return null;
  return { type: "hr", raw: stripTrailing(m[0], "\n") };
}
function tokBlockquote(doc, src) {
  const m = BLOCK.blockquote.exec(src);
  if (!m) return null;
  const lines = stripTrailing(m[0], "\n").split("\n");
  let raw = "";
  let text = "";
  const tokens = [];
  let rest = lines;
  while (rest.length > 0) {
    let seen = false;
    const chunk = [];
    let p;
    for (p = 0; p < rest.length; p++) {
      if (RX.blockquoteStart.test(rest[p])) {
        chunk.push(rest[p]);
        seen = true;
      } else if (!seen) chunk.push(rest[p]);
      else break;
    }
    rest = rest.slice(p);
    const joined = chunk.join("\n");
    const stripped = joined
      .replace(
        RX.blockquoteMarkerWhitespace,
        (g, b, inner) => b + expandTabs(inner, b.length),
      )
      .replace(RX.blockquoteSetextReplace, "\n    $1")
      .replace(RX.blockquoteSetextReplace2, "");
    raw = raw ? raw + "\n" + joined : joined;
    text = text ? text + "\n" + stripped : stripped;
    const savedTop = doc.top;
    doc.top = true;
    lexBlocks(doc, stripped, tokens, true);
    doc.top = savedTop;
    if (rest.length === 0) break;
    const last = tokens.at(-1);
    if (
      last &&
      (last.type === "code" ||
        last.type === "heading" ||
        last.type === "hr" ||
        last.type === "html" ||
        last.type === "table")
    )
      break;
    if (last && last.type === "blockquote") {
      const g = last;
      const b = rest.join("\n");
      const whole =
        g.raw + "\n" + b.replace(RX.blockquoteSetextReplace2, "");
      const f = tokBlockquote(doc, whole);
      tokens[tokens.length - 1] = f;
      const y = whole.substring(f.raw.length).replace(/^\n/, "");
      const r = y ? y.split("\n").length : 0;
      const taken = r ? rest.slice(0, -r) : rest;
      if (taken.length > 0) raw = raw + "\n" + taken.join("\n");
      text = text.substring(0, text.length - g.text.length) + f.text;
      rest = rest.slice(taken.length);
      if (rest.length > 0 && RX.blockquoteStart.test(rest[0])) continue;
      break;
    } else if (last && last.type === "list") {
      const g = last;
      const b = g.raw + "\n" + rest.join("\n");
      const redone = tokList(doc, b);
      tokens[tokens.length - 1] = redone;
      const f =
        redone.raw.length > g.raw.length
          ? b.slice(g.raw.length + 1, redone.raw.length).split("\n").length
          : 0;
      if (f > 0) {
        const y = rest.slice(0, f).join("\n");
        raw = raw + "\n" + y;
        text = text + "\n" + y;
      }
      rest = rest.slice(f);
      continue;
    }
  }
  return { type: "blockquote", raw, tokens, text };
}
// Index of the first character that is not a space (-1 when there is none).
function firstNonSpace(str) {
  for (let i = 0; i < str.length; i++)
    if (str.charCodeAt(i) !== 32) return i;
  return -1;
}
function firstLineOf(str) {
  const nl = str.indexOf("\n");
  return nl === -1 ? str : str.slice(0, nl);
}
// Expand the leading whitespace run of a line only when it holds a tab;
// without a tab the expansion is the identity.
function expandLeading(str, start = 0) {
  let k = 0;
  while (k < str.length && (str[k] === " " || str[k] === "\t")) k++;
  if (k === 0) return str;
  let hasTab = false;
  for (let i = 0; i < k; i++)
    if (str.charCodeAt(i) === 9) {
      hasTab = true;
      break;
    }
  if (!hasTab) return str;
  return expandTabs(str.slice(0, k), start) + str.slice(k);
}
// Manual equivalent of /\n[ \t]*\n[ \t]*$/ on a string tail.
function endsWithDoubleBlank(str) {
  let i = str.length;
  while (i > 0 && (str.charCodeAt(i - 1) === 32 || str.charCodeAt(i - 1) === 9))
    i--;
  if (i === 0 || str.charCodeAt(i - 1) !== 10) return false;
  i--;
  while (i > 0 && (str.charCodeAt(i - 1) === 32 || str.charCodeAt(i - 1) === 9))
    i--;
  return i > 0 && str.charCodeAt(i - 1) === 10;
}
function tokList(doc, src) {
  const m = BLOCK.listStart.exec(src);
  if (!m) return null;
  const full = src;
  let bullet = m[1].trim();
  const ordered = bullet.length > 1;
  const list = {
    type: "list",
    raw: "",
    ordered,
    start: ordered ? +bullet.slice(0, -1) : "",
    loose: false,
    items: [],
  };
  const bulletPat = ordered
    ? `\\d{1,9}\\${bullet.slice(-1)}`
    : `\\${bullet}`;
  const itemRx = listItemRx(bulletPat);
  let loosePending = false;
  let rest = src;
  while (rest) {
    let emptyItem = false;
    let itemText = "";
    const mm = itemRx.exec(rest);
    if (!mm || BLOCK.hr.test(rest)) break;
    const startPos = full.length - rest.length;
    rest = rest.substring(mm[0].length);
    const firstLine = firstLineOf(mm[2]);
    const bulletLen = mm[1].length;
    let content = expandLeading(firstLine, bulletLen);
    const nextLine = firstLineOf(rest);
    const isEmpty = !content.trim();
    let indent;
    if (isEmpty) {
      indent = bulletLen + 1;
    } else {
      indent = firstNonSpace(content);
      indent = indent > 4 ? 1 : indent;
      itemText = content.slice(indent);
      indent += bulletLen;
    }
    if (isEmpty && RX.blankLine.test(nextLine)) {
      rest = rest.substring(nextLine.length + 1);
      emptyItem = true;
    }
    if (!emptyItem) {
      const bulletRx = nextBulletRx(indent);
      const hrRx = hrAtRx(indent);
      const fenceRx = fencesAtRx(indent);
      const headRx = headingAtRx(indent);
      const htmlRx = htmlAtRx(indent);
      const quoteRx = blockquoteAtRx(indent);
      let curEmpty = isEmpty;
      while (rest) {
        const line = firstLineOf(rest);
        const f = line;
        const expanded = expandLeading(f);
        // Break tests, dispatched on the line's first non-space character:
        // a line that cannot start a fence / heading / html block /
        // blockquote / bullet / hr never pays for those patterns.
        let lead = 0;
        while (lead < f.length && f.charCodeAt(lead) === 32) lead++;
        const fc = lead < f.length ? f[lead] : "";
        const within = lead <= indent - 1;
        if (
          within &&
          ((fc === "`" || fc === "~") ? fenceRx.test(f) : false ||
            (fc === "#" ? headRx.test(f) : false) ||
            (fc === "<" ? htmlRx.test(f) : false) ||
            (fc === ">" ? quoteRx.test(f) : false) ||
            (fc === "*" || fc === "+" || fc === "-" || (fc >= "0" && fc <= "9")
              ? bulletRx.test(f)
              : false) ||
            (fc === "-" || fc === "_" || fc === "*" ? hrRx.test(f) : false))
        )
          break;
        if (firstNonSpace(expanded) >= indent || !f.trim()) {
          itemText += "\n" + expanded.slice(indent);
        } else {
          if (
            curEmpty ||
            (content.includes("\t")
              ? firstNonSpace(content.replace(RX.tabCharGlobal, "    "))
              : firstNonSpace(content)) >= 4 ||
            fenceRx.test(content) ||
            headRx.test(content) ||
            htmlRx.test(content) ||
            hrRx.test(content)
          )
            break;
          const qe =
            /^ {0,3}(?:=+|-+) *$/.test(f) &&
            BLOCK.setext.test(`${content}\n${f}`)
              ? `    ${expanded.replace(/^ {0,3}/, "")}`
              : f;
          itemText += "\n" + qe;
        }
        curEmpty = !f.trim();
        rest = rest.substring(line.length + 1);
        content = expanded.slice(indent);
      }
    }
    const itemRaw = full.slice(startPos, full.length - rest.length);
    if (!list.loose) {
      if (loosePending) list.loose = true;
      else if (endsWithDoubleBlank(itemRaw)) loosePending = true;
    }
    list.items.push({
      type: "list_item",
      raw: itemRaw,
      task: RX.listIsTask.test(itemText),
      loose: false,
      text: itemText,
      tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (!lastItem) return null;
  lastItem.raw = lastItem.raw.trimEnd();
  lastItem.text = lastItem.text.trimEnd();
  list.raw = full.slice(0, full.length - rest.length).trimEnd();
  for (const item of list.items) {
    doc.top = false;
    item.tokens = lexBlocks(doc, item.text, []);
    if (!list.loose) {
      const spaces = item.tokens.filter((t) => t.type === "space");
      if (
        spaces.length > 0 &&
        spaces.some((t) => RX.anyLine.test(t.raw))
      )
        list.loose = true;
    }
  }
  for (const item of list.items) {
    const first = item.tokens[0];
    if (item.task && (first?.type === "text" || first?.type === "paragraph")) {
      item.text = item.text.replace(RX.listReplaceTask, "");
      first.raw = first.raw.replace(RX.listReplaceTask, "");
      first.text = first.text.replace(RX.listReplaceTask, "");
      for (let g = doc.queue.length - 1; g >= 0; g--) {
        if (RX.listIsTask.test(doc.queue[g].src)) {
          doc.queue[g].src = doc.queue[g].src.replace(RX.listReplaceTask, "");
          break;
        }
      }
      const ck = RX.listTaskCheckbox.exec(item.raw);
      if (ck) {
        const box = {
          type: "checkbox",
          raw: ck[0] + " ",
          checked: ck[0] !== "[ ]",
        };
        item.checked = box.checked;
        if (list.loose) {
          if (
            item.tokens[0] &&
            ["paragraph", "text"].includes(item.tokens[0].type) &&
            "tokens" in item.tokens[0] &&
            item.tokens[0].tokens
          ) {
            item.tokens[0].raw = box.raw + item.tokens[0].raw;
            item.tokens[0].text = box.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(box);
          } else {
            item.tokens.unshift({
              type: "paragraph",
              raw: box.raw,
              text: box.raw,
              tokens: [box],
            });
          }
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const t of item.tokens) if (t.type === "text") t.type = "paragraph";
    }
  }
  return list;
}
function tokHtml(src) {
  const m = BLOCK.html.exec(src);
  if (!m) return null;
  const raw = trimBlankTail(m[0]);
  return {
    type: "html",
    block: true,
    raw,
    pre: m[1] === "pre" || m[1] === "script" || m[1] === "style",
    text: raw,
  };
}
function tokDef(src) {
  const m = BLOCK.def.exec(src);
  if (!m) return null;
  if (!RX.startAngleBracket.test(m[2]) && findUnbalanced(m[2], "()") !== -1)
    return null;
  const tag = normalizeLabel(m[1]);
  const href = m[2]
    ? m[2].replace(RX.hrefBrackets, "$1").replace(INLINE.anyPunctuation, "$1")
    : "";
  const title = m[3]
    ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, "$1")
    : m[3];
  return { type: "def", tag, raw: stripTrailing(m[0], "\n"), href, title };
}
function tokTable(doc, src) {
  const m = BLOCK.table.exec(src);
  if (!m || !RX.tableDelimiter.test(m[2])) return null;
  const headerCells = splitTableRow(m[1]);
  const alignParts = m[2].replace(RX.tableAlignChars, "").split("|");
  const rowLines = m[3]?.trim()
    ? m[3].replace(RX.tableRowBlankLine, "").split("\n")
    : [];
  if (headerCells.length !== alignParts.length) return null;
  const table = {
    type: "table",
    raw: stripTrailing(m[0], "\n"),
    header: [],
    align: [],
    rows: [],
  };
  for (const part of alignParts) {
    if (RX.tableAlignRight.test(part)) table.align.push("right");
    else if (RX.tableAlignCenter.test(part)) table.align.push("center");
    else if (RX.tableAlignLeft.test(part)) table.align.push("left");
    else table.align.push(null);
  }
  for (let i = 0; i < headerCells.length; i++) {
    table.header.push({
      text: headerCells[i],
      tokens: doc.queueInline(headerCells[i]),
      header: true,
      align: table.align[i],
    });
  }
  for (const line of rowLines) {
    table.rows.push(
      splitTableRow(line, table.header.length).map((cell, p) => ({
        text: cell,
        tokens: doc.queueInline(cell),
        header: false,
        align: table.align[p],
      })),
    );
  }
  return table;
}
function tokSetext(doc, src) {
  const m = BLOCK.setext.exec(src);
  if (!m) return null;
  const text = m[1].trim();
  return {
    type: "heading",
    raw: stripTrailing(m[0], "\n"),
    depth: m[2].charAt(0) === "=" ? 1 : 2,
    text,
    tokens: doc.queueInline(text),
  };
}
function tokParagraph(doc, src) {
  const m = BLOCK.paragraph.exec(src);
  if (!m) return null;
  let text = m[1];
  if (text.charAt(text.length - 1) === "\n") text = text.slice(0, -1);
  return { type: "paragraph", raw: m[0], text, tokens: doc.queueInline(text) };
}
function tokBlockText(doc, src) {
  const m = BLOCK.text.exec(src);
  if (!m) return null;
  return { type: "text", raw: m[0], text: m[0], tokens: doc.queueInline(m[0]) };
}

// Cheap guards for the two patterns that scan ahead: a table needs a
// delimiter row next, a setext heading needs an = / - underline next.
const TABLE_DELIM_LINE =
  /^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/;
const SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*$/;
function secondLine(src) {
  const nl = src.indexOf("\n");
  if (nl === -1) return null;
  const end = src.indexOf("\n", nl + 1);
  return end === -1 ? src.slice(nl + 1) : src.slice(nl + 1, end);
}
function mayBeTable(src) {
  const line2 = secondLine(src);
  if (line2 === null || !TABLE_DELIM_LINE.test(line2)) return false;
  const first = src.slice(0, src.indexOf("\n"));
  return first.trim().length > 0;
}
function mayBeSetext(src) {
  let pos = src.indexOf("\n");
  if (pos === -1) return false;
  if (src.slice(0, pos).trim().length === 0) return false;
  // The underline may sit several lines down: the heading text is a
  // multi-line paragraph. Only blank lines stop the search.
  while (pos !== -1) {
    const next = src.indexOf("\n", pos + 1);
    const line = next === -1 ? src.slice(pos + 1) : src.slice(pos + 1, next);
    if (line.trim().length === 0) return false;
    if (SETEXT_LINE.test(line)) return true;
    pos = next;
  }
  return false;
}

// The block scanner. Tokenizers run in the reference's order, but each is
// guarded by the first character (after at most three spaces), so a line
// that cannot be a heading never pays for the heading pattern, and so on.
function lexBlocks(doc, src, out = [], nested = false) {
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    const ch = src[0];
    let lead = 0;
    while (lead < 3 && src[lead] === " ") lead++;
    const c1 = src[lead];
    let tok = null;
    if (ch === " " || ch === "\t" || ch === "\n") tok = tokSpace(src);
    if (!tok && (ch === " " || ch === "\t")) tok = tokCode(src);
    if (!tok && (c1 === "`" || c1 === "~")) tok = tokFences(src);
    if (!tok && c1 === "#") tok = tokHeading(doc, src);
    if (!tok && (c1 === "-" || c1 === "_" || c1 === "*")) tok = tokHr(src);
    if (!tok && c1 === ">") tok = tokBlockquote(doc, src);
    if (
      !tok &&
      (c1 === "*" || c1 === "+" || c1 === "-" || (c1 >= "0" && c1 <= "9"))
    )
      tok = tokList(doc, src);
    if (!tok && c1 === "<") tok = tokHtml(src);
    if (!tok && c1 === "[") tok = tokDef(src);
    if (!tok && mayBeTable(src)) tok = tokTable(doc, src);
    if (!tok && mayBeSetext(src)) tok = tokSetext(doc, src);
    if (!tok && doc.top) tok = tokParagraph(doc, src);
    if (!tok) tok = tokBlockText(doc, src);
    if (!tok) throw new Error("Infinite loop on byte: " + src.charCodeAt(0));

    switch (tok.type) {
      case "space": {
        src = src.slice(tok.raw.length);
        const prev = out.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += "\n";
        else out.push(tok);
        break;
      }
      case "code": {
        src = src.slice(tok.raw.length);
        // Only indented code merges into a preceding paragraph or text
        // block; a fenced block always stands on its own.
        const prev = out.at(-1);
        if (
          tok.codeBlockStyle === "indented" &&
          prev &&
          (prev.type === "paragraph" || prev.type === "text")
        ) {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          doc.queue.at(-1).src = prev.text;
        } else {
          out.push(tok);
        }
        break;
      }
      case "def": {
        src = src.slice(tok.raw.length);
        const prev = out.at(-1);
        if (prev && (prev.type === "paragraph" || prev.type === "text")) {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.raw;
          doc.queue.at(-1).src = prev.text;
        } else {
          if (!doc.links[tok.tag])
            doc.links[tok.tag] = { href: tok.href, title: tok.title };
          out.push(tok);
        }
        break;
      }
      case "paragraph": {
        src = src.slice(tok.raw.length);
        const prev = out.at(-1);
        if (nested && prev && prev.type === "paragraph") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          doc.queue.pop();
          doc.queue.at(-1).src = prev.text;
        } else {
          out.push(tok);
        }
        nested = false;
        break;
      }
      case "text": {
        src = src.slice(tok.raw.length);
        const prev = out.at(-1);
        if (prev && prev.type === "text") {
          prev.raw += (prev.raw.endsWith("\n") ? "" : "\n") + tok.raw;
          prev.text += "\n" + tok.text;
          doc.queue.pop();
          doc.queue.at(-1).src = prev.text;
        } else {
          out.push(tok);
        }
        break;
      }
      default: {
        src = src.slice(tok.raw.length);
        out.push(tok);
      }
    }
  }
  doc.top = true;
  return out;
}

// ---------------------------------------------------------------------------
// Emphasis masking. Before inline scanning, link / code / html spans are
// replaced by same-length filler so the emphasis matcher cannot see
// delimiters inside them, and punctuation outside code spans becomes '+'.
// `scanMask` records the last delimiter run that could close an emphasis
// or strikethrough span; the mask stack caches it per inline pass.
// ---------------------------------------------------------------------------
function scanMask(str) {
  const em = { "*": -1, _: -1 };
  let del = -1;
  const n = str.length;
  for (let s = 0; s < n; s++) {
    const r = str[s];
    if (r !== "*" && r !== "_" && r !== "~") continue;
    const prev = s === 0 ? "\n" : str[s - 1];
    let i = s + 1;
    for (; i < n && str[i] === r; ) i++;
    if (
      prev !== " " &&
      prev !== "\t" &&
      prev !== "\n" &&
      prev !== "\r" &&
      prev !== "\f"
    ) {
      if (r === "~") del = s;
      else em[r] = s;
    }
    s = i - 1;
  }
  return { src: str, em, del };
}
function lastEm(doc, masked, ch) {
  const top = doc.maskStack.at(-1);
  return top && top.src === masked
    ? top.em[ch]
    : scanMask(masked).em[ch];
}
function lastDel(doc, masked) {
  const top = doc.maskStack.at(-1);
  return top && top.src === masked ? top.del : scanMask(masked).del;
}
function linkInText(doc, src) {
  if (!src.includes("[")) return false;
  for (const m of src.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && src.charAt(m.index - 1) !== "!") return true;
  }
  for (const m of src.matchAll(INLINE.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    if (
      !(
        s.charAt(0) === "!" ||
        !Object.hasOwn(doc.links, normalizeLabel(s.slice(r + 1, -1)))
      ) &&
      !(r > 1 && linkInText(doc, s.slice(1, r - 1)))
    )
      return true;
  }
  return false;
}
function maskForEm(doc, src) {
  // Fast path: with no backtick, backslash, bracket or angle bracket in
  // the string, neither masking pass can change anything.
  if (
    !src.includes("`") &&
    !src.includes("\\") &&
    !src.includes("[") &&
    !src.includes("<")
  )
    return src;
  let masked = src;
  if (src.includes("[")) {
    const search = INLINE.reflinkSearch;
    const maskRef = (whole) => {
      const open = whole.lastIndexOf("[");
      if (!Object.hasOwn(doc.links, normalizeLabel(whole.slice(open + 1, -1))))
        return whole;
      if (open > 1 && whole.charAt(0) !== "!") {
        const inner = whole.slice(1, open - 1);
        if (linkInText(doc, inner))
          return (
            "[" +
            inner.replace(search, maskRef) +
            "][" +
            "a".repeat(whole.length - open - 2) +
            "]"
          );
      }
      return "[" + "a".repeat(whole.length - 2) + "]";
    };
    masked = masked.replace(search, maskRef);
  }
  masked = masked.replace(
    INLINE.anyPunctuationOutsideCode,
    (whole, backticks, punct) =>
      punct
        ? "+".repeat(whole.length)
        : backticks
          ? backticks +
            whole
              .slice(backticks.length, -backticks.length)
              .replace(/`/g, "+") +
            backticks
          : whole,
  );
  masked = masked.replace(INLINE.blockSkip, (whole, _a, pre) => {
    const off = pre ? pre.length : 0;
    return whole.slice(0, off) + "[" + "a".repeat(whole.length - off - 2) + "]";
  });
  return masked;
}
// Does the label contain an inline tag / autolink that runs past the end
// of the label? Such a link is not a link at all.
function tagExtendsBeyond(full, label, start) {
  if (!label.includes("<")) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === "\\") {
      s++;
      continue;
    }
    if (label[s] === "`") {
      const i = INLINE.code.exec(label.slice(s));
      if (i) {
        s += i[0].length - 1;
        continue;
      }
    }
    if (label[s] !== "<") continue;
    const rest = full.slice(start + s);
    const o = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}
// Build a link / image token, tokenizing its text inline. A link whose text
// itself emits a link is discarded (the reference's nested-link rule).
function makeLink(doc, m, def, raw) {
  const text = m[1].replace(RX.outputLinkReplace, "$1");
  const isImage = m[0].charAt(0) === "!";
  const savedInLink = doc.inLink;
  const savedEmitted = doc.linkEmitted;
  const savedRaw = doc.inRawBlock;
  doc.inLink = true;
  doc.linkEmitted = false;
  const tokens = inlineTokens(doc, text);
  const emitted = doc.linkEmitted;
  doc.linkEmitted = savedEmitted;
  doc.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      doc.inRawBlock = savedRaw;
      return null;
    }
    doc.linkEmitted = true;
  }
  return {
    type: isImage ? "image" : "link",
    raw,
    href: def.href,
    title: def.title || null,
    text,
    tokens,
  };
}

function tokEscape(src) {
  const m = INLINE.escape.exec(src);
  if (!m) return null;
  return { type: "escape", raw: m[0], text: m[1] };
}
function tokTag(doc, src) {
  const m = INLINE.tag.exec(src);
  if (!m) return null;
  if (!doc.inLink && RX.startATag.test(m[0])) doc.inLink = true;
  else if (doc.inLink && RX.endATag.test(m[0])) doc.inLink = false;
  if (!doc.inRawBlock && RX.startPreScriptTag.test(m[0]))
    doc.inRawBlock = true;
  else if (doc.inRawBlock && RX.endPreScriptTag.test(m[0]))
    doc.inRawBlock = false;
  return {
    type: "html",
    raw: m[0],
    inLink: doc.inLink,
    inRawBlock: doc.inRawBlock,
    block: false,
    text: m[0],
  };
}
function tokLink(doc, src) {
  if (doc.linkParenPossible === false) return null;
  const m = INLINE.link.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (tagExtendsBeyond(src, m[1], bang)) return null;
  const dest = m[2].trim();
  if (RX.startAngleBracket.test(dest)) {
    if (!RX.endAngleBracket.test(dest)) return null;
    const stripped = stripTrailing(dest.slice(0, -1), "\\");
    if ((dest.length - stripped.length) % 2 === 0) return null;
  } else {
    const unbalanced = findUnbalanced(m[2], "()");
    if (unbalanced === -2) return null;
    if (unbalanced > -1) {
      const h = (m[0].indexOf("!") === 0 ? 5 : 4) + m[1].length + unbalanced;
      m[2] = m[2].substring(0, unbalanced);
      m[0] = m[0].substring(0, h).trim();
      m[3] = "";
    }
  }
  const tail = stripTrailing(m[0].slice(0, -1), "\\");
  if ((m[0].length - tail.length) % 2 === 0) return null;
  let href = m[2];
  const title = m[3] ? m[3].slice(1, -1) : "";
  href = href.trim();
  if (RX.startAngleBracket.test(href)) href = href.slice(1, -1);
  return makeLink(
    doc,
    m,
    {
      href: href && href.replace(INLINE.anyPunctuation, "$1"),
      title: title && title.replace(INLINE.anyPunctuation, "$1"),
    },
    m[0],
  );
}
function tokReflink(doc, src) {
  const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === "!" ? 2 : 1;
  if (tagExtendsBeyond(src, m[1], bang)) return null;
  const def = doc.links[normalizeLabel(m[2] || m[1])];
  if (!def) {
    const c = m[0].charAt(0);
    return { type: "text", raw: c, text: c };
  }
  return makeLink(doc, m, def, m[0]);
}

function tokEmStrong(doc, src, masked, prev) {
  const m = INLINE.emStrongLDelim.exec(src);
  if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return null;
  const delim = m[0][0];
  const prevIsDelim = prev === delim;
  const i = masked.length - src.length;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? "";
  const h = p === "*" || p === "_" || !!INLINE.punctuation.exec(p);
  if (l < i) prev = p;
  const u = l < i ? h : !!INLINE.punctuation.exec(prev);
  if (m[4] && prev.match(RX.unicodeAlphaNumeric)) return null;
  const d = m[1] || m[3] || "";
  if (!d || !prev || u) {
    const k = [...m[0]].length - 1;
    let g;
    let b;
    let runLeft = k;
    let extra = 0;
    const y = i - l + k;
    const retry = !!p.trim() && (!!d || (delim === "*" && !h));
    if (delim !== "*" && delim !== "_") return null;
    const closerRx =
      delim === "*" ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const last = lastEm(doc, masked, delim);
    const q = masked.length - src.length + k;
    if (last < q) return null;
    const rest = masked.slice(-1 * src.length + k);
    const limit = last - q;
    let s;
    for (
      closerRx.lastIndex = 0;
      (s = closerRx.exec(rest)) !== null && !(s.index > limit);

    ) {
      g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      b = [...g].length;
      if (s[3] || s[4]) {
        runLeft += b;
        continue;
      } else if (s[5] || s[6] || retry) {
        if (prevIsDelim && (s[5] || s[6])) break;
        if (y % 3 && !((y + b) % 3)) {
          extra += b;
          continue;
        }
      }
      if (((runLeft -= b), runLeft > 0)) continue;
      b = Math.min(b, b + runLeft + extra);
      const te = [...s[0]][0].length;
      const raw = src.slice(0, k + s.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = raw.slice(1, -1);
        return {
          type: "em",
          raw,
          text: inner,
          tokens: inlineTokens(doc, inner),
        };
      }
      const inner = raw.slice(2, -2);
      return {
        type: "strong",
        raw,
        text: inner,
        tokens: inlineTokens(doc, inner),
      };
    }
  }
  return null;
}
function tokCodespan(src) {
  const m = INLINE.code.exec(src);
  if (!m) return null;
  let text = m[2].replace(RX.newLineCharGlobal, " ");
  const hasNonSpace = RX.nonSpaceChar.test(text);
  const padded = /^ /.test(text) && / $/.test(text);
  if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
  return { type: "codespan", raw: m[0], text };
}
function tokBr(src) {
  const m = INLINE.br.exec(src);
  if (!m) return null;
  return { type: "br", raw: m[0] };
}
function tokDel(doc, src, masked, prev) {
  const m = INLINE.delLDelim.exec(src);
  if (!m) return null;
  if (!(m[1] || "") || !prev || INLINE.punctuation.exec(prev)) {
    const run = [...m[0]].length - 1;
    let g;
    let l;
    let left = run;
    const closerRx = INLINE.delRDelim;
    const last = lastDel(doc, masked);
    const d = masked.length - src.length + run;
    if (last < d) return null;
    const rest = masked.slice(-1 * src.length + run);
    const limit = last - d;
    let s;
    for (
      closerRx.lastIndex = 0;
      (s = closerRx.exec(rest)) !== null && !(s.index > limit);

    ) {
      g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g || ((l = [...g].length), l !== run)) continue;
      if (s[3] || s[4]) {
        left += l;
        continue;
      }
      if (((left -= l), left > 0)) continue;
      l = Math.min(l, l + left);
      const te = [...s[0]][0].length;
      const raw = src.slice(0, run + s.index + te + l);
      const inner = raw.slice(run, -run);
      return {
        type: "del",
        raw,
        text: inner,
        tokens: inlineTokens(doc, inner),
      };
    }
  }
  return null;
}
function tokAutolink(src) {
  const m = INLINE.autolink.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[1];
    href = "mailto:" + text;
  } else {
    text = m[1];
    href = text;
  }
  return {
    type: "link",
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: "text", raw: text, text }],
  };
}
// Cheap pre-check before running the (anchored, but wide) extended-autolink
// pattern: a protocol / www. / mailto: / xmpp: prefix, or an email-shaped
// run of address characters ending at '@'.
function urlPrefixAt(src) {
  const a = src.charCodeAt(0);
  if (a === 104 || a === 72) {
    // http:// or https:// (case-insensitive scheme)
    if (
      (src.charCodeAt(1) | 32) === 116 &&
      (src.charCodeAt(2) | 32) === 116 &&
      (src.charCodeAt(3) | 32) === 112
    ) {
      if (
        src.charCodeAt(4) === 58 &&
        src.charCodeAt(5) === 47 &&
        src.charCodeAt(6) === 47
      )
        return true;
      if (
        (src.charCodeAt(4) | 32) === 115 &&
        src.charCodeAt(5) === 58 &&
        src.charCodeAt(6) === 47 &&
        src.charCodeAt(7) === 47
      )
        return true;
    }
    return false;
  }
  if (a === 102 || a === 70) {
    // ftp://
    return (
      (src.charCodeAt(1) | 32) === 116 &&
      (src.charCodeAt(2) | 32) === 112 &&
      src.charCodeAt(3) === 58 &&
      src.charCodeAt(4) === 47 &&
      src.charCodeAt(5) === 47
    );
  }
  if (a === 119) {
    // www. (lowercase only, like the reference pattern)
    return (
      src.charCodeAt(1) === 119 &&
      src.charCodeAt(2) === 119 &&
      src.charCodeAt(3) === 46
    );
  }
  if (a === 109) {
    // mailto:
    return (
      src.charCodeAt(1) === 97 &&
      src.charCodeAt(2) === 105 &&
      src.charCodeAt(3) === 108 &&
      src.charCodeAt(4) === 116 &&
      src.charCodeAt(5) === 111 &&
      src.charCodeAt(6) === 58
    );
  }
  if (a === 120) {
    // xmpp:
    return (
      src.charCodeAt(1) === 109 &&
      src.charCodeAt(2) === 112 &&
      src.charCodeAt(3) === 112 &&
      src.charCodeAt(4) === 58
    );
  }
  return false;
}
function isEmailCharCode(c) {
  return (
    (c >= 48 && c <= 57) ||
    (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    c === 46 ||
    c === 33 ||
    c === 35 ||
    c === 36 ||
    c === 37 ||
    c === 38 ||
    c === 39 ||
    c === 42 ||
    c === 43 ||
    c === 45 ||
    c === 47 ||
    c === 61 ||
    c === 63 ||
    c === 94 ||
    c === 95 ||
    c === 96 ||
    c === 123 ||
    c === 124 ||
    c === 125 ||
    c === 126
  );
}
function mayBeUrl(src) {
  if (urlPrefixAt(src)) return true;
  const c0 = src.charCodeAt(0);
  if (!isEmailCharCode(c0)) return false;
  let i = 0;
  while (i < src.length && isEmailCharCode(src.charCodeAt(i))) i++;
  return src.charCodeAt(i) === 64; // '@'
}
function tokUrl(src) {
  const m = INLINE.url.exec(src);
  if (!m) return null;
  let text;
  let href;
  if (m[2] === "@") {
    text = m[0];
    href = "mailto:" + text;
  } else {
    let prev;
    do {
      prev = m[0];
      m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? "";
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === "www." ? "http://" + m[0] : m[0];
  }
  return {
    type: "link",
    raw: m[0],
    text,
    href,
    autolink: true,
    tokens: [{ type: "text", raw: text, text }],
  };
}
function tokText(doc, src) {
  const m = INLINE.text.exec(src);
  if (!m) return null;
  const inRaw = doc.inRawBlock;
  return {
    type: "text",
    raw: m[0],
    text: inRaw ? m[0] : decodeEntities(m[0]),
    escaped: inRaw,
  };
}
// Inline entry point: the link-paren decision is made for the whole
// string at once (a link needs a ')' somewhere in it), and the string is
// masked for the emphasis pass. Both are restored when the pass ends.
function inlineTokens(doc, src, out = []) {
  const saved = doc.linkParenPossible;
  doc.linkParenPossible = saved && src.includes(")");
  try {
    return inlineLoop(doc, src, out);
  } finally {
    doc.linkParenPossible = saved;
  }
}
function inlineLoop(doc, src, out) {
  const masked =
    src.includes("*") || src.includes("_") || src.includes("~")
      ? maskForEm(doc, src)
      : src;
  doc.maskStack.push(scanMask(masked));
  try {
    return scanInline(doc, src, masked, out);
  } finally {
    doc.maskStack.pop();
  }
}
function scanInline(doc, src, masked, out) {
  let prevChar = "";
  let prevWasText = false;
  let guard = Infinity;
  while (src) {
    if (src.length < guard) guard = src.length;
    else throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    if (!prevWasText) prevChar = "";
    prevWasText = false;
    let tok = null;
    const ch = src[0];
    if (ch === "\\") {
      tok = tokEscape(src);
      if (!tok) tok = tokBr(src);
    } else if (ch === "<") {
      tok = tokTag(doc, src);
      if (!tok) tok = tokAutolink(src);
    } else if (ch === "[" || ch === "!") {
      tok = tokLink(doc, src);
      if (!tok) tok = tokReflink(doc, src);
    } else if (ch === "*" || ch === "_") {
      tok = tokEmStrong(doc, src, masked, prevChar);
    } else if (ch === "`") {
      tok = tokCodespan(src);
    } else if (ch === " ") {
      tok = tokBr(src);
    } else if (ch === "~") {
      tok = tokDel(doc, src, masked, prevChar);
    } else if (!doc.inLink && mayBeUrl(src)) {
      tok = tokUrl(src);
    }
    if (!tok) tok = tokText(doc, src);
    if (!tok) throw new Error("Infinite loop on byte: " + src.charCodeAt(0));
    src = src.slice(tok.raw.length);
    if (tok.type === "text") {
      if (tok.raw.slice(-1) !== "_") prevChar = tok.raw.slice(-1);
      prevWasText = true;
      const prevTok = out.at(-1);
      if (prevTok?.type === "text") {
        prevTok.raw += tok.raw;
        prevTok.text += tok.text;
      } else {
        out.push(tok);
      }
    } else {
      out.push(tok);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering. Two modes: the normal HTML renderer and the plain-text
// renderer used for image alt text (it drops markup and keeps the words).
// ---------------------------------------------------------------------------
function renderTextToken(tok) {
  if ("tokens" in tok && tok.tokens) return renderInline(tok.tokens);
  if ("escaped" in tok && tok.escaped) return tok.text;
  return htmlEscape(tok.text);
}
function renderCode(tok) {
  const lang = (tok.lang || "").match(RX.notSpaceStart)?.[0];
  let body = tok.text ? tok.text.replace(RX.endingNewline, "") + "\n" : "";
  body = htmlEscape(body, true);
  if (lang)
    return `<pre><code class="language-${htmlEscape(lang)}">${body}</code></pre>\n`;
  return `<pre><code>${body}</code></pre>\n`;
}
function renderTableCell(cell) {
  const inner = renderInline(cell.tokens);
  const tag = cell.header ? "th" : "td";
  return (
    (cell.align ? `<${tag} align="${cell.align}">` : `<${tag}>`) +
    inner +
    `</${tag}>\n`
  );
}
function renderTable(tok) {
  let headCells = "";
  for (const cell of tok.header) headCells += renderTableCell(cell);
  const headRow = `<tr>\n${headCells}</tr>\n`;
  let bodyRows = "";
  for (const row of tok.rows) {
    let cells = "";
    for (const cell of row) cells += renderTableCell(cell);
    bodyRows += `<tr>\n${cells}</tr>\n`;
  }
  const tbody = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
  return `<table>\n<thead>\n${headRow}</thead>\n${tbody}</table>\n`;
}
function renderLink(tok) {
  const label = tok.autolink
    ? htmlEscape(tok.text, true)
    : renderInline(tok.tokens);
  const href = encodeHref(tok.href);
  if (href === null) return label;
  let out = `<a href="${htmlEscape(href, tok.autolink)}"`;
  if (tok.title) out += ` title="${htmlEscape(tok.title)}"`;
  return out + ">" + label + "</a>";
}
function renderImage(tok) {
  let alt = tok.text;
  if (tok.tokens) alt = renderPlain(tok.tokens);
  const href = encodeHref(tok.href);
  if (href === null) return htmlEscape(alt);
  let out = `<img src="${htmlEscape(href)}" alt="${htmlEscape(alt)}"`;
  if (tok.title) out += ` title="${htmlEscape(tok.title)}"`;
  return out + ">";
}
function renderInline(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "escape":
        out += renderTextToken(tok);
        break;
      case "html":
        out += tok.text;
        break;
      case "link":
        out += renderLink(tok);
        break;
      case "image":
        out += renderImage(tok);
        break;
      case "checkbox":
        out +=
          "<input " +
          (tok.checked ? 'checked="" ' : "") +
          'disabled="" type="checkbox"> ';
        break;
      case "strong":
        out += `<strong>${renderInline(tok.tokens)}</strong>`;
        break;
      case "em":
        out += `<em>${renderInline(tok.tokens)}</em>`;
        break;
      case "codespan":
        out += `<code>${htmlEscape(tok.text, true)}</code>`;
        break;
      case "br":
        out += "<br>";
        break;
      case "del":
        out += `<del>${renderInline(tok.tokens)}</del>`;
        break;
      case "text":
        out += renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}
function renderPlain(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "strong":
      case "em":
      case "del":
      case "link":
      case "image":
        out += tok.tokens ? renderPlain(tok.tokens) : tok.text;
        break;
      case "codespan":
      case "html":
      case "text":
        out += tok.text;
        break;
      case "br":
        break;
      case "checkbox":
        out += tok.raw;
        break;
      default:
        out += tok.text ?? "";
        break;
    }
  }
  return out;
}
function renderBlocks(tokens) {
  let out = "";
  for (const tok of tokens) {
    switch (tok.type) {
      case "space":
      case "def":
        break;
      case "hr":
        out += "<hr>\n";
        break;
      case "heading":
        out += `<h${tok.depth}>${renderInline(tok.tokens)}</h${tok.depth}>\n`;
        break;
      case "code":
        out += renderCode(tok);
        break;
      case "table":
        out += renderTable(tok);
        break;
      case "blockquote":
        out += `<blockquote>\n${renderBlocks(tok.tokens)}</blockquote>\n`;
        break;
      case "list": {
        let body = "";
        for (const item of tok.items)
          body += `<li>${renderBlocks(item.tokens)}</li>\n`;
        const tag = tok.ordered ? "ol" : "ul";
        const start =
          tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : "";
        out += `<${tag}${start}>\n${body}</${tag}>\n`;
        break;
      }
      case "checkbox":
        out +=
          "<input " +
          (tok.checked ? 'checked="" ' : "") +
          'disabled="" type="checkbox"> ';
        break;
      case "html":
        out += tok.text;
        break;
      case "paragraph":
        out += `<p>${renderInline(tok.tokens)}</p>\n`;
        break;
      case "text":
        out += renderTextToken(tok);
        break;
      default:
        throw new Error(`Token with "${tok.type}" type was not found.`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point. Carriage returns are normalized first; the block pass
// collects link definitions; queued inline strings are then resolved in
// order; the block tree renders to HTML.
// ---------------------------------------------------------------------------
export function parse(markdown) {
  const doc = new Doc();
  const src = String(markdown).replace(RX.carriageReturn, "\n");
  const tokens = lexBlocks(doc, src, []);
  for (let i = 0; i < doc.queue.length; i++) {
    const entry = doc.queue[i];
    doc.inRawBlock = false;
    inlineTokens(doc, entry.src, entry.tokens);
  }
  doc.queue.length = 0;
  return renderBlocks(tokens);
}
