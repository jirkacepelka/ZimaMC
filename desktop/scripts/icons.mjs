// Draws the app icon (the 16×16 pixel grass block of frontend/public/icon.svg) as PNG and ICO
// files for the installer, the window and the tray. Pixel art scales without any image library.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 16×16 grid of [r,g,b] from the SVG's <rect> elements. */
export function pixels(svg) {
  const grid = Array.from({ length: 16 }, () => Array(16).fill([0, 0, 0]));
  for (const m of svg.matchAll(/<rect([^>]*)\/>/g)) {
    const a = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    const hex = a.fill.replace("#", "");
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const x0 = Number(a.x ?? 0), y0 = Number(a.y ?? 0);
    for (let y = y0; y < y0 + Number(a.height); y++) for (let x = x0; x < x0 + Number(a.width); x++) grid[y][x] = rgb;
  }
  return grid;
}

export function png(grid, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = grid[Math.floor((y * 16) / size)][Math.floor((x * 16) / size)];
      raw.set([r, g, b, 255], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** ICO file holding PNG images (supported since Windows Vista). */
export function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...images.map((i) => i.data)]);
}

export function writeIcons(svgFile, outDir) {
  const grid = pixels(fs.readFileSync(svgFile, "utf8"));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "icon.png"), png(grid, 512));
  fs.writeFileSync(path.join(outDir, "tray.png"), png(grid, 32));
  fs.writeFileSync(path.join(outDir, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: png(grid, size) }))));
}
