/**
 * TEST FIXTURE ONLY (R-2662) — builds a small password-protected PDF (Standard security
 * handler, RC4 40-bit, revision 2 — the PDF spec's algorithms 2, 3 and 4) so the unlock path
 * can be tested with a real encrypted file, without any PDF library or a real bank statement.
 * Every password used with it is a made-up dummy. Never imported by app code.
 */
import { createHash } from "node:crypto";

const PAD = Buffer.from(
  "28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex");

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0; j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const md5 = (...parts: Buffer[]) => createHash("md5").update(Buffer.concat(parts)).digest();
const padded = (pw: string) => Buffer.concat([Buffer.from(pw, "latin1"), PAD]).subarray(0, 32);
const pdfString = (b: Buffer) => "<" + b.toString("hex") + ">";
/** Text for a PDF literal string — backslash and brackets escaped. */
const lit = (s: string) => s.replace(/[\\()]/g, (c) => "\\" + c);

/**
 * A PDF whose pages each show the given lines (top to bottom, Helvetica 10 pt), locked with
 * `userPassword`. Each line may hold several cells separated by "|" — drawn left to right in
 * columns, the way a bank statement prints a row.
 */
export function encryptedPdf(pages: string[][], userPassword: string, ownerPassword = "owner-dummy"): Uint8Array {
  const P = -44; // print + copy allowed
  const id = md5(Buffer.from("r-2662-fixture"));
  // Algorithm 3 (R2): O entry.
  const oKey = md5(padded(ownerPassword)).subarray(0, 5);
  const O = rc4(oKey, padded(userPassword));
  // Algorithm 2: the file key.
  const pBuf = Buffer.alloc(4); pBuf.writeInt32LE(P);
  const fileKey = md5(padded(userPassword), O, pBuf, id).subarray(0, 5);
  // Algorithm 4 (R2): U entry.
  const U = rc4(fileKey, PAD);
  const objKey = (num: number) => {
    const extra = Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]);
    return md5(fileKey, extra).subarray(0, 10);
  };

  // Objects: 1 catalog, 2 pages, 3 font, 4 encrypt, then per page: page + content.
  const objs: string[] = [];
  const kids: number[] = [];
  const pageObjs: string[] = [];
  let next = 5;
  for (const lines of pages) {
    const pageNum = next++;
    const contentNum = next++;
    kids.push(pageNum);
    let y = 800;
    const ops: string[] = [];
    for (const line of lines) {
      const cells = line.split("|");
      cells.forEach((cell, c) => {
        ops.push(`BT /F1 10 Tf ${40 + c * 130} ${y} Td (${lit(cell.trim())}) Tj ET`);
      });
      y -= 16;
    }
    const stream = rc4(objKey(contentNum), Buffer.from(ops.join("\n"), "latin1"));
    pageObjs[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`;
    pageObjs[contentNum] = `<< /Length ${stream.length} >>\nstream\n` + stream.toString("latin1") + "\nendstream";
  }
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  objs[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  objs[4] = `<< /Filter /Standard /V 1 /R 2 /O ${pdfString(O)} /U ${pdfString(U)} /P ${P} >>`;
  for (let n = 5; n < next; n++) objs[n] = pageObjs[n];

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let n = 1; n < next; n++) {
    offsets[n] = Buffer.byteLength(body, "latin1");
    body += `${n} 0 obj\n${objs[n]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let n = 1; n < next; n++) body += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  body += `trailer\n<< /Size ${next} /Root 1 0 R /Encrypt 4 0 R /ID [${pdfString(id)} ${pdfString(id)}] >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}
