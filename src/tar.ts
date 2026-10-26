/**
 * Minimal tar (ustar + PAX path extension) writer. Used to stream the sanitized project
 * into a container over stdin, so nothing on the host is ever bind-mounted.
 */

export interface TarEntry {
  /** Relative POSIX path, no leading slash, no "..". */
  path: string;
  type: 'file' | 'dir';
  mode: number;
  /** Seconds since epoch. */
  mtime: number;
  data?: Buffer;
}

export const TAR_UID = 1000;
export const TAR_GID = 1000;

function octal(value: number, width: number): string {
  const s = Math.max(0, Math.floor(value)).toString(8);
  if (s.length > width - 1) throw new Error(`tar field overflow (${value})`);
  return s.padStart(width - 1, '0') + String.fromCharCode(0);
}

function writeString(buf: Buffer, offset: number, width: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > width) throw new Error('tar string field overflow');
  bytes.copy(buf, offset);
}

function header(name: string, size: number, mode: number, mtime: number, typeflag: string): Buffer {
  const h = Buffer.alloc(512, 0);
  writeString(h, 0, 100, name);
  writeString(h, 100, 8, octal(mode, 8));
  writeString(h, 108, 8, octal(TAR_UID, 8));
  writeString(h, 116, 8, octal(TAR_GID, 8));
  writeString(h, 124, 12, octal(size, 12));
  writeString(h, 136, 12, octal(mtime, 12));
  h.fill(0x20, 148, 156);
  h.write(typeflag, 156, 1, 'latin1');
  h.write('ustar', 257, 5, 'latin1');
  h.write('00', 263, 2, 'latin1');
  writeString(h, 265, 32, 'node');
  writeString(h, 297, 32, 'node');
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, '0') + String.fromCharCode(0) + ' ');
  return h;
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body, 'utf8');
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function pad(data: Buffer): Buffer {
  const rem = data.length % 512;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
}

function isPlainAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

export function validateTarPath(p: string): void {
  if (p === '' || p.startsWith('/') || p.includes(String.fromCharCode(0)) || p.split('/').some((s) => s === '..' || s === '')) {
    throw new Error(`unsafe tar path: ${JSON.stringify(p)}`);
  }
}

export function buildTar(entries: readonly TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    validateTarPath(e.path);
    const name = e.type === 'dir' ? e.path + '/' : e.path;
    const data = e.type === 'file' ? (e.data ?? Buffer.alloc(0)) : Buffer.alloc(0);
    let headerName = name;
    if (Buffer.byteLength(name, 'utf8') > 100 || !isPlainAscii(name)) {
      const rec = paxRecord('path', name);
      chunks.push(header('PaxHeader/entry', rec.length, 0o644, e.mtime, 'x'), pad(rec));
      headerName = Buffer.from(name, 'utf8').subarray(0, 99).toString('latin1').replace(/[^\x20-\x7e]/g, '_');
    }
    chunks.push(header(headerName, data.length, e.mode & 0o7777, e.mtime, e.type === 'dir' ? '5' : '0'));
    if (data.length > 0) chunks.push(pad(data));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

