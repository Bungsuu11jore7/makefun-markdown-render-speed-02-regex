// Fast drop-in for marked 18.1.3 (default options, GFM on): parse(markdown)
// returns exactly the HTML marked renders, byte for byte.
//
// Design (regex / state-machine hybrid, tuned for speed):
//  - All regexes are compiled once at module load; none is created per parse.
//  - Block and inline parsing render straight to strings: no token objects,
//    no renderer dispatch, no per-node allocation beyond the block tree.
//  - A document pre-scan decides which heavy paths can be skipped entirely
//    (no table => no table regexes, no '[' => no link machinery, ...).
//  - Inline scanning dispatches on the first character, so plain text runs
//    through a single anchored text match instead of ten failed regexes.
//  - The emphasis machinery masks links / code / escapes exactly like
//    marked does, so CommonMark rules 9-10 and mid-run openers agree.
//
// This file is an original implementation of the CommonMark 0.31.2 + GFM
// 0.29 rules as marked 18.1.3 applies them (where marked departs from the
// spec, marked wins). SPDX-License-Identifier: MIT

// ---------- regex construction ----------
const rx = (s, f) => new RegExp(s, f);
const NOOP = { exec: () => null };

const _tag = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const _comment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const _bullet = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const _hrSrc = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const _headingSrc = ' {0,3}#{1,6}(?:\\s|$)';

const O = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
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
  setextLine: /\n {0,3}[=-]/,
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
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => {
    const c = O._liCache || (O._liCache = new Map());
    let r = c.get(bull);
    if (!r) { r = rx(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`); c.set(bull, r); }
    return r;
  },
  _indCache: null,
  _indRegex(kind, indent, make) {
    const idx = Math.max(0, Math.min(3, indent - 1));
    const c = O._indCache || (O._indCache = {});
    const k = kind + idx;
    return c[k] || (c[k] = make(idx));
  },
  nextBulletRegex: (indent) => O._indRegex('nb', indent, (i) => rx(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: (indent) => O._indRegex('hr', indent, (i) => rx(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: (indent) => O._indRegex('fe', indent, (i) => rx(`^ {0,${i}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: (indent) => O._indRegex('he', indent, (i) => rx(`^ {0,${i}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: (indent) => O._indRegex('ht', indent, (i) => rx(`^ {0,${i}}(?:</?(?:${_tag})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: (indent) => O._indRegex('bq', indent, (i) => rx(`^ {0,${i}}>`)),
};

// ---------- block grammar ----------
const B = {};
B.newline = /^(?:[ \t]*(?:\n|$))+/;
B.code = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
B.fences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
B.hr = rx(_hrSrc);
B.heading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
B.list = rx(`^((?: {0,3}(?:[*+-]|\\d{1,9}[.)])))([ \\t][^\\n]*?)?(?:\\n|$)`);
// lheading: text that may not start a block, then a = / - underline.
// The hr alternative here is non-capturing on purpose: the underline must
// stay group 2 (the text is group 1).
const _lhBull = ' {0,3}(?:[*+-]|\\d{1,9}[.)]) ';
const _lhCode = '(?: {4}| {0,3}\\t)';
const _lhFences = ' {0,3}(?:`{3,}|~{3,})';
const _lhBq = ' {0,3}>';
const _lhHead = ' {0,3}#{1,6}(?:\\s|$)';
const _lhHr = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const _lhHtml = ' {0,3}<[^\\n>]+>\\n';
const _lhTable = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
function makeLheading(withTable) {
  const tbl = withTable ? '|' + _lhTable : '';
  const start = '^(?!' + [_lhBull, _lhCode, _lhFences, _lhBq, _lhHead, _lhHtml].join('|') + tbl + ')';
  const inner = '\\n(?!\\s*?\\n|' + [_lhBull, _lhFences, _lhBq, _lhHead, _lhHr, _lhHtml].join('|') + tbl + ')';
  return rx(start + '((?:.|' + inner + ')+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)');
}
B.lheading = makeLheading(false);
B.lheadingGfm = makeLheading(true);
B.paragraph = null; // built below (needs table + list interrupt variants)
B.text = /^[^\n]+/;

const _blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const _titlePat = String.raw`(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))`;
B.def = rx('^ {0,3}\\[(' + _blockLabel.source + ')\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)(' + _titlePat + '))? *(?:\\n+|$)');

B.html = rx('^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|' + _comment.source + '[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(' + _tag + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i');

const _gfmTable = '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|' + _hrSrc.slice(1) + '|' + _headingSrc + '| {0,3}>|(?: {4}| {0,3}\\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:</?(?:' + _tag + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)';
B.table = rx(_gfmTable);

// paragraph: a run of lines, stopping before a line that starts a block
function paragraphRegex(listInterrupt, withTable = true) {
  const src = '^([^\\n]+(?:\\n(?!' + _hrSrc.slice(1) + '|' + _headingSrc + '| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'
    + '|' + listInterrupt
    + '| {0,3}(?:</?(?:' + _tag + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'
    + (withTable ? '|' + B.table.source.slice(1) : '')
    + '|[ \\t]+\\n)[^\\n]+)*)';
  return rx(src);
}
B.paragraph = paragraphRegex(' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]');
B.paragraphBq = paragraphRegex(' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)', false);
B.blockquote = rx('^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(' + B.paragraphBq.source.slice(1) + ')|[^\\n]*)(?:\\n|$))+');

// ---------- inline grammar (GFM) ----------
const I = {};
I.escape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
I.code = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
I.br = rx('^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*');
I.anyPunctuation = /\\([\p{P}\p{S}])/gu;
I.anyPunctuationOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
I.punctuation = /^((?![*_])[\s\p{P}\p{S}])/u;
I.autolink = rx('^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&\'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>');
I.tag = rx('^<!--(?:-?>|[\\s\\S]*?-->)'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>');

const _inlineLabelBrackets = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const _inlineLabel = rx('(?:\\[(?:' + _inlineLabelBrackets.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?');
const _linkHref = /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/;
const _linkTitle = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/;
I.link = rx('^!?\\[(' + _inlineLabel.source + ')\\]\\([ \\t\\n]*(' + _linkHref.source + ')(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(' + _linkTitle.source + '))?[ \\t\\n]*\\)');
I.reflink = rx('^!?\\[(' + _inlineLabel.source + ')\\]\\[(' + _blockLabel.source + ')\\]');
I.nolink = rx('^!?\\[(' + _blockLabel.source + ')\\](?:\\[\\])?');
const _boundedBlockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const _boundedInlineLabel = rx('(?:[^\\[\\]\\\\`]*(?:\\[(?:' + _inlineLabelBrackets.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?');
I.reflinkSearch = rx('!?\\[(' + _boundedInlineLabel.source + ')\\]\\[(' + _boundedBlockLabel.source + ')\\]|!?\\[(' + _boundedBlockLabel.source + ')\\](?:\\[\\])?(?!\\()', 'g');

// emphasis / strong delimiters (GFM: ~ is not punctuation for em/strong)
const _punctGfm = /(?!~)[\p{P}\p{S}]/u;
const _punctSpaceGfm = /(?!~)[\s\p{P}\p{S}]/u;
const _notPunctSpaceGfm = /(?:[^\s\p{P}\p{S}]|~)/u;
const _punct = /[\p{P}\p{S}]/u;
const _punctSpace = /[\s\p{P}\p{S}]/u;
const _notPunctSpace = /[^\s\p{P}\p{S}]/u;
function emLDelim(punct) {
  return rx('^(?:\\*+(?:((?!\\*)' + punct.source + ')|([^\\s*]))?)|^_+(?:((?!_)' + punct.source + ')|([^\\s_]))?', 'u');
}
I.emStrongLDelim = emLDelim(_punctGfm);
const _rDelimAstCore = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)' + _punctGfm.source + '(\\*+)(?=[\\s]|$)'
  + '|' + _notPunctSpaceGfm.source + '(\\*+)(?!\\*)(?=' + _punctSpaceGfm.source + '|$)'
  + '|(?!\\*)' + _punctSpaceGfm.source + '(\\*+)(?=' + _notPunctSpaceGfm.source + ')'
  + '|[\\s](\\*+)(?!\\*)(?=' + _punctGfm.source + ')'
  + '|(?!\\*)' + _punctGfm.source + '(\\*+)(?!\\*)(?=' + _punctGfm.source + ')'
  + '|' + _notPunctSpaceGfm.source + '(\\*+)(?=' + _notPunctSpaceGfm.source + ')';
I.emStrongRDelimAst = rx(_rDelimAstCore, 'gu');
const _rDelimUndCore = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)' + _punct.source + '(_+)(?=[\\s]|$)'
  + '|' + _notPunctSpace.source + '(_+)(?!_)(?=' + _punctSpace.source + '|$)'
  + '|(?!_)' + _punctSpace.source + '(_+)(?=' + _notPunctSpace.source + ')'
  + '|[\\s](_+)(?!_)(?=' + _punct.source + ')'
  + '|(?!_)' + _punct.source + '(_+)(?!_)(?=' + _punct.source + ')';
I.emStrongRDelimUnd = rx(_rDelimUndCore, 'gu');
I.delLDelim = rx('^~~?(?:((?!~)' + _punct.source + ')|[^\\s~])', 'u');
const _delRCore = '^[^~]+(?=[^~])'
  + '|(?!~)' + _punct.source + '(~~?)(?=[\\s]|$)'
  + '|' + _notPunctSpace.source + '(~~?)(?!~)(?=' + _punctSpace.source + '|$)'
  + '|(?!~)' + _punctSpace.source + '(~~?)(?=' + _notPunctSpace.source + ')'
  + '|[\\s](~~?)(?!~)(?=' + _punct.source + ')'
  + '|(?!~)' + _punct.source + '(~~?)(?!~)(?=' + _punct.source + ')'
  + '|' + _notPunctSpace.source + '(~~?)(?=' + _notPunctSpace.source + ')';
I.delRDelim = rx(_delRCore, 'gu');
I.del = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;
const _emailNoGroup = '[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
const _emailAtGroup = '[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])';
I.url = rx('^(?:mailto:' + _emailNoGroup + '|xmpp:' + _emailNoGroup + '(?:\\/[A-Za-z0-9@.]+)?)'
  + '|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*'
  + '|^' + _emailAtGroup);
I.backpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
I.text = rx('^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*_~]|\\b_|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-](?=[a-zA-Z0-9.!#$%&\'*+\\/=?_`{|}~-]+@))))');
// blockSkip: links, code spans, html — used to mask delimiters inside them
I.blockSkip = rx('\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>', 'g');

// ---------- helpers ----------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function cpLen(s) {
  // code-point count; equals s.length unless s holds astral characters
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) n--;
  }
  return n;
}
function esc(s, encode) {
  if (encode) {
    return O.escapeTest.test(s) ? s.replace(O.escapeReplace, (c) => ESC[c]) : s;
  }
  return O.escapeTestNoEncode.test(s) ? s.replace(O.escapeReplaceNoEncode, (c) => ESC[c]) : s;
}
function decodeNumeric(s) {
  if (!O.numericCharacterReference.test(s)) return s;
  return s.replace(O.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}
function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O.percentDecode, '%');
  } catch { return null; }
  return href;
}
function splitCells(tableRow, count) {
  const row = tableRow.replace(O.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(O.splitPipe);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(O.slashPipe, '|');
  return cells;
}
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}
function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && O.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}
function normalizeLabel(label) {
  return label.trim().replace(O.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}
function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}
function indentCodeCompensation(raw, text) {
  const m = raw.match(O.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mm = node.match(O.beginningSpace);
    if (mm === null) return node;
    return node.slice(Math.min(mm[0].length, indentToCode.length));
  }).join('\n');
}
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = I.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = I.tag.exec(tokenSrc) || I.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}
// Last emphasis / strikethrough closers in one scan (lazy: only computed
// when an opener is actually attempted in the run).
function scanClosers(src) {
  const out = { '*': -1, _: -1, '~': -1 };
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') out[ch] = i;
    i = j - 1;
  }
  return out;
}

// ---------- inline masking (keeps em/strong/del from seeing delimiters
// inside links, code spans, escapes and html) ----------
function linkInText(text, S) {
  if (!text.includes('[')) return false;
  for (const m of text.matchAll(I.blockSkip)) {
    if (I.link.test(m[0]) && text.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of text.matchAll(I.reflinkSearch)) {
    const m0 = m[0];
    const refStart = m0.lastIndexOf('[');
    if (m0.charAt(0) === '!' || !Object.hasOwn(S.links, normalizeLabel(m0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(m0.slice(1, refStart - 1), S)) continue;
    return true;
  }
  return false;
}
function maskSrc(src, S) {
  let masked = src;
  // Reflink masking only matters when a definition exists for some label,
  // and a reflink needs a ']' in the source at all.
  if (src.includes('[') && src.includes(']') && S.linkCount > 0) {
    const maskReflink = (m0) => {
      const refStart = m0.lastIndexOf('[');
      if (!Object.hasOwn(S.links, normalizeLabel(m0.slice(refStart + 1, -1)))) return m0;
      if (refStart > 1 && m0.charAt(0) !== '!') {
        const text = m0.slice(1, refStart - 1);
        if (linkInText(text, S)) {
          return '[' + text.replace(I.reflinkSearch, maskReflink) + '][' + 'a'.repeat(m0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m0.length - 2) + ']';
    };
    masked = masked.replace(I.reflinkSearch, maskReflink);
  }
  // Escapes / code spans: nothing to mask without a backslash or backtick.
  if (masked.includes('\\') || masked.includes('`')) {
    masked = masked.replace(I.anyPunctuationOutsideCode, (m0, code, punct) => {
      if (punct) return '+'.repeat(m0.length);
      if (code) return code + m0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return m0;
    });
  }
  // blockSkip only matches links, code spans or html: skip the scan when
  // the source holds none of their opening characters.
  if (masked.includes('[') || masked.includes('`') || masked.includes('<')) {
    masked = masked.replace(I.blockSkip, (m0) => '[' + 'a'.repeat(m0.length - 2) + ']');
  }
  return masked;
}
// Render a link / image token's label text, tracking nested links.
function outputLink(cap, href, title, raw, S, textMode) {
  const text = cap[1].replace(O.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = S.inLink;
  const outerLinkEmitted = S.linkEmitted;
  const outerInRawBlock = S.inRawBlock;
  S.inLink = true;
  S.linkEmitted = false;
  const inner = inlineTokens(text, S, isImage || textMode);
  const textHasLink = S.linkEmitted;
  S.linkEmitted = outerLinkEmitted;
  S.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      S.inRawBlock = outerInRawBlock;
      return null;
    }
    S.linkEmitted = true;
    return { image: false, href, title, text, inner, raw };
  }
  return { image: true, href, title, text, inner, raw };
}
function renderLink(tok) {
  if (tok.autolink) {
    const parsedText = esc(tok.text, true);
    const cleanHref = cleanUrl(tok.href);
    if (cleanHref === null) return parsedText;
    const href = esc(cleanHref, true);
    let out = '<a href="' + href + '"';
    if (tok.title) out += ' title="' + esc(tok.title) + '"';
    return out + '>' + parsedText + '</a>';
  }
  const cleanHref = cleanUrl(tok.href);
  if (cleanHref === null) return tok.inner;
  const href = esc(cleanHref, false);
  let out = '<a href="' + href + '"';
  if (tok.title) out += ' title="' + esc(tok.title) + '"';
  return out + '>' + tok.inner + '</a>';
}
function renderImage(tok) {
  const cleanHref = cleanUrl(tok.href);
  if (cleanHref === null) return esc(tok.inner);
  const href = esc(cleanHref);
  let out = '<img src="' + href + '" alt="' + esc(tok.inner) + '"';
  if (tok.title) out += ' title="' + esc(tok.title) + '"';
  return out + '>';
}
function tokLink(src, S, textMode) {
  if (S.linkParenPossible === false) return null;
  const cap = I.link.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (O.startAngleBracket.test(trimmedUrl)) {
    if (!O.endAngleBracket.test(trimmedUrl)) return null;
    const rt = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rt.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O.startAngleBracket.test(href)) href = href.slice(1, -1);
  const tok = outputLink(cap, {
    href: href ? href.replace(I.anyPunctuation, '$1') : href,
    title: title ? title.replace(I.anyPunctuation, '$1') : title,
  }.href, title ? title.replace(I.anyPunctuation, '$1') : title, cap[0], S, textMode);
  if (!tok) return null;
  return { h: textMode ? tok.inner : (tok.image ? renderImage(tok) : renderLink(tok)), n: cap[0].length };
}

function tokReflink(src, S, textMode) {
  let cap = I.reflink.exec(src) || I.nolink.exec(src);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const link = S.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const text = cap[0].charAt(0);
    return { h: text, n: 1, textOnly: true };
  }
  const tok = outputLink(cap, link.href, link.title, cap[0], S, textMode);
  if (!tok) return null;
  return { h: textMode ? tok.inner : (tok.image ? renderImage(tok) : renderLink(tok)), n: cap[0].length };
}
function tokEmStrong(src, maskedSrc, prevChar, S, textMode) {
  let match = I.emStrongLDelim.exec(src);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!I.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!I.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(O.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = cpLen(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? I.emStrongRDelimAst : I.emStrongRDelimUnd;
    const closers = S._closers || (S._closers = scanClosers(maskedSrc));
    const lastPossible = closers[delimChar];
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length; // delimiter runs hold only '*' / '_' (ASCII)
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = inlineTokens(text, S, textMode);
        return { h: textMode ? inner : '<em>' + inner + '</em>', n: raw.length };
      }
      const text = raw.slice(2, -2);
      const inner = inlineTokens(text, S, textMode);
      return { h: textMode ? inner : '<strong>' + inner + '</strong>', n: raw.length };
    }
  }
  return null;
}
function tokDel(src, maskedSrc, prevChar, S, textMode) {
  let match = I.delLDelim.exec(src);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || I.punctuation.exec(prevChar)) {
    const lLength = cpLen(match[0]) - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = I.delRDelim;
    const closers = S._closers || (S._closers = scanClosers(maskedSrc));
    const lastPossible = closers['~'];
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = rDelim.length; // delimiter runs hold only '~' (ASCII)
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = match[0].codePointAt(0) > 0xFFFF ? 2 : 1;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = inlineTokens(text, S, textMode);
      return { h: textMode ? inner : '<del>' + inner + '</del>', n: raw.length };
    }
  }
  return null;
}
function tokAutolink(src, S, textMode) {
  const cap = I.autolink.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  return { h: textMode ? text : renderLink({ autolink: true, text, href, title: '' }), n: cap[0].length };
}
function tokUrl(src, S, textMode) {
  const cap = I.url.exec(src);
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = I.backpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { h: textMode ? text : renderLink({ autolink: true, text, href, title: '' }), n: cap[0].length };
}
function tokCodespan(src) {
  const cap = I.code.exec(src);
  if (!cap) return null;
  let text = cap[2].replace(O.newLineCharGlobal, ' ');
  const hasNonSpaceChars = O.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = O.startingSpaceChar.test(text) && O.endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { h: '<code>' + esc(text, true) + '</code>', n: cap[0].length, plain: text };
}

// ---------- inline loop ----------
function tokEscape(src, textMode) {
  const cap = I.escape.exec(src);
  if (!cap) return null;
  return { h: textMode ? cap[1] : esc(cap[1]), n: cap[0].length };
}
function tokTag(src, S) {
  const cap = I.tag.exec(src);
  if (!cap) return null;
  if (!S.inLink && O.startATag.test(cap[0])) S.inLink = true;
  else if (S.inLink && O.endATag.test(cap[0])) S.inLink = false;
  if (!S.inRawBlock && O.startPreScriptTag.test(cap[0])) S.inRawBlock = true;
  else if (S.inRawBlock && O.endPreScriptTag.test(cap[0])) S.inRawBlock = false;
  return { h: cap[0], n: cap[0].length };
}
function tokBr(src, textMode) {
  const cap = I.br.exec(src);
  if (!cap) return null;
  return { h: textMode ? '' : '<br>', n: cap[0].length };
}
function urlPossible(src) {
  if (src.startsWith('www.') || src.startsWith('mailto:') || src.startsWith('xmpp:')) return true;
  const head = src.slice(0, 5).toLowerCase();
  if (head.startsWith('http') || head.startsWith('ftp')) return true;
  const at = src.indexOf('@');
  if (at === -1) return false;
  let end = src.length;
  for (const sep of [' ', '\t', '\n', '<']) {
    const i = src.indexOf(sep);
    if (i !== -1 && i < end) end = i;
  }
  return at < end;
}
function inlineTokens(src, S, textMode) {
  const prevParen = S.linkParenPossible;
  const prevClosers = S._closers;
  S.linkParenPossible = prevParen && src.includes(')');
  S._closers = null;
  try {
    return inlineTokensInner(src, S, textMode);
  } finally {
    S.linkParenPossible = prevParen;
    S._closers = prevClosers;
  }
}
function inlineTokensInner(src, S, textMode) {
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const maskedSrc = needsMask ? maskSrc(src, S) : src;
  let out = '';
  let keepPrevChar = false;
  let prevChar = '';
  while (src) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const c = src[0];
    let t = null;
    if (c === '\\') {
      t = tokEscape(src, textMode);
      if (!t) t = tokBr(src, textMode);
    } else if (c === '<') {
      t = tokTag(src, S);
      if (!t) t = tokAutolink(src, S, textMode);
    } else if (c === '!' || c === '[') {
      t = tokLink(src, S, textMode);
      if (!t) t = tokReflink(src, S, textMode);
    } else if (c === '*' || c === '_') {
      t = tokEmStrong(src, maskedSrc, prevChar, S, textMode);
    } else if (c === '`') {
      t = tokCodespan(src);
      if (t && textMode) t = { h: t.plain, n: t.n };
    } else if (c === '~') {
      t = tokDel(src, maskedSrc, prevChar, S, textMode);
    } else if (c === ' ') {
      t = tokBr(src, textMode);
    } else if (!S.inLink && urlPossible(src)) {
      t = tokUrl(src, S, textMode);
    }
    if (t) {
      out += t.h;
      src = src.slice(t.n);
      continue;
    }
    // plain text run (fast scan, equivalent to the inline text regex)
    const len = textChunkLen(src);
    const raw = src.slice(0, len);
    const txt = S.inRawBlock ? raw : decodeNumeric(raw);
    out += textMode ? txt : (S.inRawBlock ? raw : esc(txt));
    if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
    keepPrevChar = true;
    src = src.slice(len);
  }
  return out;
}

// ---------- block tokenizers ----------
// Nodes are plain objects: {k, raw, ...}. Inline-bearing nodes carry
// `src` (the inline source) and get `html` filled from the queue after
// the whole block pass, exactly like marked defers inline lexing.
function queueInline(S, node, src) {
  const e = { src, node };
  S.queue.push(e);
  node._q = e;
  node.src = src;
  return e;
}
function tokSpace(src) {
  const cap = B.newline.exec(src);
  if (cap && cap[0].length > 0) return { k: 'space', raw: cap[0] };
  return null;
}
function tokCode(src) {
  const cap = B.code.exec(src);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(O.codeRemoveIndent, '');
  return { k: 'code', raw, text };
}
function tokFences(src) {
  const cap = B.fences.exec(src);
  if (!cap) return null;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  return { k: 'code', raw, lang: cap[2] ? cap[2].trim().replace(I.anyPunctuation, '$1') : cap[2], text };
}
function tokHeading(src, S) {
  const cap = B.heading.exec(src);
  if (!cap) return null;
  let text = cap[2].trim();
  if (O.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || O.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  const node = { k: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[1].length, text };
  queueInline(S, node, text);
  return node;
}
function tokHr(src) {
  const cap = B.hr.exec(src);
  if (!cap) return null;
  return { k: 'hr', raw: rtrim(cap[0], '\n') };
}
function tokHtml(src) {
  const cap = B.html.exec(src);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  return { k: 'html', raw, text: raw };
}
function tokDef(src, S) {
  const cap = B.def.exec(src);
  if (!cap) return null;
  if (!O.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(O.hrefBrackets, '$1').replace(I.anyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(I.anyPunctuation, '$1') : cap[3];
  return { k: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}
function tokTable(src, S) {
  // Cheap pre-check: a table needs a header line, then a delimiter line
  // whose first cell is '|' / ':' / '-' and which holds a '|' or ':'.
  const nl1 = src.indexOf('\n');
  if (nl1 === -1) return null;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const line2 = nl2 === -1 ? src.slice(nl1 + 1) : src.slice(nl1 + 1, nl2);
  if (!/^\s*\|?\s*:?-/.test(line2)) return null;
  if (line2.indexOf('|') === -1 && line2.indexOf(':') === -1) return null;
  const cap = B.table.exec(src);
  if (!cap) return null;
  if (!O.tableDelimiter.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(O.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const node = { k: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  for (const align of aligns) {
    if (O.tableAlignRight.test(align)) node.align.push('right');
    else if (O.tableAlignCenter.test(align)) node.align.push('center');
    else if (O.tableAlignLeft.test(align)) node.align.push('left');
    else node.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], header: true, align: node.align[i] };
    queueInline(S, cell, headers[i]);
    node.header.push(cell);
  }
  for (const row of rows) {
    node.rows.push(splitCells(row, node.header.length).map((cell, i) => {
      const c = { text: cell, header: false, align: node.align[i] };
      queueInline(S, c, cell);
      return c;
    }));
  }
  return node;
}
function tokLheading(src, S) {
  const cap = B.lheadingGfm.exec(src);
  if (!cap) return null;
  const text = cap[1].trim();
  const node = { k: 'heading', raw: rtrim(cap[0], '\n'), depth: cap[2].charAt(0) === '=' ? 1 : 2, text };
  queueInline(S, node, text);
  return node;
}
function tokParagraph(src, S) {
  const cap = B.paragraph.exec(src);
  if (!cap) return null;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  const node = { k: 'paragraph', raw: cap[0], text };
  queueInline(S, node, text);
  return node;
}
function tokText(src, S) {
  const cap = B.text.exec(src);
  if (!cap) return null;
  const node = { k: 'text', raw: cap[0], text: cap[0] };
  queueInline(S, node, cap[0]);
  return node;
}

function tokBlockquote(src, S) {
  const cap = B.blockquote.exec(src);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (O.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else break;
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(O.blockquoteMarkerWhitespace, (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length))
      .replace(O.blockquoteSetextReplace, '\n    $1')
      .replace(O.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = S.top;
    S.top = true;
    blockTokens(currentText, tokens, S, true);
    S.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken?.k === 'code' || lastToken?.k === 'heading' || lastToken?.k === 'hr' || lastToken?.k === 'html' || lastToken?.k === 'table') {
      break;
    } else if (lastToken?.k === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O.blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(newText, S);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.k === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(newText, S);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { k: 'blockquote', raw, tokens, text };
}
// /\n[ \t]*\n[ \t]*$/ without scanning the whole string: walk back from
// the end over spaces/tabs and expect two newlines.
function endsWithBlankLineRaw(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  return i > 0 && raw[i - 1] === '\n';
}
function tokList(src, S) {
  let cap = B.list.exec(src);
  if (!cap) return null;
  const listSrc = src;
  const taken = () => listSrc.length - src.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = { k: 'list', raw: '', ordered: isordered, start: isordered ? +bull.slice(0, -1) : '', loose: false, items: [] };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = O.listItemRegex(bull);
  let endsWithBlankLine = false;
  while (src) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(src))) break;
    if (B.hr.test(src)) break;
    const itemStart = taken();
    src = src.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = src.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && O.blankLine.test(nextLine)) {
      src = src.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = O.nextBulletRegex(indent);
      const hrRegex = O.hrRegex(indent);
      const fencesBeginRegex = O.fencesBeginRegex(indent);
      const headingBeginRegex = O.headingBeginRegex(indent);
      const htmlBeginRegex = O.htmlBeginRegex(indent);
      const blockquoteBeginRegex = O.blockquoteBeginRegex(indent);
      while (src) {
        const nl = src.indexOf('\n');
        const rawLine = nl === -1 ? src : src.slice(0, nl);
        nextLine = rawLine;
        const fl = rawLine[0];
        const isBlank = !/\S/.test(rawLine); // same as rawLine.trim() === ''
        // The leading-whitespace expand only matters when a tab is present.
        const nextLineWithoutTabs = (fl === ' ' || fl === '\t') && rawLine.includes('\t')
          ? nextLine.replace(O.leadingSpaceTab, (ws) => expandTabs(ws))
          : nextLine;
        // The six "end of item" tests can only match when the line, after
        // at most `indent` spaces, starts with a fence / heading / html /
        // blockquote / bullet / hr marker: dispatch on the first character.
        const startsSpace = fl === ' ' || fl === '\t';
        if (startsSpace || fl === '`' || fl === '~') {
          if (fencesBeginRegex.test(nextLine)) break;
        }
        if (startsSpace || fl === '#') {
          if (headingBeginRegex.test(nextLine)) break;
        }
        if (startsSpace || fl === '<') {
          if (htmlBeginRegex.test(nextLine)) break;
        }
        if (startsSpace || fl === '>') {
          if (blockquoteBeginRegex.test(nextLine)) break;
        }
        if (startsSpace || fl === '-' || fl === '*' || fl === '+' || (fl >= '0' && fl <= '9')) {
          if (nextBulletRegex.test(nextLine)) break;
        }
        if (startsSpace || fl === '-' || fl === '_' || fl === '*') {
          if (hrRegex.test(nextLine)) break;
        }
        const nsp = startsSpace ? nextLineWithoutTabs.search(O.nonSpaceChar) : 0;
        if (nsp >= indent || isBlank) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if ((line.includes('\t') ? line.replace(O.tabCharGlobal, '    ') : line).search(O.nonSpaceChar) >= 4) break;
          const lf = line[0];
          const lStartsSpace = lf === ' ' || lf === '\t';
          if ((lStartsSpace || lf === '`' || lf === '~') && fencesBeginRegex.test(line)) break;
          if ((lStartsSpace || lf === '#') && headingBeginRegex.test(line)) break;
          if ((lStartsSpace || lf === '<') && htmlBeginRegex.test(line)) break;
          if ((lStartsSpace || lf === '-' || lf === '_' || lf === '*') && hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine) && B.lheadingGfm.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}` : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = isBlank;
        src = src.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (endsWithBlankLineRaw(raw)) endsWithBlankLine = true;
    }
    list.items.push({ k: 'item', raw, task: O.listIsTask.test(itemContents), loose: false, text: itemContents, nodes: [] });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  for (const item of list.items) {
    S.top = false;
    item.nodes = blockTokens(item.text, [], S);
    if (!list.loose) {
      const spacers = item.nodes.filter((t) => t.k === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  for (const item of list.items) {
    const itemToken = item.nodes[0];
    if (item.task && (itemToken?.k === 'text' || itemToken?.k === 'paragraph')) {
      item.text = item.text.replace(O.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O.listReplaceTask, '');
      itemToken.src = itemToken.src.replace(O.listReplaceTask, '');
      if (itemToken._q) itemToken._q.src = itemToken._q.src.replace(O.listReplaceTask, '');
      for (let i = S.queue.length - 1; i >= 0; i--) {
        if (O.listIsTask.test(S.queue[i].src)) {
          S.queue[i].src = S.queue[i].src.replace(O.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = O.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const cbRaw = taskRaw[0] + ' ';
        const cbHtml = '<input ' + (taskRaw[0] !== '[ ]' ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        item.checked = taskRaw[0] !== '[ ]';
        if (list.loose) {
          if (itemToken && ['paragraph', 'text'].includes(itemToken.k)) {
            // inline already queued; checkbox is prepended at render time
            item.cbHtml = cbHtml;
            item.cbPlace = 'para';
          } else {
            item.nodes.unshift({ k: 'paragraph', raw: cbRaw, text: cbRaw, src: cbRaw, html: cbHtml });
          }
        } else {
          item.nodes.unshift({ k: 'checkbox', raw: cbRaw, html: cbHtml });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.nodes) {
        if (token.k === 'text') token.k = 'paragraph';
      }
    }
  }
  return list;
}

// ---------- block loop ----------
function blockTokens(src, nodes, S, lastParagraphClipped = false) {
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      break; // infinite-loop guard; the spec cases never hit it
    }
    let token;
    // First-character dispatch: each block tokenizer's regex can only
    // match when the source starts with one of a few characters (or an
    // indent). Table / setext / paragraph / text are tried always — they
    // carry cheap guards of their own inside.
    const c0 = src[0];
    const ind = c0 === ' ' || c0 === '\t';
    const canSpace = ind || c0 === '\n';
    const canFences = ind || c0 === '`' || c0 === '~';
    const canHeading = ind || c0 === '#';
    const canHr = ind || c0 === '-' || c0 === '_' || c0 === '*';
    const canBq = ind || c0 === '>';
    const canList = ind || c0 === '-' || c0 === '+' || c0 === '*' || (c0 >= '0' && c0 <= '9');
    const canHtml = ind || c0 === '<';
    const canDef = ind || c0 === '[';
    if (canSpace && (token = tokSpace(src))) {
      src = src.substring(token.raw.length);
      const lastToken = nodes.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
      else nodes.push(token);
      continue;
    }
    if (ind && (token = tokCode(src))) {
      src = src.substring(token.raw.length);
      const lastToken = nodes.at(-1);
      if (lastToken?.k === 'paragraph' || lastToken?.k === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lastToken.src = lastToken.text;
        if (lastToken._q) lastToken._q.src = lastToken.text;
      } else nodes.push(token);
      continue;
    }
    if (canFences && (token = tokFences(src))) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (canHeading && (token = tokHeading(src, S))) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (canHr && (token = tokHr(src))) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (canBq && (token = tokBlockquote(src, S))) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (canList && (token = tokList(src, S))) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (canHtml && (token = tokHtml(src))) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (canDef && (token = tokDef(src, S))) {
      src = src.substring(token.raw.length);
      const lastToken = nodes.at(-1);
      if (lastToken?.k === 'paragraph' || lastToken?.k === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        lastToken.src = lastToken.text;
        if (lastToken._q) lastToken._q.src = lastToken.text;
      } else {
        if (!S.links[token.tag]) {
          S.links[token.tag] = { href: token.href, title: token.title };
          S.linkCount++;
        }
        nodes.push(token);
      }
      continue;
    }
    if (token = tokTable(src, S)) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (token = tokLheading(src, S)) {
      src = src.substring(token.raw.length);
      nodes.push(token);
      continue;
    }
    if (S.top && (token = tokParagraph(src, S))) {
      const lastToken = nodes.at(-1);
      if (lastParagraphClipped && lastToken?.k === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.queue.pop();
        lastToken.src = lastToken.text;
        if (lastToken._q) lastToken._q.src = lastToken.text;
      } else {
        nodes.push(token);
      }
      lastParagraphClipped = false;
      src = src.substring(token.raw.length);
      continue;
    }
    if (token = tokText(src, S)) {
      src = src.substring(token.raw.length);
      const lastToken = nodes.at(-1);
      if (lastToken?.k === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        S.queue.pop();
        lastToken.src = lastToken.text;
        if (lastToken._q) lastToken._q.src = lastToken.text;
      } else {
        nodes.push(token);
      }
      continue;
    }
    break;
  }
  S.top = true;
  return nodes;
}

// ---------- render ----------
function renderCell(cell) {
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + cell.html + `</${type}>\n`;
}
function renderNodeWithPrepend(n, pre) {
  if (n.k === 'paragraph') return `<p>${pre}${n.html}</p>\n`;
  if (n.k === 'text') return pre + n.html;
  return pre + renderNode(n);
}
function renderItem(item) {
  let body;
  if (item.cbHtml && item.cbPlace === 'para' && item.nodes.length > 0) {
    body = renderNodeWithPrepend(item.nodes[0], item.cbHtml) + renderNodes(item.nodes.slice(1));
  } else {
    body = renderNodes(item.nodes);
  }
  return `<li>${body}</li>\n`;
}
function renderList(list) {
  let body = '';
  for (const item of list.items) body += renderItem(item);
  const type = list.ordered ? 'ol' : 'ul';
  const startAttr = (list.ordered && list.start !== 1) ? (' start="' + list.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}
function renderNode(n) {
  switch (n.k) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return `<h${n.depth}>${n.html}</h${n.depth}>\n`;
    case 'code': {
      const langString = (n.lang || '').match(O.notSpaceStart)?.[0];
      const code = n.text ? n.text.replace(O.endingNewline, '') + '\n' : '';
      if (!langString) return '<pre><code>' + esc(code, true) + '</code></pre>\n';
      return '<pre><code class="language-' + esc(langString) + '">' + esc(code, true) + '</code></pre>\n';
    }
    case 'table': {
      let header = '';
      for (const cell of n.header) header += renderCell(cell);
      let body = '';
      for (const row of n.rows) {
        let cells = '';
        for (const cell of row) cells += renderCell(cell);
        body += `<tr>\n${cells}</tr>\n`;
      }
      if (body) body = `<tbody>${body}</tbody>`;
      return '<table>\n<thead>\n' + `<tr>\n${header}</tr>\n` + '</thead>\n' + body + '</table>\n';
    }
    case 'blockquote': return `<blockquote>\n${renderNodes(n.tokens)}</blockquote>\n`;
    case 'list': return renderList(n);
    case 'checkbox': return n.html;
    case 'html': return n.text;
    case 'def': return '';
    case 'paragraph': return `<p>${n.html}</p>\n`;
    case 'text': return n.html;
    default: return '';
  }
}
function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) out += renderNode(n);
  return out;
}

// ---------- entry point ----------
export function parse(markdown) {
  const src = String(markdown).replace(O.carriageReturn, '\n');
  const S = {
    links: Object.create(null),
    linkCount: 0,
    queue: [],
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    _closers: null,
  };
  const nodes = blockTokens(src, [], S);
  for (const e of S.queue) {
    S.inRawBlock = false;
    e.node.html = inlineTokens(e.src, S);
  }
  S.queue = [];
  return renderNodes(nodes);
}

// ---------- fast plain-text scan ----------
// textChunkLen(src) returns the length of the plain-text run the inline
// text rule would match at the start of src, computed by scanning for the
// next stop position instead of running the big lazy text regex. The stop
// positions are the same ones the regex encodes:
//   - a stop character \ < ! [ ` * ~, or _ at a word boundary
//   - 2+ spaces followed by a newline (hard-break start)
//   - mailto:/xmpp: after a non-alphanumeric character
//   - an email-like run followed by @ after a non-email character
//   - www. after start / whitespace / * _ ~ (
//   - http://, https:// or ftp:// (any case)
// A single non-alphanumeric character right before mailto:/xmpp: is a
// one-character text run on its own.
const _alnumCh = (cc) => (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
const _emailChTable = new Uint8Array(128);
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.!#$%&'*+/=?_`{|}~-") _emailChTable[ch.charCodeAt(0)] = 1;
const _emailCh = (cc) => cc < 128 && _emailChTable[cc] === 1;
const _wsStarTable = new Uint8Array(128);
for (const ch of ' \t\n\r\f\v*_~(') _wsStarTable[ch.charCodeAt(0)] = 1;
const _wsStarCh = (cc) => cc < 128 && _wsStarTable[cc] === 1;
// One scan for stop characters / hard breaks / protocol prefixes, one scan
// for mailto: / xmpp: / www. / '@'. Each candidate is the earliest stop of
// its kind; the answer is the minimum. Note the email stop sits at the
// START of the email-character run ending at '@', which can precede the
// '@' itself (and even a stop character), so '@' is handled by walking
// back from its position rather than by the position where it was found.
const _scanA = /[\\<!\[`*_~]|  \n|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\//g;
// mailto:/xmpp:/www. in the text rule are lowercase-only, so this scan is
// case-sensitive too (an uppercase MAILTO: must not split the text).
const _scanB = /mailto:|xmpp:|www\.|@/g;
function textChunkLen(src) {
  const n = src.length;
  const c0 = src[0];
  if (!_alnumCh(c0.charCodeAt(0)) && (src.startsWith('mailto:', 1) || src.startsWith('xmpp:', 1))) return 1;
  let p0 = 1;
  if (c0 === '`' || c0 === '~') {
    while (p0 < n && src[p0] === c0) p0++;
  }
  let best = n;
  _scanA.lastIndex = p0;
  const am = _scanA.exec(src);
  if (am) {
    const t = am[0];
    const i = am.index;
    if (t === '  \n') {
      let p = i;
      while (p > p0 && src[p - 1] === ' ') p--;
      let q = p;
      while (src[q] === ' ') q++;
      if (q - p >= 2 && src[q] === '\n') best = p;
    } else {
      best = i;
    }
    if (best === p0) { _scanA.lastIndex = 0; return p0; }
  }
  _scanA.lastIndex = 0;
  // The four triggers are rare: skip the regex pass when none of them
  // occurs in the rest of the chunk (indexOf is a tight memchr scan).
  if (src.indexOf('@', p0) === -1 && src.indexOf('www.', p0) === -1
    && src.indexOf('mailto:', p0) === -1 && src.indexOf('xmpp:', p0) === -1) {
    return best;
  }
  _scanB.lastIndex = p0;
  let bm;
  while ((bm = _scanB.exec(src)) !== null) {
    const t = bm[0];
    const i = bm.index;
    if (t === '@') {
      let r = i;
      while (r > 0 && _emailCh(src.charCodeAt(r - 1))) r--;
      if (r < i) {
        const p = r < p0 ? p0 : r;
        if (p < i && p < best) best = p;
      }
    } else if (t === 'mailto:' || t === 'xmpp:') {
      if ((i === 0 || !_alnumCh(src.charCodeAt(i - 1))) && i < best) best = i;
    } else {
      if ((i === 0 || _wsStarCh(src.charCodeAt(i - 1))) && i < best) best = i;
    }
    if (best === p0) break;
  }
  _scanB.lastIndex = 0;
  return best;
}
