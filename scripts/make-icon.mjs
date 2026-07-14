// scripts/make-icon.mjs
//
// Generates the macOS app icon (build/icon.icns) from the ApplyPilot faceted-plane logo. Rasterizes
// the SVG to a 1024px PNG with Playwright's Chromium (the one rasterizer we already have), then uses
// macOS `sips` + `iconutil` to build the multi-resolution .icns electron-builder + the .app expect.
// Run: npm run make-icon

import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = join(root, "build");
const iconset = join(buildDir, "icon.iconset");
mkdirSync(iconset, { recursive: true });

// The icon art: rounded coral square + the faceted plane (matches dashboard/public/logo.svg).
const SVG = `<svg width="1024" height="1024" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="96" height="96" rx="22" fill="#e8734a"/>
  <polygon points="86,42 16,24 55,47" fill="#fbe9d2"/>
  <polygon points="86,42 55,47 34,76" fill="#f4a06f"/>
  <polygon points="16,24 55,47 34,76" fill="#b9442a"/>
  <line x1="55" y1="47" x2="86" y2="42" stroke="#a23a22" stroke-width="1.4" stroke-linecap="round"/>
  <line x1="55" y1="47" x2="16" y2="24" stroke="#fff3e0" stroke-width="1.2" stroke-linecap="round" opacity="0.7"/>
  <line x1="55" y1="47" x2="34" y2="76" stroke="#a23a22" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

const png1024 = join(buildDir, "icon-1024.png");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0">${SVG}</body>`);
await page.locator("svg").screenshot({ path: png1024, omitBackground: true });
await browser.close();

// macOS iconset: only the valid base sizes (16/32/128/256/512); the @2x variants below cover the
// rest. (icon_64x64 and icon_1024x1024 are NOT valid iconset member names, so iconutil ignores them.)
const sizes = [16, 32, 128, 256, 512];
for (const s of sizes) {
  execSync(`sips -z ${s} ${s} ${JSON.stringify(png1024)} --out ${JSON.stringify(join(iconset, `icon_${s}x${s}.png`))}`, { stdio: "ignore" });
}
// Retina (@2x) variants are the next size up, renamed.
const at2x = [[16, 32], [32, 64], [128, 256], [256, 512], [512, 1024]];
for (const [base, src] of at2x) {
  execSync(`sips -z ${src} ${src} ${JSON.stringify(png1024)} --out ${JSON.stringify(join(iconset, `icon_${base}x${base}@2x.png`))}`, { stdio: "ignore" });
}
execSync(`iconutil -c icns ${JSON.stringify(iconset)} -o ${JSON.stringify(join(buildDir, "icon.icns"))}`, { stdio: "inherit" });

// Keep a 512 PNG around too (electron-builder fallback / Linux). Clean the scratch iconset.
execSync(`sips -z 512 512 ${JSON.stringify(png1024)} --out ${JSON.stringify(join(buildDir, "icon.png"))}`, { stdio: "ignore" });
rmSync(iconset, { recursive: true, force: true });
rmSync(png1024, { force: true });
console.log("Wrote build/icon.icns and build/icon.png");
