'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const root = path.resolve(__dirname, '..');
const buildDir = path.join(root, 'build');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  if (x < left || y < top || x >= left + width || y >= top + height) return false;
  const cx = Math.min(Math.max(x, left + radius), left + width - radius);
  const cy = Math.min(Math.max(y, top + radius), top + height - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function draw() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const bars = [
    { x: 52, height: 64 },
    { x: 100, height: 104 },
    { x: 148, height: 148 },
    { x: 196, height: 88 },
  ];
  const baseline = 196;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const offset = (y * SIZE + x) * 4;
      if (!insideRoundedRect(x + 0.5, y + 0.5, 14, 14, 228, 228, 54)) {
        rgba[offset + 3] = 0;
        continue;
      }
      const t = Math.min(1, (x + y) / (SIZE * 2));
      let r = mix(109, 34, t);
      let g = mix(94, 184, t);
      let b = mix(252, 207, t);
      for (const bar of bars) {
        if (insideRoundedRect(x + 0.5, y + 0.5, bar.x, baseline - bar.height, 26, bar.height, 12)) {
          r = 255;
          g = 255;
          b = 255;
          break;
        }
      }
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

async function main() {
  fs.mkdirSync(buildDir, { recursive: true });
  const png = encodePng(SIZE, SIZE, draw());
  const pngPath = path.join(buildDir, 'icon.png');
  fs.writeFileSync(pngPath, png);
  const icoModule = require('png-to-ico');
  const pngToIco = icoModule.default || icoModule;
  const ico = await pngToIco(png);
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico);
  console.log(`icons written: ${pngPath} (${png.length} B), icon.ico (${ico.length} B)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
