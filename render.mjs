// Renders the aurora animation to a perfectly-looping H.264 MP4
// (plus a small preview GIF) using headless Chromium + ffmpeg.
//
// Usage: node render.mjs
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path;

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const FRAMES = path.join(ROOT, 'frames');
const FPS = 30;
const W = 1080, H = 2340;

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

// Prefer the pre-installed Chromium if Playwright's own lookup fails.
const fallbackChromium = '/opt/pw-browsers/chromium';
const launchOpts = { args: ['--no-sandbox', '--force-color-profile=srgb'] };
let browser;
try {
  browser = await chromium.launch(launchOpts);
} catch (err) {
  if (!existsSync(fallbackChromium)) throw err;
  browser = await chromium.launch({ ...launchOpts, executablePath: fallbackChromium });
}
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto('file://' + path.join(ROOT, 'index.html'));
await page.waitForFunction('typeof window.renderFrame === "function"');

const loop = await page.evaluate('window.LOOP_SECONDS');
const total = Math.round(loop * FPS);
console.log(`Rendering ${total} frames (${loop}s @ ${FPS}fps, ${W}x${H})...`);

const canvas = page.locator('#c');
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.renderFrame(t), i / FPS);
  await canvas.screenshot({
    path: path.join(FRAMES, `f${String(i).padStart(4, '0')}.png`),
  });
  if ((i + 1) % 30 === 0) console.log(`  ${i + 1}/${total}`);
}
await browser.close();

console.log('Encoding aurora-wallpaper.mp4 ...');
execFileSync(ffmpeg, [
  '-y', '-framerate', String(FPS),
  '-i', path.join(FRAMES, 'f%04d.png'),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  path.join(ROOT, 'aurora-wallpaper.mp4'),
], { stdio: 'inherit' });

console.log('Encoding preview.gif ...');
execFileSync(ffmpeg, [
  '-y', '-framerate', String(FPS),
  '-i', path.join(FRAMES, 'f%04d.png'),
  '-vf', `fps=15,scale=270:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer`,
  path.join(ROOT, 'preview.gif'),
], { stdio: 'inherit' });

rmSync(FRAMES, { recursive: true, force: true });
console.log('Done: aurora-wallpaper.mp4 + preview.gif');
