import sharp from 'sharp';
import { crc32 } from 'node:zlib';

export async function animatedPng() {
  const frame = (color: string) =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: color } })
      .png()
      .toBuffer();
  const first = await frame('red'),
    second = await frame('blue');
  const chunk = (name: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(name), data]),
      length = Buffer.alloc(4),
      crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const idat = (png: Buffer) => {
    const parts: Buffer[] = [];
    for (let offset = 8; offset + 12 <= png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
        parts.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    return Buffer.concat(parts);
  };
  const control = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence, 0);
    data.writeUInt32BE(64, 4);
    data.writeUInt32BE(64, 8);
    data.writeUInt16BE(1, 20);
    data.writeUInt16BE(10, 22);
    return chunk('fcTL', data);
  };
  const animation = Buffer.alloc(8),
    sequence = Buffer.alloc(4);
  animation.writeUInt32BE(2);
  sequence.writeUInt32BE(2);
  return Buffer.concat([
    first.subarray(0, 33),
    chunk('acTL', animation),
    control(0),
    chunk('IDAT', idat(first)),
    control(1),
    chunk('fdAT', Buffer.concat([sequence, idat(second)])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function previewPng(width = 3200, height = 1600, color = '#437be2') {
  const rows = Array.from(
    { length: 28 },
    (_, i) =>
      `<rect x="80" y="${160 + i * 42}" width="${700 + (i % 5) * 360}" height="24" fill="${i % 2 ? color : '#d0d7df'}"/><text x="80" y="${180 + i * 42}" font-size="20">Image preview sample row ${i + 1}: 12345.67</text>`,
  ).join('');
  return sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 3200 1600"><defs><linearGradient id="g"><stop stop-color="#f5f9ff"/><stop offset="1" stop-color="${color}"/></linearGradient></defs><rect width="3200" height="1600" fill="url(#g)"/><text x="80" y="100" font-size="54">Image preview: text, gradients and table rows</text>${rows}</svg>`,
    ),
  )
    .png()
    .toBuffer();
}
