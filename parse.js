// Fresh regex-based CommonMark+GFM renderer, byte-identical to marked 18.1.3
// (default options: gfm on, breaks off, pedantic off). Written from scratch
// against the kit's vendored marked as semantic reference. No dependencies.
const CARET = /(^|[^\[])\^/g;
function rep(pat, flags) {
  let t = typeof pat === 'string' ? pat : pat.source;
  const api = {
    replace(s, r) {
      let o = typeof r === 'string' ? r : r.source;
      o = o.replace(CARET, '$1');
      t = t.replace(s, () => o);
      return api;
    },
    getRegex() { return new RegExp(t, flags); },
  };
  return api;
}
const K = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const UE = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const T = {
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
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};
const INDENT_CACHE = new Map();
function indentRe(kind, a) {
  const key = kind + ':' + a;
  let r = INDENT_CACHE.get(key);
  if (r) return r;
  const nn = Math.max(0, Math.min(3, a - 1));
  if (kind === 'item') r = new RegExp(`^( {0,3}${a})((?:[ \t][^\n]*)?(?:\n|$))`);
  else if (kind === 'next') r = new RegExp(`^ {0,${nn}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`);
  else if (kind === 'hr') r = new RegExp(`^ {0,${nn}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`);
  else if (kind === 'fence') r = new RegExp(`^ {0,${nn}}(?:\`\`\`|~~~)`);
  else if (kind === 'head') r = new RegExp(`^ {0,${nn}}#{1,6}(?:\\s|$)`);
  else if (kind === 'html') r = new RegExp(`^ {0,${nn}}(?:</?(?:${K})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
  else r = new RegExp(`^ {0,${nn}}>`);
  INDENT_CACHE.set(key, r);
  return r;
}

const OE = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const HR_RE = /^ {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const AE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function pe(listPat) {
  return rep(AE)
    .replace('hr', HR_RE).replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '').replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listPat)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', K).getRegex();
}
const TABLE_RE = rep("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', HR_RE).replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>').replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', K).getRegex();
const B = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: HR_RE,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  list: rep(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, OE).getRegex(),
  blockquote: rep(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', pe(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)).getRegex(),
  html: rep("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", 'i')
    .replace('comment', UE).replace('tag', K)
    .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/).getRegex(),
  table: TABLE_RE,
  lheading: rep(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
    .replace(/bull/g, OE).replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/).replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/).replace(/hr/g, HR_RE)
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/).getRegex(),
  paragraph: rep(AE)
    .replace('hr', HR_RE).replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '').replace('table', TABLE_RE)
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', K).getRegex(),
  text: /^[^\n]+/,
};

const LE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LE_BR = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const RE_LBL = rep(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', LE_BR).getRegex();
const BE_LBL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LT_LBL = rep(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', LE_BR).getRegex();
const DEF_RE = rep(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/).getRegex();
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_NOTILDE = /(?!~)[\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const PUNCT_SPACE_NOTILDE = /(?!~)[\s\p{P}\p{S}]/u;
const ANY_PUNCT = rep(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE = rep(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const CODE_SPAN_RE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const BR_RE = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const ESCAPE_RE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const PUNCT_RE = rep(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex();
const EM_STRONG_L = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const EM_STRONG_L_GFM = rep(EM_STRONG_L, 'u').replace(/punct/g, PUNCT_NOTILDE).getRegex();
const AST_R = "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)";
const UND_R = "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)";
const EM_STRONG_R_AST = rep(AST_R, 'gu').replace(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE).replace(/punctSpace/g, PUNCT_SPACE_NOTILDE).replace(/punct/g, PUNCT_NOTILDE).getRegex();
const EM_STRONG_R_UND = rep(UND_R, 'gu').replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).getRegex();
const DEL_L = rep(/^(?:~~?(?:((?!~)punct)|[^\s~]))/, 'u').replace(/punct/g, PUNCT).getRegex();
const DEL_R_SRC = "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)";
const DEL_R = rep(DEL_R_SRC, 'gu').replace(/notPunctSpace/g, NOT_PUNCT_SPACE).replace(/punctSpace/g, PUNCT_SPACE).replace(/punct/g, PUNCT).getRegex();
const AUTOLINK_RE = rep(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/).getRegex();
const TAG_RE = rep("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .replace('comment', rep(UE).replace('(?:-->|$)', '-->').getRegex())
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/).getRegex();
const LINK_RE = rep(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', RE_LBL)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/).getRegex();
const REFLINK_RE = rep(/^!?\[(label)\]\[(ref)\]/).replace('label', RE_LBL).replace('ref', LE).getRegex();
const NOLINK_RE = rep(/^!?\[(ref)\](?:\[\])?/).replace('ref', LE).getRegex();
const REFLINK_SEARCH = rep('reflink|nolink(?!\\()', 'g')
  .replace('reflink', rep(/^!?\[(label)\]\[(ref)\]/).replace('label', LT_LBL).replace('ref', BE_LBL).getRegex())
  .replace('nolink', rep(/^!?\[(ref)\](?:\[\])?/).replace('ref', BE_LBL).getRegex()).getRegex();
const BLOCK_SKIP = rep(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/).getRegex();
const EMAIL_RE = /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const PROTO_RE = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const EMAIL_NG = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const URL_RE = rep(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', rep(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_NG).getRegex())
  .replace('protocol', PROTO_RE)
  .replace('email', EMAIL_RE).getRegex();
const BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const TEXT_RE = rep(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', PROTO_RE)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.').getRegex();

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s, full) {
  if (full) {
    if (T.escapeTest.test(s)) return s.replace(T.escapeReplace, (c) => ESC_MAP[c]);
  } else if (T.escapeTestNoEncode.test(s)) return s.replace(T.escapeReplaceNoEncode, (c) => ESC_MAP[c]);
  return s;
}
function unesc(s) {
  if (!T.numericCharacterReference.test(s)) return s;
  return s.replace(T.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const n = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}
function encHref(s) {
  try { return encodeURI(s).replace(T.percentDecode, '%'); } catch { return null; }
}
function normLabel(s) {
  return s.trim().replace(T.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function trimEnd(s, ch, not) {
  const n = s.length;
  if (n === 0) return '';
  let c = 0;
  for (; c < n;) {
    const r = s.charAt(n - c - 1);
    if (r === ch && !not) c++;
    else if (r !== ch && not) c++;
    else break;
  }
  return s.slice(0, n - c);
}
function stripBlanks(s) {
  const e = s.split('\n');
  let t = e.length - 1;
  for (; t >= 0 && T.blankLine.test(e[t]);) t--;
  return e.length - t <= 2 ? s : e.slice(0, t + 1).join('\n');
}
function tabExpand(s, col = 0) {
  let t = col, out = '';
  for (const c of s) {
    if (c === '\t') { const r = 4 - t % 4; out += ' '.repeat(r); t += r; }
    else { out += c; t++; }
  }
  return out;
}
function fenceIndent(raw, content) {
  const n = raw.match(T.indentCodeCompensation);
  if (n === null) return content;
  const s = n[1];
  return content.split('\n').map((r) => {
    const o = r.match(T.beginningSpace);
    if (o === null) return r;
    return r.slice(Math.min(o[0].length, s.length));
  }).join('\n');
}
function parenBalance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let t = 0;
  for (let n = 0; n < s.length; n++) {
    if (s[n] === '\\') n++;
    else if (s[n] === pair[0]) t++;
    else if (s[n] === pair[1] && (t--, t < 0)) return n;
  }
  return t > 0 ? -2 : -1;
}
function splitCells(s, count) {
  const t = s.replace(T.findPipe, (r, o, i) => {
    let l = false, p = o;
    for (; --p >= 0 && i[p] === '\\';) l = !l;
    return l ? '|' : ' |';
  });
  const n = t.split(T.splitPipe);
  if (n[0].trim()) { /* keep */ } else n.shift();
  if (n.length > 0 && !n.at(-1)?.trim()) n.pop();
  if (count) {
    if (n.length > count) n.splice(count);
    else for (; n.length < count;) n.push('');
  }
  for (let i = 0; i < n.length; i++) n[i] = n[i].trim().replace(T.slashPipe, '|');
  return n;
}
function scanDelims(masked) {
  const e = { '*': -1, '_': -1 };
  let t = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const o = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    for (; i < n && masked[i] === r;) i++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '~') t = s; else e[r] = s;
    }
    s = i - 1;
  }
  return { em: e, del: t };
}

function linkInText(e, links) {
  if (!e.includes('[')) return false;
  BLOCK_SKIP.lastIndex = 0;
  for (const n of e.matchAll(BLOCK_SKIP)) {
    if (LINK_RE.test(n[0]) && e.charAt(n.index - 1) !== '!') return true;
  }
  REFLINK_SEARCH.lastIndex = 0;
  for (const n of e.matchAll(REFLINK_SEARCH)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) && !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}
function maskInline(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const n = REFLINK_SEARCH;
    const s = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const i = r.slice(1, o - 1);
        if (linkInText(i, links)) return '[' + i.replace(n, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(n, s);
  }
  t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  t = t.replace(BLOCK_SKIP, (n, s, r) => {
    const o = r ? r.length : 0;
    return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
  });
  return t;
}
function hasTag(src, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const i = CODE_SPAN_RE.exec(label.slice(s));
      if (i) { s += i[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const r = src.slice(off + s);
    const o = TAG_RE.exec(r) || AUTOLINK_RE.exec(r);
    if (o) {
      if (o[0].length > label.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

class Lexer {
  constructor() {
    this.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  }
  blockTokens(src, tokens, nested = false) {
    let s = Infinity;
    for (; src;) {
      if (src.length < s) s = src.length;
      else break;
      let r;
      if (r = this.space(src)) {
        src = src.substring(r.raw.length);
        const i = tokens.at(-1);
        if (r.raw.length === 1 && i !== undefined) i.raw += '\n';
        else tokens.push(r);
        continue;
      }
      if (r = this.code(src)) {
        src = src.substring(r.raw.length);
        const i = tokens.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
        } else tokens.push(r);
        continue;
      }
      if (r = this.fences(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.heading(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.hr(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.blockquote(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.list(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.htmlBlock(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.def(src)) {
        src = src.substring(r.raw.length);
        const i = tokens.at(-1);
        if (i?.type === 'paragraph' || i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.raw;
        } else {
          if (!this.links[r.tag]) this.links[r.tag] = { href: r.href, title: r.title };
          tokens.push(r);
        }
        continue;
      }
      if (r = this.table(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (r = this.lheading(src)) { src = src.substring(r.raw.length); tokens.push(r); continue; }
      if (this.state.top && (r = this.paragraph(src))) {
        const i = tokens.at(-1);
        if (nested && i?.type === 'paragraph') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
        } else tokens.push(r);
        nested = false;
        src = src.substring(r.raw.length);
        continue;
      }
      if (r = this.text(src)) {
        src = src.substring(r.raw.length);
        const i = tokens.at(-1);
        if (i?.type === 'text') {
          i.raw += (i.raw.endsWith('\n') ? '' : '\n') + r.raw;
          i.text += '\n' + r.text;
        } else tokens.push(r);
        continue;
      }
      break;
    }
    this.state.top = true;
    return tokens;
  }
  space(src) {
    const t = B.newline.exec(src);
    if (t && t[0].length > 0) return { type: 'space', raw: t[0] };
    return null;
  }
  code(src) {
    const t = B.code.exec(src);
    if (t) {
      const n = stripBlanks(t[0]);
      const s = n.replace(T.codeRemoveIndent, '');
      return { type: 'code', raw: n, text: s };
    }
    return null;
  }
  fences(src) {
    const t = B.fences.exec(src);
    if (t) {
      const n = t[0];
      const s = fenceIndent(n, t[3] || '');
      return { type: 'code', raw: n, lang: t[2] ? t[2].trim().replace(ANY_PUNCT, '$1') : t[2], text: s };
    }
    return null;
  }
  heading(src) {
    const t = B.heading.exec(src);
    if (t) {
      let n = t[2].trim();
      if (T.endingHash.test(n)) {
        const s = trimEnd(n, '#');
        if (!s || T.endingSpaceTabChar.test(s)) n = s.trim();
      }
      return { type: 'heading', raw: trimEnd(t[0], '\n'), depth: t[1].length, text: n };
    }
    return null;
  }
  hr(src) {
    const t = B.hr.exec(src);
    if (t) return { type: 'hr', raw: trimEnd(t[0], '\n') };
    return null;
  }

  blockquote(src) {
    const t = B.blockquote.exec(src);
    if (!t) return null;
    let n = trimEnd(t[0], '\n').split('\n');
    let s = '', r = '';
    const o = [];
    for (; n.length > 0;) {
      let i = false;
      const l = [];
      let p;
      for (p = 0; p < n.length; p++) {
        if (T.blockquoteStart.test(n[p])) { l.push(n[p]); i = true; }
        else if (!i) l.push(n[p]);
        else break;
      }
      n = n.slice(p);
      const h = l.join('\n');
      const u = h
        .replace(T.blockquoteMarkerWhitespace, (g, b, m) => b + tabExpand(m, b.length))
        .replace(T.blockquoteSetextReplace, '\n    $1')
        .replace(T.blockquoteSetextReplace2, '');
      s = s ? `${s}\n${h}` : h;
      r = r ? `${r}\n${u}` : u;
      const d = this.state.top;
      this.state.top = true;
      this.blockTokens(u, o, true);
      this.state.top = d;
      if (n.length === 0) break;
      const k = o.at(-1);
      if (k?.type === 'code' || k?.type === 'heading' || k?.type === 'hr' || k?.type === 'html' || k?.type === 'table') break;
      if (k?.type === 'blockquote') {
        const g = k;
        const b = n.join('\n');
        const m = g.raw + '\n' + b.replace(T.blockquoteSetextReplace2, '');
        const f = this.blockquote(m);
        o[o.length - 1] = f;
        const y = m.substring(f.raw.length).replace(/^\n/, '');
        const R = y ? y.split('\n').length : 0;
        const A = R ? n.slice(0, -R) : n;
        let go = false;
        if (A.length > 0) s = `${s}\n${A.join('\n')}`;
        r = r.substring(0, r.length - g.text.length) + f.text;
        n = n.slice(A.length);
        if (n.length > 0 && T.blockquoteStart.test(n[0])) go = true;
        if (go) continue;
        break;
      } else if (k?.type === 'list') {
        const g = k;
        const b = g.raw + '\n' + n.join('\n');
        const m = this.list(b);
        o[o.length - 1] = m;
        const f = m.raw.length > g.raw.length ? b.slice(g.raw.length + 1, m.raw.length).split('\n').length : 0;
        if (f > 0) {
          const y = n.slice(0, f).join('\n');
          s = `${s}\n${y}`;
          r = `${r}\n${y}`;
        }
        n = n.slice(f);
        continue;
      }
    }
    return { type: 'blockquote', raw: s, tokens: o, text: r };
  }

  list(src) {
    const t = B.list.exec(src);
    if (!t) return null;
    const n = src;
    const off = () => n.length - src.length;
    let r = t[1].trim();
    const o = r.length > 1;
    const item = { type: 'list', raw: '', ordered: o, start: o ? +r.slice(0, -1) : '', loose: false, items: [] };
    r = o ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
    const l = indentRe('item', r);
    let p = false;
    for (; src;) {
      let u = false;
      let d = '';
      const tk = l.exec(src);
      if (!tk || B.hr.test(src)) break;
      const k = off();
      src = src.substring(tk[0].length);
      const g = tk[2].split('\n', 1)[0];
      const b = tk[1].length;
      let m = g.replace(T.leadingSpaceTab, (v) => tabExpand(v, b));
      let f = src.split('\n', 1)[0];
      const y0 = !m.trim();
      let y = y0;
      let R = 0;
      if (y) R = b + 1;
      else {
        R = m.search(T.nonSpaceChar);
        R = R > 4 ? 1 : R;
        d = m.slice(R);
        R += b;
      }
      if (y && T.blankLine.test(f)) { src = src.substring(f.length + 1); u = true; }
      if (!u) {
        const v = indentRe('next', R);
        const Q = indentRe('hr', R);
        const ee = indentRe('fence', R);
        const te = indentRe('head', R);
        const M = indentRe('html', R);
        const ne = indentRe('bq', R);
        for (; src;) {
          const U = src.split('\n', 1)[0];
          f = U;
          const Z = f.replace(T.leadingSpaceTab, (me) => tabExpand(me));
          if (ee.test(f) || te.test(f) || M.test(f) || ne.test(f) || v.test(f) || Q.test(f)) break;
          if (Z.search(T.nonSpaceChar) >= R || !f.trim()) d += '\n' + Z.slice(R);
          else {
            if (y || m.replace(T.tabCharGlobal, '    ').search(T.nonSpaceChar) >= 4 || ee.test(m) || te.test(m) || M.test(m) || Q.test(m)) break;
            const qe = /^ {0,3}(?:=+|-+) *$/.test(f) && B.lheading.test(`${m}\n${f}`) ? `    ${Z.replace(/^ {0,3}/, '')}` : f;
            d += '\n' + qe;
          }
          y = !f.trim();
          src = src.substring(U.length + 1);
          m = Z.slice(R);
        }
      }
      const A = n.slice(k, off());
      if (!item.loose) {
        if (p) item.loose = true;
        else if (T.doubleBlankLine.test(A)) p = true;
      }
      item.items.push({ type: 'list_item', raw: A, task: T.listIsTask.test(d), loose: false, text: d, tokens: [] });
    }
    const h = item.items.at(-1);
    if (!h) return null;
    h.raw = h.raw.trimEnd();
    h.text = h.text.trimEnd();
    item.raw = n.slice(0, off()).trimEnd();
    for (const u of item.items) {
      this.state.top = false;
      u.tokens = this.blockTokens(u.text, []);
      if (!item.loose) {
        const d = u.tokens.filter((g) => g.type === 'space');
        const kk = d.length > 0 && d.some((g) => T.anyLine.test(g.raw));
        item.loose = kk;
      }
    }
    for (const u of item.items) {
      const d = u.tokens[0];
      if (u.task && (d?.type === 'text' || d?.type === 'paragraph')) {
        u.text = u.text.replace(T.listReplaceTask, '');
        d.raw = d.raw.replace(T.listReplaceTask, '');
        d.text = d.text.replace(T.listReplaceTask, '');
        const kk = T.listTaskCheckbox.exec(u.raw);
        if (kk) {
          const g = { type: 'checkbox', raw: kk[0] + ' ', checked: kk[0] !== '[ ]' };
          u.checked = g.checked;
          if (item.loose) {
            if (u.tokens[0] && (u.tokens[0].type === 'paragraph' || u.tokens[0].type === 'text')) {
              u.tokens[0].raw = g.raw + u.tokens[0].raw;
              u.tokens[0].checkboxFirst = g;
            } else {
              u.tokens.unshift({ type: 'paragraph', raw: g.raw, text: '', checkboxFirst: g });
            }
          } else u.tokens.unshift(g);
        }
      } else if (u.task) u.task = false;
    }
    if (item.loose) {
      for (const u of item.items) {
        u.loose = true;
        for (const d of u.tokens) if (d.type === 'text') d.type = 'paragraph';
      }
    }
    return item;
  }

  htmlBlock(src) {
    const t = B.html.exec(src);
    if (t) {
      const n = stripBlanks(t[0]);
      return { type: 'html', raw: n, pre: t[1] === 'pre' || t[1] === 'script' || t[1] === 'style', text: n };
    }
    return null;
  }
  def(src) {
    const t = DEF_RE.exec(src);
    if (t) {
      if (!T.startAngleBracket.test(t[2]) && parenBalance(t[2], '()') !== -1) return null;
      const n = normLabel(t[1]);
      const s = t[2] ? t[2].replace(T.hrefBrackets, '$1').replace(ANY_PUNCT, '$1') : '';
      const r = t[3] ? t[3].substring(1, t[3].length - 1).replace(ANY_PUNCT, '$1') : t[3];
      return { type: 'def', tag: n, raw: trimEnd(t[0], '\n'), href: s, title: r };
    }
    return null;
  }
  table(src) {
    const t = B.table.exec(src);
    if (!t || !T.tableDelimiter.test(t[2])) return null;
    const n = splitCells(t[1]);
    const s = t[2].replace(T.tableAlignChars, '').split('|');
    const r = t[3]?.trim() ? t[3].replace(T.tableRowBlankLine, '').split('\n') : [];
    const o = { type: 'table', raw: trimEnd(t[0], '\n'), header: [], align: [], rows: [] };
    if (n.length === s.length) {
      for (const i of s) {
        if (T.tableAlignRight.test(i)) o.align.push('right');
        else if (T.tableAlignCenter.test(i)) o.align.push('center');
        else if (T.tableAlignLeft.test(i)) o.align.push('left');
        else o.align.push(null);
      }
      for (let i = 0; i < n.length; i++) o.header.push({ text: n[i], align: o.align[i] });
      for (const i of r) o.rows.push(splitCells(i, o.header.length).map((l, p) => ({ text: l, align: o.align[p] })));
      return o;
    }
    return null;
  }
  lheading(src) {
    const t = B.lheading.exec(src);
    if (t) {
      const n = t[1].trim();
      return { type: 'heading', raw: trimEnd(t[0], '\n'), depth: t[2].charAt(0) === '=' ? 1 : 2, text: n };
    }
    return null;
  }
  paragraph(src) {
    const t = B.paragraph.exec(src);
    if (t) {
      const n = t[1].charAt(t[1].length - 1) === '\n' ? t[1].slice(0, -1) : t[1];
      return { type: 'paragraph', raw: t[0], text: n };
    }
    return null;
  }
  text(src) {
    const t = B.text.exec(src);
    if (t) return { type: 'text', raw: t[0], text: t[0] };
    return null;
  }
}

function checkboxHtml(g) {
  return '<input ' + (g.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}
function makeLink(lx, m, ref, raw, isImage, mode) {
  const hrefRaw = ref.href;
  const titleRaw = ref.title || null;
  const label = m[1].replace(T.outputLinkReplace, '$1');
  const p = lx.state.inLink, h = lx.state.linkEmitted, u = lx.state.inRawBlock;
  lx.state.inLink = true;
  lx.state.linkEmitted = false;
  const inner = (isImage || mode === 'text') ? inlineRender(label, 'text', lx) : inlineRender(label, 'html', lx);
  const k = lx.state.linkEmitted;
  lx.state.linkEmitted = h;
  lx.state.inLink = p;
  if (!isImage) {
    if (k) { lx.state.inRawBlock = u; return null; }
    lx.state.linkEmitted = true;
  }
  return { raw, href: hrefRaw, title: titleRaw, inner, isImage };
}
function renderLinkObj(o, autolink, displayText) {
  const disp = autolink ? esc(displayText, true) : o.inner;
  const i = encHref(o.href);
  if (i === null) return disp;
  const e = esc(i, autolink);
  let l = '<a href="' + e + '"';
  if (o.title) l += ' title="' + esc(o.title) + '"';
  return l + '>' + disp + '</a>';
}
function renderImageObj(o) {
  const r = encHref(o.href);
  if (r === null) return esc(o.inner);
  let s = `<img src="${esc(r)}" alt="${esc(o.inner)}"`;
  if (o.title) s += ` title="${esc(o.title)}"`;
  return s + '>';
}
function inlineRender(src, mode, lx) {
  const prevLPP = lx.state.linkParenPossible;
  lx.state.linkParenPossible = prevLPP && src.includes(')');
  try {
    let masked = null;
    let feCache = null;
    const needMask = src.includes('*') || src.includes('_') || src.includes('~');
    if (needMask) masked = maskInline(src, lx.links);
    const getFe = () => {
      if (!feCache) feCache = scanDelims(masked);
      return feCache;
    };
    let out = '';
    let e = src;
    let s = false, r = '';
    let o = Infinity;
    while (e) {
      if (e.length < o) o = e.length;
      else throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      if (!s) r = '';
      s = false;
      let html = null;
      let rawLen = 0;
      let m;
      if ((m = ESCAPE_RE.exec(e))) {
        rawLen = m[0].length;
        html = mode === 'text' ? m[1] : esc(m[1]);
      } else if ((m = TAG_RE.exec(e))) {
        rawLen = m[0].length;
        if (!lx.state.inLink && T.startATag.test(m[0])) lx.state.inLink = true;
        else if (lx.state.inLink && T.endATag.test(m[0])) lx.state.inLink = false;
        if (!lx.state.inRawBlock && T.startPreScriptTag.test(m[0])) lx.state.inRawBlock = true;
        else if (lx.state.inRawBlock && T.endPreScriptTag.test(m[0])) lx.state.inRawBlock = false;
        html = m[0];
      } else if (lx.state.linkParenPossible !== false && (m = LINK_RE.exec(e))) {
        const obj = linkTok(lx, m, mode);
        if (obj) { rawLen = obj.raw.length; html = obj.isImage ? (mode === 'text' ? obj.inner : renderImageObj(obj)) : (mode === 'text' ? obj.inner : renderLinkObj(obj, false)); }
      }
      if (html === null && rawLen === 0) {
        const rl = reflinkTok(lx, e, mode);
        if (rl) {
          if (rl.miss) { out += rl.miss; e = e.substring(1); continue; }
          rawLen = rl.raw.length;
          html = rl.isImage ? (mode === 'text' ? rl.inner : renderImageObj(rl)) : (mode === 'text' ? rl.inner : renderLinkObj(rl, false));
        }
      }
      if (html === null && rawLen === 0 && needMask) {
        const em = emStrongTok(lx, e, masked, r, getFe, mode);
        if (em) { rawLen = em.raw.length; html = em.html; }
      }
      if (html === null && rawLen === 0 && (m = CODE_SPAN_RE.exec(e))) {
        rawLen = m[0].length;
        let n = m[2].replace(T.newLineCharGlobal, ' ');
        const hasNonSpace = T.nonSpaceChar.test(n);
        if (hasNonSpace && T.startingSpaceChar.test(n) && T.endingSpaceChar.test(n)) n = n.substring(1, n.length - 1);
        html = mode === 'text' ? n : `<code>${esc(n, true)}</code>`;
      }
      if (html === null && rawLen === 0 && (m = BR_RE.exec(e))) {
        rawLen = m[0].length;
        html = mode === 'text' ? '' : '<br>';
      }
      if (html === null && rawLen === 0 && needMask) {
        const d = delTok(lx, e, masked, r, getFe, mode);
        if (d) { rawLen = d.raw.length; html = d.html; }
      }
      if (html === null && rawLen === 0 && (m = AUTOLINK_RE.exec(e))) {
        rawLen = m[0].length;
        let n, s2;
        if (m[2] === '@') { n = m[1]; s2 = 'mailto:' + n; }
        else { n = m[1]; s2 = n; }
        html = mode === 'text' ? n : renderLinkObj({ href: s2, title: null, inner: n }, true, n);
      }
      if (html === null && rawLen === 0 && !lx.state.inLink && (m = URL_RE.exec(e))) {
        rawLen = m[0].length;
        let n, s2;
        if (m[2] === '@') { n = m[0]; s2 = 'mailto:' + n; }
        else {
          let rr = m[0];
          let t2 = m[0];
          do { rr = t2; t2 = BACKPEDAL.exec(t2)?.[0] ?? ''; } while (rr !== t2);
          n = t2;
          rawLen = t2.length;
          s2 = m[1] === 'www.' ? 'http://' + t2 : t2;
        }
        html = mode === 'text' ? n : renderLinkObj({ href: s2, title: null, inner: n }, true, n);
      }
      if (html === null && rawLen === 0) {
        const tx = TEXT_RE.exec(e);
        if (tx) {
          rawLen = tx[0].length;
          if (tx[0].slice(-1) !== '_') r = tx[0].slice(-1);
          s = true;
          out += mode === 'text' ? (lx.state.inRawBlock ? tx[0] : unesc(tx[0])) : (lx.state.inRawBlock ? tx[0] : esc(unesc(tx[0])));
          e = e.substring(rawLen);
          continue;
        }
        throw new Error('Infinite loop on byte: ' + e.charCodeAt(0));
      }
      e = e.substring(rawLen);
      out += html;
    }
    return out;
  } finally {
    lx.state.linkParenPossible = prevLPP;
  }
}

function linkTok(lx, t, mode) {
  const bang = t[0].charAt(0) === '!';
  const n = bang ? 2 : 1;
  if (hasTag(t.input, t[1], n)) return null;
  let s = t[2].trim();
  if (T.startAngleBracket.test(s)) {
    if (!T.endAngleBracket.test(s)) return null;
    const l = trimEnd(s.slice(0, -1), '\\');
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = parenBalance(t[2], '()');
    if (l === -2) return null;
    if (l > -1) {
      const h = (bang ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = '';
    }
  }
  const r = trimEnd(t[0].slice(0, -1), '\\');
  if ((t[0].length - r.length) % 2 === 0) return null;
  let o = t[2];
  let i = '';
  if (t[3]) i = t[3].slice(1, -1);
  o = o.trim();
  if (T.startAngleBracket.test(o)) o = o.slice(1, -1);
  return makeLink(lx, t, {
    href: o && o.replace(ANY_PUNCT, '$1'),
    title: i && i.replace(ANY_PUNCT, '$1'),
  }, t[0], bang, mode);
}
function reflinkTok(lx, e, mode) {
  let m = REFLINK_RE.exec(e) || NOLINK_RE.exec(e);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!';
  const n = bang ? 2 : 1;
  if (hasTag(e, m[1], n)) return null;
  const ref = lx.links[normLabel(m[2] || m[1])];
  if (!ref) return { miss: m[0].charAt(0) };
  return makeLink(lx, m, ref, m[0], bang, mode);
}

function emStrongTok(lx, e, masked, prevChar, getFe, mode) {
  const s = EM_STRONG_L_GFM.exec(e);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const isPrevSame = prevChar === r;
  const i = masked.length - e.length;
  let l = i;
  for (; l > 0 && masked[l - 1] === r;) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || !!PUNCT_RE.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!PUNCT_RE.exec(n);
  if (s[4] && n.match(T.unicodeAlphaNumeric)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? EM_STRONG_R_AST : EM_STRONG_R_UND;
    const v = getFe().em[r];
    const Q = masked.length - e.length + k;
    if (v < Q) return null;
    const t2 = masked.slice(-e.length + k);
    const ee = v - Q;
    let g, b;
    A.lastIndex = 0;
    let sm;
    while ((sm = A.exec(t2)) !== null && !(sm.index > ee)) {
      g = sm[1] || sm[2] || sm[3] || sm[4] || sm[5] || sm[6];
      if (!g) continue;
      b = [...g].length;
      if (sm[3] || sm[4]) { m += b; continue; }
      else if (sm[5] || sm[6] || R) {
        if (isPrevSame && (sm[5] || sm[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...sm[0]][0].length;
      const M = e.slice(0, k + sm.index + te + b);
      if (Math.min(k, b) % 2) {
        const U = M.slice(1, -1);
        return { raw: M, html: mode === 'text' ? inlineRender(U, 'text', lx) : `<em>${inlineRender(U, 'html', lx)}</em>` };
      }
      const ne = M.slice(2, -2);
      return { raw: M, html: mode === 'text' ? inlineRender(ne, 'text', lx) : `<strong>${inlineRender(ne, 'html', lx)}</strong>` };
    }
  }
  return null;
}

function delTok(lx, e, masked, prevChar, getFe, mode) {
  const s0 = DEL_L.exec(e);
  if (!s0) return null;
  if (!(s0[1] || '') || !prevChar || PUNCT_RE.exec(prevChar)) {
    const o = [...s0[0]].length - 1;
    let p = o;
    const u = getFe().del;
    const d = masked.length - e.length + o;
    if (u < d) return null;
    const t2 = masked.slice(-e.length + o);
    const k = u - d;
    DEL_R.lastIndex = 0;
    let s;
    while ((s = DEL_R.exec(t2)) !== null && !(s.index > k)) {
      const i = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!i) continue;
      let l = [...i].length;
      if (l !== o) continue;
      if (s[3] || s[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const g = [...s[0]][0].length;
      const b = e.slice(0, o + s.index + g + l);
      const m = b.slice(o, -o);
      return { raw: b, html: mode === 'text' ? inlineRender(m, 'text', lx) : `<del>${inlineRender(m, 'html', lx)}</del>` };
    }
  }
  return null;
}

function renderTokens(tokens, lx) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'space':
      case 'def':
        break;
      case 'code': {
        const s = (t.lang || '').match(T.notSpaceStart)?.[0] ?? '';
        const r = t.text ? t.text.replace(T.endingNewline, '') + '\n' : '';
        out += s
          ? `<pre><code class="language-${esc(s)}">${esc(r, true)}</code></pre>\n`
          : `<pre><code>${esc(r, true)}</code></pre>\n`;
        break;
      }
      case 'heading':
        out += `<h${t.depth}>${inlineRender(t.text, 'html', lx)}</h${t.depth}>\n`;
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderTokens(t.tokens, lx)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const st = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
        let s = '';
        for (const it of t.items) s += `<li>${renderTokens(it.tokens, lx)}</li>\n`;
        out += `<${tag}${st}>\n${s}</${tag}>\n`;
        break;
      }
      case 'checkbox':
        out += checkboxHtml(t);
        break;
      case 'html':
        out += t.text;
        break;
      case 'paragraph': {
        let inner = '';
        if (t.checkboxFirst) inner += checkboxHtml(t.checkboxFirst);
        inner += inlineRender(t.text, 'html', lx);
        out += `<p>${inner}</p>\n`;
        break;
      }
      case 'text': {
        let inner = '';
        if (t.checkboxFirst) inner += checkboxHtml(t.checkboxFirst);
        inner += inlineRender(t.text, 'html', lx);
        out += inner;
        break;
      }
      case 'table': {
        let n = '';
        for (let i = 0; i < t.header.length; i++) {
          const c = t.header[i];
          n += (c.align ? `<th align="${c.align}">` : '<th>') + inlineRender(c.text, 'html', lx) + '</th>\n';
        }
        let s = '';
        for (const row of t.rows) {
          let cc = '';
          for (const c of row) cc += (c.align ? `<td align="${c.align}">` : '<td>') + inlineRender(c.text, 'html', lx) + `</td>\n`;
          s += `<tr>\n${cc}</tr>\n`;
        }
        if (s) s = `<tbody>${s}</tbody>`;
        out += `<table>\n<thead>\n<tr>\n${n}</tr>\n</thead>\n${s}</table>\n`;
        break;
      }
      default:
        throw new Error(`Token with "${t.type}" type was not found.`);
    }
  }
  return out;
}
export function parse(markdown) {
  const src = markdown.replace(T.carriageReturn, '\n');
  const lx = new Lexer();
  const tokens = lx.blockTokens(src, []);
  return renderTokens(tokens, lx);
}
