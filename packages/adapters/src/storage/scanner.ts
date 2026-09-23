import { createConnection } from 'node:net';
import type { Duplex, Readable } from 'node:stream';
import { withTimeout } from '../resilience.js';

/**
 * Malware scanning port (§7.4 "run ClamAV (or Cloudflare/AWS malware scan)").
 *
 *   ClamdScanner  streams the object to a clamd daemon over TCP (INSTREAM). Engine `clamav`.
 *   NoScanner     no scanner configured. Reports `not_scanned` — it is NOT a clean verdict. The
 *                 document stays `UPLOADED`, never becomes `CLEAN`, and the UI says so
 *                 (phase-1-build-plan: the fallback must not be presented as a virus scan).
 */

export type ScanEngine = 'clamav' | 'none';

export type MalwareScanResult =
  { verdict: 'clean' } | { verdict: 'infected'; signature: string } | { verdict: 'not_scanned' };

export interface MalwareScanner {
  readonly engine: ScanEngine;
  /** Consumes `stream`. Rejects (`ScannerError`) when the scanner could not give a verdict. */
  scan(stream: Readable): Promise<MalwareScanResult>;
}

export class ScannerError extends Error {
  override readonly name = 'ScannerError';
}

export class NoScanner implements MalwareScanner {
  readonly engine = 'none' as const;
  async scan(stream: Readable): Promise<MalwareScanResult> {
    stream.destroy();
    return { verdict: 'not_scanned' };
  }
}

export interface ClamdScannerOptions {
  host: string;
  port: number;
  /** Whole-scan budget (connect, stream, verdict). Default 60 s. */
  timeoutMs?: number;
  /** INSTREAM chunk size. clamd's default StreamMaxLength is 25 MB; chunks are independent. */
  chunkBytes?: number;
  /** Test seam: returns a connected (or connecting) duplex. */
  connect?: (host: string, port: number) => Duplex;
}

const INSTREAM_COMMAND = Buffer.from('zINSTREAM\0', 'latin1');
const INSTREAM_END = Buffer.alloc(4);
/** Parses a clamd INSTREAM reply (`stream: OK`, `stream: <sig> FOUND`, `... ERROR`). Exported for tests. */
export const parseClamdResponse = (raw: string): MalwareScanResult => {
  const text = raw.replace(/\0+$/, '').trim();
  const body = text.startsWith('stream:') ? text.slice('stream:'.length).trim() : text;
  if (body === 'OK') return { verdict: 'clean' };
  if (body.endsWith(' FOUND')) {
    const signature = body.slice(0, -' FOUND'.length).trim();
    return { verdict: 'infected', signature: signature === '' ? 'unknown' : signature };
  }
  throw new ScannerError(`clamd: ${text === '' ? 'empty response' : text}`);
};

const lengthPrefix = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
};

export class ClamdScanner implements MalwareScanner {
  readonly engine = 'clamav' as const;
  private readonly timeoutMs: number;
  private readonly chunkBytes: number;
  private readonly connect: (host: string, port: number) => Duplex;

  constructor(private readonly opts: ClamdScannerOptions) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.chunkBytes = opts.chunkBytes ?? 64 * 1024;
    this.connect = opts.connect ?? ((host, port) => createConnection({ host, port }));
  }

  scan(stream: Readable): Promise<MalwareScanResult> {
    return withTimeout((signal) => this.scanOnce(stream, signal), this.timeoutMs);
  }

  private scanOnce(stream: Readable, signal: AbortSignal): Promise<MalwareScanResult> {
    return new Promise<MalwareScanResult>((resolve, reject) => {
      let socket: Duplex;
      try {
        socket = this.connect(this.opts.host, this.opts.port);
      } catch (err) {
        reject(
          new ScannerError(
            `clamd: connect failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        stream.destroy();
        socket.destroy();
        fn();
      };
      const fail = (message: string) => finish(() => reject(new ScannerError(message)));
      const onAbort = () => fail('clamd: scan aborted (timeout)');
      signal.addEventListener('abort', onAbort, { once: true });

      socket.on('error', (err: Error) => fail(`clamd: socket error: ${err.message}`));
      socket.on('data', (data: Buffer) => {
        chunks.push(data);
        if (data.includes(0)) {
          const raw = Buffer.concat(chunks).toString('latin1');
          finish(() => {
            try {
              resolve(parseClamdResponse(raw));
            } catch (err) {
              reject(err instanceof Error ? err : new ScannerError(String(err)));
            }
          });
        }
      });
      socket.on('end', () => {
        const raw = Buffer.concat(chunks).toString('latin1');
        finish(() => {
          try {
            resolve(parseClamdResponse(raw));
          } catch (err) {
            reject(err instanceof Error ? err : new ScannerError(String(err)));
          }
        });
      });

      socket.write(INSTREAM_COMMAND);
      const pump = async () => {
        for await (const chunk of stream) {
          const buf = chunk as Buffer;
          for (let offset = 0; offset < buf.length; offset += this.chunkBytes) {
            const piece = buf.subarray(offset, Math.min(buf.length, offset + this.chunkBytes));
            if (!socket.write(Buffer.concat([lengthPrefix(piece.length), piece]))) {
              await new Promise<void>((r) => socket.once('drain', r));
            }
          }
        }
        socket.write(INSTREAM_END);
      };
      pump().catch((err: unknown) =>
        fail(`clamd: streaming failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
  }
}
