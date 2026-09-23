/**
 * The document formats the vault accepts (brief §7.4: PDF, PNG, JPG, XLSX, CSV; 25 MB) and how
 * each is recognised: by declared MIME type + extension on the way in, and by content (magic
 * bytes / text heuristics) once the bytes are in storage. Pure module: shared by the web
 * validators, the scan pipeline and the worker.
 */

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export const DOCUMENT_FORMATS = ['pdf', 'png', 'jpeg', 'xlsx', 'csv'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export interface DocumentFormatSpec {
  label: string;
  /** Lower-case, without the dot. The first entry is canonical. */
  extensions: readonly string[];
  /** Accepted declared MIME types. The first entry is canonical and is what gets stored/signed. */
  mimeTypes: readonly string[];
}

export const FORMAT_SPECS: Readonly<Record<DocumentFormat, DocumentFormatSpec>> = {
  pdf: { label: 'PDF', extensions: ['pdf'], mimeTypes: ['application/pdf'] },
  png: { label: 'PNG image', extensions: ['png'], mimeTypes: ['image/png'] },
  jpeg: {
    label: 'JPEG image',
    extensions: ['jpg', 'jpeg'],
    mimeTypes: ['image/jpeg', 'image/pjpeg'],
  },
  xlsx: {
    label: 'Excel workbook',
    extensions: ['xlsx'],
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  },
  // Windows browsers report CSV files as Excel; some as plain text. The stored type is text/csv.
  csv: {
    label: 'CSV',
    extensions: ['csv'],
    mimeTypes: ['text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain'],
  },
};

export const ALLOWED_EXTENSIONS: readonly string[] = DOCUMENT_FORMATS.flatMap(
  (f) => FORMAT_SPECS[f].extensions,
);

export const canonicalMimeType = (format: DocumentFormat): string =>
  FORMAT_SPECS[format].mimeTypes[0]!;

/** Lower-cased extension of a file name without the dot, or null. */
export const extensionOf = (filename: string): string | null => {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
};

/** The MIME type without parameters, lower-cased (`text/csv; charset=utf-8` → `text/csv`). */
export const normaliseMimeType = (mimeType: string): string =>
  (mimeType.split(';')[0] ?? '').trim().toLowerCase();

export const formatForExtension = (ext: string | null): DocumentFormat | null => {
  if (ext === null) return null;
  const lower = ext.toLowerCase();
  return DOCUMENT_FORMATS.find((f) => FORMAT_SPECS[f].extensions.includes(lower)) ?? null;
};

/** The format whose canonical (stored) MIME type this is. */
export const formatForStoredMimeType = (mimeType: string): DocumentFormat | null => {
  const m = normaliseMimeType(mimeType);
  return DOCUMENT_FORMATS.find((f) => canonicalMimeType(f) === m) ?? null;
};

export type DeclaredFormatProblem =
  'EXTENSION_NOT_ALLOWED' | 'MIME_NOT_ALLOWED' | 'MIME_EXTENSION_MISMATCH';

export type DeclaredFormatResult =
  | { ok: true; format: DocumentFormat; contentType: string }
  | { ok: false; problem: DeclaredFormatProblem };

/**
 * Extension AND declared MIME type must both be allowed and agree (§7.4 "content-type enforced
 * on the presign, not trusted from the client"). An empty MIME type (some browsers for unknown
 * types) is accepted when the extension is allowed: the content check after upload is what
 * actually decides. The stored/signed content type is always the format's canonical one.
 */
export const resolveDeclaredFormat = (input: {
  filename: string;
  mimeType: string;
}): DeclaredFormatResult => {
  const byExtension = formatForExtension(extensionOf(input.filename));
  if (byExtension === null) return { ok: false, problem: 'EXTENSION_NOT_ALLOWED' };
  const mime = normaliseMimeType(input.mimeType);
  if (mime === '' || mime === 'application/octet-stream') {
    return { ok: true, format: byExtension, contentType: canonicalMimeType(byExtension) };
  }
  const formatsForMime = DOCUMENT_FORMATS.filter((f) => FORMAT_SPECS[f].mimeTypes.includes(mime));
  if (formatsForMime.length === 0) return { ok: false, problem: 'MIME_NOT_ALLOWED' };
  if (!formatsForMime.includes(byExtension))
    return { ok: false, problem: 'MIME_EXTENSION_MISMATCH' };
  return { ok: true, format: byExtension, contentType: canonicalMimeType(byExtension) };
};

// ---------- content sniffing ----------

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
/** Every OOXML workbook is a ZIP containing this entry (its name appears in the local file header). */
export const OOXML_CONTENT_TYPES_ENTRY = Buffer.from('[Content_Types].xml', 'latin1');

export type HeadSignature = 'pdf' | 'png' | 'jpeg' | 'zip' | null;

const startsWith = (bytes: Uint8Array, magic: Buffer): boolean =>
  bytes.length >= magic.length &&
  Buffer.from(bytes.buffer, bytes.byteOffset, magic.length).equals(magic);

export const sniffHeadSignature = (head: Uint8Array): HeadSignature => {
  if (startsWith(head, PDF_MAGIC)) return 'pdf';
  if (startsWith(head, PNG_MAGIC)) return 'png';
  if (startsWith(head, JPEG_MAGIC)) return 'jpeg';
  if (startsWith(head, ZIP_MAGIC)) return 'zip';
  return null;
};

/** What the content inspector learns from the whole byte stream. */
export interface ContentFindings {
  sizeBytes: number;
  head: HeadSignature;
  /** A ZIP whose entries include `[Content_Types].xml` (Office Open XML). */
  ooxml: boolean;
  hasNul: boolean;
  validUtf8: boolean;
}

/**
 * Does the content match the declared format? Text formats must be NUL-free, valid UTF-8 and not
 * carry a binary signature (a PDF renamed `.csv` is a mismatch even when it is pure ASCII).
 */
export const contentMatchesFormat = (
  findings: ContentFindings,
  format: DocumentFormat,
): boolean => {
  if (findings.sizeBytes === 0) return false;
  switch (format) {
    case 'pdf':
      return findings.head === 'pdf';
    case 'png':
      return findings.head === 'png';
    case 'jpeg':
      return findings.head === 'jpeg';
    case 'xlsx':
      return findings.head === 'zip' && findings.ooxml;
    case 'csv':
      return findings.head === null && !findings.hasNul && findings.validUtf8;
  }
};

/**
 * Incremental inspector: feed chunks in order, then `finish()`. Tracks the head signature, the
 * OOXML marker (across chunk boundaries), NUL bytes and UTF-8 validity. Pure; no hashing here.
 */
export class ContentInspector {
  private readonly head: number[] = [];
  private sizeBytes = 0;
  private ooxml = false;
  private hasNul = false;
  private validUtf8 = true;
  private carry: Buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly headBytes = 16) {}

  update(chunk: Uint8Array): void {
    const buf = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this.sizeBytes += buf.length;
    for (let i = 0; this.head.length < this.headBytes && i < buf.length; i += 1) {
      this.head.push(buf[i]!);
    }
    if (!this.hasNul && buf.includes(0)) this.hasNul = true;
    if (!this.ooxml) {
      const window = this.carry.length > 0 ? Buffer.concat([this.carry, buf]) : buf;
      if (window.includes(OOXML_CONTENT_TYPES_ENTRY)) this.ooxml = true;
      const keep = OOXML_CONTENT_TYPES_ENTRY.length - 1;
      this.carry =
        window.length > keep
          ? Buffer.from(window.subarray(window.length - keep))
          : Buffer.from(window);
    }
    if (this.validUtf8) {
      try {
        this.decoder.decode(buf, { stream: true });
      } catch {
        this.validUtf8 = false;
      }
    }
  }

  finish(): ContentFindings {
    if (this.validUtf8) {
      try {
        this.decoder.decode();
      } catch {
        this.validUtf8 = false;
      }
    }
    return {
      sizeBytes: this.sizeBytes,
      head: sniffHeadSignature(Uint8Array.from(this.head)),
      ooxml: this.ooxml,
      hasNul: this.hasNul,
      validUtf8: this.validUtf8,
    };
  }
}

/** One-shot form of the inspector, for tests and small buffers. */
export const inspectBytes = (bytes: Uint8Array): ContentFindings => {
  const inspector = new ContentInspector();
  inspector.update(bytes);
  return inspector.finish();
};

/**
 * File-name sanitiser for display and `Content-Disposition` (§7.4 "filenames sanitised"). Keeps
 * the base name only, drops control characters, quotes, backslashes and path separators,
 * collapses whitespace, and caps the length while preserving the extension.
 */
export const sanitiseFilename = (name: string, maxLength = 120): string => {
  const base = name.split(/[\\/]/).pop() ?? '';
  let cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"'`;<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  cleaned = cleaned.replace(/^\.+/, '');
  if (cleaned === '') return 'document';
  if (cleaned.length <= maxLength) return cleaned;
  const ext = extensionOf(cleaned);
  if (ext && ext.length < 10) {
    const stem = cleaned.slice(0, cleaned.length - ext.length - 1);
    return `${stem.slice(0, maxLength - ext.length - 1)}.${ext}`;
  }
  return cleaned.slice(0, maxLength);
};

/** RFC 6266 attachment disposition with an ASCII fallback and a UTF-8 `filename*`. */
export const attachmentDisposition = (filename: string): string => {
  const safe = sanitiseFilename(filename);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};
