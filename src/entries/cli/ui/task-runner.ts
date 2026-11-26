import ora from 'ora';
import stringWidth from 'string-width';
import { formatDuration } from '../../../shared/call-log.js';
import {
  formatCargoLine,
  formatLogLine,
  type CliLogging,
  type RunningTask,
} from '../logging/index.js';

const segmenter = new Intl.Segmenter();

function fitLine(text: string, width: number): string {
  if (width < 1) return '';
  if (stringWidth(text) <= width) return text;
  let result = '';
  let remaining = width - 1;
  for (const { segment } of segmenter.segment(text)) {
    const columns = stringWidth(segment);
    if (columns > remaining) break;
    remaining -= columns;
    result += segment;
  }
  return `${result.trimEnd()}…`;
}

export async function runWithSpinner<T>(
  logging: CliLogging,
  execute: () => Promise<T>,
  stream: NodeJS.WritableStream &
    Pick<
      NodeJS.WriteStream,
      'isTTY' | 'columns' | 'cursorTo' | 'clearLine' | 'moveCursor'
    > = process.stderr,
): Promise<T> {
  let task: RunningTask | undefined;
  // Reserve the spinner glyph, its space and the last terminal column.
  const available = (): number => Math.max(0, (stream.columns || 80) - 3);
  const duration = (): string =>
    task ? `· ${formatDuration(Math.max(0, Date.now() - task.startedAt))}` : '';
  const spinner = ora({
    stream,
    isEnabled: Boolean(stream.isTTY),
    discardStdin: false,
    suffixText: () =>
      fitLine(duration(), available() - stringWidth(spinner.text) - 1),
  });
  const refreshText = (): void => {
    if (!task || !spinner.isEnabled) return;
    const width = available();
    // Leave room for the timer to grow across its usual digit changes.
    const timer = Math.min(
      Math.max(8, stringWidth(duration())),
      Math.floor(width / 2),
    );
    const detail = task.detail ? ` · ${task.detail}` : '';
    spinner.text = fitLine(`Running ${task.label}${detail}`, width - timer - 1);
  };
  stream.on('resize', refreshText);
  const restore = logging.takeTerminal(
    (record, mode) => {
      // Ora redraws below writes to its stream while it is spinning.
      stream.write(
        mode === 'spring'
          ? formatLogLine(record, true)
          : formatCargoLine(record, stream),
      );
    },
    (next) => {
      if (next === task) return;
      task = next;
      if (task && spinner.isEnabled) {
        refreshText();
        if (!spinner.isSpinning) spinner.start();
      } else if (spinner.isSpinning) spinner.stop();
    },
  );
  try {
    return await execute();
  } finally {
    stream.off('resize', refreshText);
    if (spinner.isSpinning) spinner.stop();
    restore();
  }
}
