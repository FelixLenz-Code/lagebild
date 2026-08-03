/**
 * Kleiner PNG-Leser — genug für die Höhenkacheln (8 Bit, RGB/RGBA, ohne
 * Interlace). Wie beim PBF-Leser bewusst ohne Paket: der Bau der Pakete soll
 * mit dem auskommen, was Node mitbringt.
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Entpackt ein PNG zu rohen Bildpunkten.
 * @returns {{ width: number, height: number, channels: number, data: Buffer }}
 */
export function decodePng(buffer) {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (buffer[i] !== SIGNATURE[i]) throw new Error('Keine PNG-Datei');
  }

  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];

  while (at + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.toString('latin1', at + 4, at + 8);
    const body = buffer.subarray(at + 8, at + 8 + length);
    at += 12 + length; // Länge + Typ + Daten + Prüfsumme

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('Interlace wird nicht unterstützt');
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (depth !== 8) throw new Error(`Bittiefe ${depth} wird nicht unterstützt`);
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`Farbtyp ${colorType} wird nicht unterstützt`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.allocUnsafe(stride * height);

  // Jede Zeile beginnt mit ihrem Filtertyp; rückgängig gemacht wird immer
  // gegen die schon entfilterte Zeile darüber.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const target = y * stride;
    const above = target - stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[target + x - channels] : 0;
      const up = y > 0 ? out[above + x] : 0;
      const upLeft = y > 0 && x >= channels ? out[above + x - channels] : 0;
      let value = line[x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += (left + up) >> 1;
          break;
        case 4: {
          // Paeth: der Nachbar, der der Vorhersage am nächsten kommt.
          const p = left + up - upLeft;
          const dLeft = Math.abs(p - left);
          const dUp = Math.abs(p - up);
          const dUpLeft = Math.abs(p - upLeft);
          value += dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
          break;
        }
        default:
          throw new Error(`Unbekannter Zeilenfilter ${filter}`);
      }
      out[target + x] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}
