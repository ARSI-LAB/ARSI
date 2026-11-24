export type ProgressMode = 'auto' | 'tty' | 'plain';
export type ResolvedProgressMode = 'tty' | 'plain';

export interface ProgressStream {
  readonly isTTY: boolean;
  readonly columns?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
  write(chunk: string): void;
}

export interface StylePalette {
  dim(text: string): string;
  bold(text: string): string;
  green(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
}

export interface TerminalRenderer {
  readonly mode: ResolvedProgressMode;
  readonly style: StylePalette;
  printMilestone(lines: readonly string[]): void;
  setStatus(lines: readonly string[]): void;
  finish(summaryLines: readonly string[]): void;
}

// Match CSI ANSI escape sequences (colors, cursor movement, etc.).
const ansiCsiPattern = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const sgrPattern = /\x1b\[[0-9;]*m/g;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const emojiPresentation = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F|\u20E3/u;
const zeroWidth = /[\p{Mark}\p{Default_Ignorable_Code_Point}]/u;
const defaultColumns = 80;

function isDumbTerm(env: ProgressStream['env']): boolean {
  return env?.TERM?.trim().toLowerCase() === 'dumb';
}

function isCI(env: ProgressStream['env']): boolean {
  const value = env?.CI?.trim().toLowerCase();
  return Boolean(value && value !== '0' && value !== 'false');
}

export function isInteractiveTTY(stream: ProgressStream): boolean {
  return stream.isTTY && !isDumbTerm(stream.env) && !isCI(stream.env);
}

export function resolveProgressMode(
  mode: ProgressMode,
  stream: ProgressStream,
): ResolvedProgressMode {
  if (mode === 'tty' || mode === 'plain') return mode;
  return isInteractiveTTY(stream) ? 'tty' : 'plain';
}

export function supportsColor(
  stream: ProgressStream,
  mode: ResolvedProgressMode,
): boolean {
  if (mode !== 'tty') return false;
  if (isDumbTerm(stream.env)) return false;
  // Per no-color.org, any non-empty NO_COLOR disables ANSI colors.
  if (stream.env?.NO_COLOR) return false;
  return true;
}

export function sanitizeText(value: string): string {
  return value
    .replace(ansiCsiPattern, '')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function codePointWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x16fe0 && cp <= 0x18dff) ||
    (cp >= 0x1aff0 && cp <= 0x1b2ff) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function graphemeWidth(text: string): number {
  if (emojiPresentation.test(text)) return 2;
  let width = 0;
  for (const char of text) {
    if (zeroWidth.test(char)) continue;
    const cp = char.codePointAt(0)!;
    // Hangul medial vowels and trailing consonants join the initial glyph.
    if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff))
      continue;
    width += codePointWidth(cp);
  }
  return width;
}

export function truncateVisible(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  const display = text.replace(sgrPattern, '');
  let visible = 0;
  let cutoff = 0;
  for (const { segment, index } of graphemes.segment(display)) {
    visible += graphemeWidth(segment);
    if (visible > maxWidth) break;
    if (visible <= maxWidth - 1) cutoff = index + segment.length;
  }
  if (visible <= maxWidth) return text;

  // Map the grapheme boundary back into the styled source string.
  let end = cutoff;
  for (const match of text.matchAll(sgrPattern)) {
    if (match.index >= end) break;
    end += match[0].length;
  }
  return `${text.slice(0, end)}…${end > cutoff ? '\x1b[0m' : ''}`;
}

export function createPalette(useColor: boolean): StylePalette {
  const wrap = (code: string) =>
    useColor
      ? (text: string): string => `\x1b[${code}m${text}\x1b[0m`
      : (text: string): string => text;
  return {
    dim: wrap('2'),
    bold: wrap('1'),
    green: wrap('32'),
    red: wrap('31'),
    yellow: wrap('33'),
    cyan: wrap('36'),
  };
}

export function createTerminalRenderer(
  stream: ProgressStream,
  mode: ResolvedProgressMode,
): TerminalRenderer {
  const style = createPalette(supportsColor(stream, mode));
  let renderedLines = 0;
  let lastStatusText = '';
  let currentStatusLines: readonly string[] = [];
  let closed = false;

  function write(chunk: string): void {
    try {
      stream.write(chunk);
    } catch {
      closed = true;
    }
  }

  function maxStatusWidth(): number {
    const width = stream.columns;
    const columns = width && width > 0 ? width : defaultColumns;
    // Keep a 1-column margin so terminals never soft-wrap sticky status lines.
    return Math.max(0, Math.floor(columns) - 1);
  }

  function clearSequence(): string {
    if (renderedLines === 0) return '';
    if (renderedLines === 1) return '\r\x1b[J';
    return `\r\x1b[${renderedLines - 1}A\x1b[J`;
  }

  function formatStatusBlock(lines: readonly string[]): {
    text: string;
    count: number;
  } {
    if (lines.length === 0) return { text: '', count: 0 };
    const limit = maxStatusWidth();
    if (limit === 0) return { text: '', count: 0 };
    const fitted = lines.map((line) => truncateVisible(line, limit));
    return { text: fitted.join('\n'), count: fitted.length };
  }

  if (mode === 'plain') {
    return {
      mode,
      style,
      printMilestone(lines) {
        if (closed || lines.length === 0) return;
        write(lines.join('\n') + '\n');
      },
      setStatus() {
        // Plain mode is strictly append-only; ephemeral status updates are omitted.
      },
      finish(summaryLines) {
        if (closed) return;
        closed = true;
        if (summaryLines.length > 0) write(summaryLines.join('\n') + '\n');
      },
    };
  }

  return {
    mode,
    style,
    printMilestone(lines) {
      if (closed || lines.length === 0) return;
      const clear = clearSequence();
      const status = formatStatusBlock(currentStatusLines);
      const milestoneBlock = lines.join('\n') + '\n';
      write(`${clear}${milestoneBlock}${status.text}`);
      renderedLines = status.count;
      lastStatusText = status.text;
    },
    setStatus(lines) {
      if (closed) return;
      currentStatusLines = lines;
      const status = formatStatusBlock(lines);
      if (status.text === lastStatusText && status.count === renderedLines)
        return;
      const clear = clearSequence();
      if (clear || status.text) write(`${clear}${status.text}`);
      renderedLines = status.count;
      lastStatusText = status.text;
    },
    finish(summaryLines) {
      if (closed) return;
      closed = true;
      const clear = clearSequence();
      renderedLines = 0;
      lastStatusText = '';
      currentStatusLines = [];
      const summary =
        summaryLines.length > 0 ? summaryLines.join('\n') + '\n' : '';
      if (clear || summary) write(`${clear}${summary}`);
    },
  };
}
