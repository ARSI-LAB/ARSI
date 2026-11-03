import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { Parser } from 'htmlparser2';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  ArtifactStore,
  JsonObject,
  JsonValue,
} from '../../contracts/index.js';
import { parseFileTree } from '../../contracts/index.js';
import { string } from '../../shared/json.js';
import { fullEvidenceText } from '../../runtime/services/facts/evidence.js';

const maxSourceBytes = 8 * 1024 * 1024;
const maxPreviewBytes = 2 * 1024 * 1024;
const maxCells = 20000;
const maxPages = 50;

interface Extracted {
  text: string;
  locations: JsonValue[];
  omissions: string[];
}

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function safe(value: string): string {
  return fullEvidenceText(value, 'text').text;
}

function safeValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return safe(value);
  if (Array.isArray(value)) return value.map(safeValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, safeValue(item)]),
    );
  return value;
}

function cachedFormulaResult(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  )
    return value;
  if (value instanceof Date)
    return { type: 'date', value: value.toISOString() };
  if (
    typeof value === 'object' &&
    'error' in value &&
    typeof value.error === 'string'
  )
    return { error: value.error };
  throw new Error('Unsupported cached Excel formula result type');
}

async function excel(bytes: Buffer, signal: AbortSignal): Promise<Extracted> {
  const workbook = new ExcelJS.Workbook();
  // ExcelJS declares its input as ArrayBuffer; supply an owned exact byte range.
  await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  signal.throwIfAborted();
  const lines: string[] = [];
  const locations: JsonValue[] = [];
  const omissions: string[] = [];
  let count = 0;
  for (const sheet of workbook.worksheets) {
    signal.throwIfAborted();
    lines.push(`Worksheet ${JSON.stringify(sheet.name)}`);
    locations.push({ worksheet: sheet.name, range: sheet.dimensions.range });
    for (let row = 1; row <= sheet.rowCount; row++) {
      for (let column = 1; column <= sheet.columnCount; column++) {
        signal.throwIfAborted();
        if (++count > maxCells) {
          omissions.push(
            `Cell extraction stopped at ${maxCells} cells; later cells and worksheets omitted.`,
          );
          return { text: lines.join('\n'), locations, omissions };
        }
        const cell = sheet.getCell(row, column);
        const value = cell.value;
        let description: JsonObject;
        if (
          cell.type === ExcelJS.ValueType.Formula &&
          value &&
          typeof value === 'object'
        ) {
          const result = 'result' in value ? value.result : undefined;
          description = {
            type: 'formula',
            formula: ('formula' in value ? value.formula : cell.formula) ?? '',
            savedResult: cachedFormulaResult(result),
            savedResultType:
              result === undefined
                ? 'missing'
                : result instanceof Date
                  ? 'date'
                  : result !== null &&
                      typeof result === 'object' &&
                      'error' in result
                    ? 'error'
                    : typeof result,
            savedResultStatus: result === undefined ? 'missing' : 'available',
          };
        } else if (value === null || value === undefined) {
          description = { type: 'blank', value: null };
        } else if (value instanceof Date) {
          description = { type: 'date', value: value.toISOString() };
        } else {
          description = {
            type:
              typeof value === 'object'
                ? ExcelJS.ValueType[cell.type]
                : typeof value,
            value: typeof value === 'object' ? cell.text : value,
          };
        }
        lines.push(`${cell.address} ${JSON.stringify(description)}`);
      }
    }
  }
  return { text: lines.join('\n'), locations, omissions };
}

async function word(bytes: Buffer, signal: AbortSignal): Promise<Extracted> {
  const result = await mammoth.convertToHtml(
    { buffer: bytes },
    {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    },
  );
  signal.throwIfAborted();
  const lines: string[] = [];
  const locations: JsonValue[] = [];
  let paragraph = 0;
  let table = 0;
  const tables: { table: number; row: number; cell: number }[] = [];
  const lists: { kind: string; item: number }[] = [];
  const blocks: { name: string; location: JsonObject; text: string }[] = [];
  const flush = (): void => {
    const block = blocks.at(-1);
    if (!block?.text.trim()) return;
    locations.push({ ...block.location });
    const position = Object.entries(block.location)
      .map(([key, value]) => `${key}:${value}`)
      .join(' ');
    lines.push(`${position} ${JSON.stringify(block.text)}`);
    block.text = '';
  };
  const parser = new Parser({
    onopentag(name, attributes) {
      signal.throwIfAborted();
      if (name === 'table') {
        flush();
        tables.push({ table: ++table, row: 0, cell: 0 });
      }
      const currentTable = tables.at(-1);
      if (name === 'tr' && currentTable) {
        currentTable.row++;
        currentTable.cell = 0;
      }
      if (name === 'ul' || name === 'ol') {
        const start = Number(attributes.start ?? 1);
        lists.push({
          kind: name === 'ol' ? 'ordered' : 'bullet',
          item: Number.isSafeInteger(start) ? start - 1 : 0,
        });
      }
      if (
        name === 'td' ||
        name === 'th' ||
        name === 'li' ||
        name === 'p' ||
        /^h[1-6]$/.test(name)
      ) {
        // Flush parents before nested blocks so list text is neither lost nor reordered.
        flush();
        if ((name === 'td' || name === 'th') && currentTable)
          currentTable.cell++;
        const location: JsonObject = currentTable
          ? { ...currentTable }
          : { paragraph: ++paragraph };
        const list = lists.at(-1);
        if (name === 'li' && list) {
          location.list = list.kind;
          location.listLevel = lists.length;
          location.item = ++list.item;
        }
        blocks.push({ name, location, text: '' });
      }
      if (name === 'br' && blocks.length) blocks.at(-1)!.text += '\n';
    },
    ontext(value) {
      if (blocks.length) blocks.at(-1)!.text += value;
    },
    onclosetag(name) {
      if (blocks.at(-1)?.name === name) {
        flush();
        blocks.pop();
      }
      if (name === 'table') tables.pop();
      if (name === 'ul' || name === 'ol') lists.pop();
    },
  });
  parser.write(result.value);
  parser.end();
  return {
    text: lines.join('\n'),
    locations,
    omissions: [
      'Paragraph/table positions preserve extraction order; document pagination and visual layout are unavailable. Images are not inspected.',
      ...result.messages.map(
        (message) =>
          `Parser ${message.type}: ${safe(message.message).replace(/[A-Za-z]:[\\/][^\s]+/g, '[host-path]')}`,
      ),
    ],
  };
}

async function pdf(bytes: Buffer, signal: AbortSignal): Promise<Extracted> {
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    standardFontDataUrl: fileURLToPath(
      new URL(
        '../../standard_fonts/',
        import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),
      ),
    ).replaceAll('\\', '/'),
  });
  const abort = (): void => {
    void task.destroy();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const document = await task.promise;
    const lines: string[] = [];
    const locations: JsonValue[] = [];
    const omissions: string[] = [];
    for (
      let pageNumber = 1;
      pageNumber <= Math.min(document.numPages, maxPages);
      pageNumber++
    ) {
      signal.throwIfAborted();
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) =>
          'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '',
        )
        .join('')
        .trim();
      lines.push(
        `Page ${pageNumber}\n${text || '[No extractable text; this page may be empty or image-only. OCR was not performed.]'}`,
      );
      locations.push({ page: pageNumber, extractableText: !!text });
      page.cleanup();
    }
    if (document.numPages > maxPages)
      omissions.push(
        `Pages ${maxPages + 1}-${document.numPages} omitted by the page bound.`,
      );
    return { text: lines.join('\n\n'), locations, omissions };
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy();
  }
}

/** Only Runtime-selected execution/delivery descriptors may enter this private path. */
export async function prepareDocumentPreviews(options: {
  sources: JsonObject[];
  files: JsonObject;
  artifacts: ArtifactStore;
  signal: AbortSignal;
}): Promise<JsonObject[]> {
  const previews: JsonObject[] = [];
  let remaining =
    32 * 1024 * 1024 -
    Object.values(options.files).reduce<number>(
      (total, value) =>
        total + (typeof value === 'string' ? Buffer.byteLength(value) : 0),
      0,
    );
  for (const source of options.sources) {
    options.signal.throwIfAborted();
    if (!['execution', 'delivery'].includes(String(source.access)))
      throw new Error(
        'Reflection document source is not authorized execution or delivery evidence',
      );
    const originalPath = string(source.path);
    const record: JsonObject = {
      source: {
        artifactRef: source.artifactRef ?? null,
        path: safe(originalPath),
        pointer: source.pointer ?? null,
        associations: safeValue(source.associations ?? []),
      },
      inspection: 'unavailable',
      locations: [],
      omissions: [],
    };
    previews.push(record);
    const textPath =
      typeof source.textPath === 'string' ? source.textPath : undefined;
    const reusableText =
      textPath === undefined ? undefined : options.files[textPath];
    if (textPath !== undefined && typeof reusableText === 'string') {
      record.inspection = 'complete';
      record.path = textPath;
      record.reusedText = true;
      record.locations = safeValue(source.locations ?? []);
      record.omissions = safeValue(source.omissions ?? []);
      record.redacted = source.redacted ?? false;
      record.truncated = source.truncated ?? false;
      record.inspection =
        source.truncated === true || source.inspection === 'partial'
          ? 'partial'
          : 'complete';
      const projected = fullEvidenceText(reusableText, 'text');
      options.files[textPath] = projected.text;
      record.redacted = record.redacted === true || projected.redacted;
      continue;
    }
    const extension = extname(originalPath).toLowerCase();
    if (!['.xlsx', '.docx', '.pdf'].includes(extension)) {
      record.inspection = 'unsupported';
      record.reason = `No Reflection preview parser for ${extension || 'this source type'}`;
      continue;
    }
    if (remaining <= 0) {
      record.inspection = 'partial';
      record.reason =
        'Reflection virtual-file byte bound exhausted; this source was not parsed';
      continue;
    }
    if (typeof source.artifactRef !== 'string') {
      record.reason = 'Original file bytes were not captured';
      continue;
    }
    let raw: JsonValue;
    try {
      raw = await options.artifacts.readJson(source.artifactRef);
    } catch (error) {
      if (!missing(error)) throw error;
      record.reason = 'Captured source artifact is unavailable';
      continue;
    }
    const tree = parseFileTree(raw);
    const entryIndex = tree.files.findIndex(
      (entry) => entry.path === originalPath,
    );
    const entry = tree.files[entryIndex];
    if (!entry) {
      record.reason = 'Exact referenced file-tree entry is unavailable';
      continue;
    }
    if (
      source.pointer !== undefined &&
      source.pointer !== `/files/${entryIndex}`
    )
      throw new Error(
        'Reflection document source pointer does not match its captured path',
      );
    const bytes = Buffer.from(entry.base64, 'base64');
    record.sizeBytes = bytes.length;
    if (bytes.length > maxSourceBytes) {
      record.inspection = 'partial';
      record.reason = `Source exceeds ${maxSourceBytes}-byte preview input bound; it was not parsed`;
      continue;
    }
    let extracted: Extracted;
    try {
      extracted = await (extension === '.xlsx'
        ? excel(bytes, options.signal)
        : extension === '.docx'
          ? word(bytes, options.signal)
          : pdf(bytes, options.signal));
    } catch (error) {
      options.signal.throwIfAborted();
      record.inspection = 'failed';
      const detail =
        error instanceof Error
          ? `${error.name}: ${safe(error.message)
              .replace(/[A-Za-z]:[\\/][^\r\n]+/g, '[host-path]')
              .replace(/\/(?:tmp|home|Users|var)\/[^\r\n]+/g, '[host-path]')
              .slice(0, 1000)}`
          : 'parser error';
      record.reason = `The ${extension} parser could not extract this captured document (${detail})`;
      continue;
    }
    options.signal.throwIfAborted();
    const projected = fullEvidenceText(extracted.text, 'text');
    const content = Buffer.from(projected.text);
    const limit = Math.min(maxPreviewBytes, remaining);
    const truncated = content.length > limit;
    const path = `context/reflection/previews/${previews.length - 1}.txt`;
    const previewText = truncated
      ? content.subarray(0, limit).toString('utf8')
      : projected.text;
    options.files[path] = previewText;
    remaining -= Buffer.byteLength(previewText);
    record.path = path;
    record.locations = safeValue(extracted.locations);
    record.omissions = extracted.omissions.map(safe);
    if (truncated)
      (record.omissions as JsonValue[]).push(
        `Preview text truncated at ${limit} bytes`,
      );
    record.redacted = projected.redacted;
    record.inspection =
      truncated ||
      extracted.omissions.some((reason) => /omitted|stopped/.test(reason))
        ? 'partial'
        : 'complete';
  }
  return previews;
}
