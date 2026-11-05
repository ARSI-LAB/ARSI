import type { CallTrace } from '../../../src/contracts/observation.js';

export interface TraceRow {
  id: string;
  step: number;
  kind: 'model' | 'tool' | 'event';
  title: string;
  summary: string;
  status: string;
  at: string | null;
  duration: number | null;
  thinking?: string;
  body?: string;
  args?: unknown;
  result?: unknown;
  truncated: boolean;
}
export function eventObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
export function eventText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map(eventText).filter(Boolean).join('\n\n');
  const item = eventObject(value);
  return typeof item.text === 'string'
    ? item.text
    : item.content
      ? eventText(item.content)
      : '';
}
/** Pair tools by their recorded ID, never by name or adjacency. */
export function traceRows(events: CallTrace['items']): TraceRow[] {
  const rows: TraceRow[] = [];
  const tools = new Map<string, TraceRow>();
  let step = 0;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    let data: Record<string, unknown>;
    try {
      data = eventObject(JSON.parse(event.content?.text ?? '{}'));
    } catch {
      rows.push({
        id: String(event.sequence),
        step,
        kind: 'event',
        title: 'Incomplete event',
        summary: 'Recorded preview is truncated',
        status: 'Unavailable',
        at: event.at,
        duration: null,
        truncated: true,
      });
      continue;
    }
    const row: TraceRow = {
      id: String(event.sequence),
      step,
      kind: 'event',
      title: event.type.replaceAll('_', ' '),
      summary: '',
      status: 'Recorded',
      at: event.at,
      duration: null,
      truncated: !!event.content?.truncated,
    };
    if (event.type === 'message_end') {
      step++;
      const message = eventObject(data.message);
      const blocks = Array.isArray(message.content)
        ? message.content.map(eventObject)
        : [];
      const thinking = blocks
        .filter((b) => b.type === 'thinking')
        .map((b) => (typeof b.thinking === 'string' ? b.thinking : ''))
        .filter(Boolean)
        .join('\n\n');
      const body = blocks.length
        ? blocks
            .filter((b) => b.type === 'text')
            .map(eventText)
            .join('\n\n')
        : eventText(data.message);
      row.step = step;
      row.kind = 'model';
      row.title = body ? 'Response' : thinking ? 'Thinking' : 'Model';
      row.thinking = thinking;
      row.body = body;
      row.summary = body || thinking || 'Tool calls';
      row.status = 'Completed';
      if (
        !body &&
        !thinking &&
        blocks.some((b) => b.type === 'toolCall') &&
        !row.truncated
      )
        continue;
    } else if (event.type.startsWith('tool_execution')) {
      const key = typeof data.toolCallId === 'string' ? data.toolCallId : null;
      const previous = key ? tools.get(key) : undefined;
      const target =
        event.type === 'tool_execution_end' && previous ? previous : row;
      target.kind = 'tool';
      target.title = typeof data.toolName === 'string' ? data.toolName : 'Tool';
      if (event.type === 'tool_execution_start') {
        target.args = data.args;
        target.status = 'Result not loaded';
        if (key) tools.set(key, target);
      } else {
        target.result = data.result;
        target.status = data.isError === true ? 'Failed' : 'Succeeded';
        if (previous && previous.at && event.at) {
          const ms = Date.parse(event.at) - Date.parse(previous.at);
          if (Number.isFinite(ms) && ms >= 0) target.duration = ms / 1000;
        }
        if (key) tools.delete(key);
      }
      target.truncated ||= row.truncated;
      const args = eventObject(target.args);
      target.summary =
        typeof args.path === 'string'
          ? args.path
          : typeof args.command === 'string'
            ? args.command
            : target.args !== undefined
              ? JSON.stringify(target.args)
              : eventText(data.result) || 'Recorded result';
      if (target === previous) continue;
    } else {
      row.body = eventText(data.response) || eventText(data.message);
      row.summary = row.body || 'Execution event';
      if (event.type === 'error' || event.type === 'validation_failed')
        row.status = 'Failed';
    }
    rows.push(row);
  }
  return rows;
}
