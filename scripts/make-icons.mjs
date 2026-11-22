// Turns icon.svg into the PNG icons phones need for installing
import sharp from 'sharp';
import { readFile, mkdir } from 'node:fs/promises';

const svg = await readFile('icon.svg');
await mkdir('icons', { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  await sharp(svg, { density: 300 }).resize(size, size).png().toFile(`icons/${name}`);
}
console.log('Icons ready');
