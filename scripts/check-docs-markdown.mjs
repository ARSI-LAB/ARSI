import path from 'node:path';

// Collect document structure and link targets while preserving source offsets for
// diagnostics and link-only edits. Code examples (including Markdown examples)
// must never contribute headings, links, or named anchors.
export function parseMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  const links = [];
  const anchors = new Set();
  const slugs = new Set();
  const blocks = [];
  const prose = [...lines];
  let fence;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      prose[i] = '';
      const close = /^ {0,3}(\x60+|~+)\s*$/.exec(line);
      if (
        close &&
        close[1][0] === fence.marker[0] &&
        close[1].length >= fence.marker.length
      ) {
        blocks.push({ ...fence, code: lines.slice(fence.line, i).join('\n') });
        fence = undefined;
      }
      continue;
    }
    const open = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      fence = { marker: open[1], info: open[2].trim(), line: i + 1 };
      prose[i] = '';
    }
  }
  if (fence)
    blocks.push({ ...fence, code: lines.slice(fence.line).join('\n') });

  for (let i = 0; i < prose.length; i++) {
    const raw = prose[i];
    const visible = raw.replace(/(\x60+)(?!\x60)(.*?)\1(?!\x60)/g, (match) =>
      ' '.repeat(match.length),
    );
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(raw);
    const setext =
      i > 0 && prose[i - 1].trim() && /^ {0,3}(=+|-+)\s*$/.exec(raw);
    const htmlHeading = /<h([1-6])(?:\s[^>]*)?>/i.exec(visible);
    if (atx || setext || htmlHeading) {
      const level = atx
        ? atx[1].length
        : setext
          ? setext[1][0] === '='
            ? 1
            : 2
          : Number(htmlHeading[1]);
      const heading = atx
        ? (atx[2] ?? '').replace(/\s+#+\s*$/, '')
        : setext
          ? prose[i - 1]
          : raw;
      headings.push({ level, line: setext ? i : i + 1 });
      const slug = heading
        .trim()
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/[^\p{L}\p{M}\p{N}_\s-]/gu, '')
        .replace(/ /g, '-');
      let unique = slug;
      for (let n = 1; slugs.has(unique); n++) unique = slug + '-' + n;
      slugs.add(unique);
      anchors.add(unique);
    }
    for (const tag of visible.matchAll(/<[A-Za-z][\w:-]*(?=[\s>])[^>]*>/g)) {
      for (const attr of tag[0].matchAll(
        /\s(href|src|id|name)\s*=\s*(["'])(.*?)\2/gi,
      )) {
        const value = attr[3];
        if (/^(id|name)$/i.test(attr[1])) anchors.add(value);
        else {
          const start = tag.index + attr.index + attr[0].indexOf(attr[2]) + 1;
          links.push({ value, start, line: i + 1 });
        }
      }
    }
    // Markdown inline links/images and reference definitions share the same
    // destination grammar: angle-bracket paths or unquoted balanced parentheses.
    for (const marker of visible.matchAll(
      /(?<!\\)\]\(\s*|^ {0,3}\[[^\]]+\]:[ \t]*/g,
    )) {
      let start = marker.index + marker[0].length;
      let end = start;
      if (raw[start] === '<') {
        start++;
        end = raw.indexOf('>', start);
        if (end < 0) continue;
      } else {
        let depth = 0;
        while (end < raw.length && !/\s/.test(raw[end])) {
          if (raw[end] === '\\' && end + 1 < raw.length) {
            end += 2;
            continue;
          }
          if (raw[end] === '(') depth++;
          if (raw[end] === ')' && depth-- === 0) break;
          end++;
        }
      }
      const value = raw.slice(start, end);
      if (value) links.push({ value, start, line: i + 1 });
    }
  }
  return { headings, links, anchors, blocks };
}

export function relativeTarget(file, value) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return undefined;
  const [url, fragment = ''] = value.split(/#(.*)/s);
  const pathname = decodeURIComponent(url.split('?')[0]).replace(
    /\\([() ])/g,
    '$1',
  );
  const target = pathname.startsWith('/')
    ? pathname.slice(1)
    : pathname
      ? path.posix.join(path.posix.dirname(file), pathname)
      : file;
  return {
    target: path.posix.normalize(target),
    fragment: decodeURIComponent(fragment),
  };
}

// Replace only relative destination text, preserving link labels, Markdown
// structure, and all other prose byte-for-byte (except line-ending convention).
export function historicalProse(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const { links } = parseMarkdown(text);
  for (const { value, start, line } of links.reverse()) {
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) continue;
    lines[line - 1] =
      lines[line - 1].slice(0, start) +
      '<relative-target>' +
      lines[line - 1].slice(start + value.length);
  }
  return lines.join('\n');
}
