import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', 'public', 'icons');
mkdirSync(OUT, { recursive: true });

// Brand: deep cool-black bg with green-primary "C" + soft glow
const svg = (size, maskable) => {
  const pad = maskable ? Math.round(size * 0.16) : Math.round(size * 0.06);
  const inner = size - pad * 2;
  const r = Math.round(inner * 0.22);
  const fontSize = Math.round(inner * 0.62);
  const cy = Math.round(size / 2 + fontSize * 0.34);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <radialGradient id="g" cx="50%" cy="40%" r="60%">
      <stop offset="0%" stop-color="#16321f" />
      <stop offset="100%" stop-color="#06090a" />
    </radialGradient>
    <linearGradient id="text" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#4ade80" />
      <stop offset="100%" stop-color="#22c55e" />
    </linearGradient>
    <filter id="glow">
      <feGaussianBlur stdDeviation="${Math.round(inner * 0.04)}" result="b" />
      <feMerge>
        <feMergeNode in="b" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" fill="#06090a" />
  <rect x="${pad}" y="${pad}" width="${inner}" height="${inner}" rx="${r}" ry="${r}" fill="url(#g)" />
  <text x="50%" y="${cy}"
        text-anchor="middle"
        font-family="Geist, Inter, -apple-system, Segoe UI, Helvetica, Arial, sans-serif"
        font-size="${fontSize}"
        font-weight="800"
        fill="url(#text)"
        filter="url(#glow)">C</text>
</svg>`;
};

async function render(size, name, maskable = false) {
  const buf = Buffer.from(svg(size, maskable));
  const out = resolve(OUT, name);
  await sharp(buf).png().toFile(out);
  console.log('  •', name);
}

console.log('Generating PWA icons →', OUT);
await render(192, 'icon-192.png');
await render(512, 'icon-512.png');
await render(512, 'icon-maskable-512.png', true);
console.log('Done.');
