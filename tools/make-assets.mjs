/* 生成小程序图标与封面（仅用 ASCII 文字，避免中文字体缺失） */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

await mkdir("public", { recursive: true });

const icon = `
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b2231"/>
      <stop offset="1" stop-color="#0a0d13"/>
    </linearGradient>
    <linearGradient id="ac" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffb066"/>
      <stop offset="1" stop-color="#ff6a13"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="112" fill="url(#bg)"/>
  <circle cx="256" cy="256" r="150" fill="none" stroke="url(#ac)" stroke-width="8" opacity="0.35"/>
  <circle cx="256" cy="256" r="112" fill="url(#ac)" opacity="0.12"/>
  <text x="256" y="296" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="128" font-weight="800" fill="url(#ac)">ES</text>
  <text x="256" y="360" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="600" fill="#9aa6ba" letter-spacing="6">SANDBOX</text>
</svg>`;

const cover = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#141a26"/>
      <stop offset="1" stop-color="#080b11"/>
    </linearGradient>
    <linearGradient id="ac" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffc38f"/>
      <stop offset="1" stop-color="#ff6a13"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.82" cy="0.2" r="0.5">
      <stop offset="0" stop-color="#ff8a3d" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#ff8a3d" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect width="1200" height="630" fill="url(#glow)"/>
  <circle cx="980" cy="180" r="150" fill="none" stroke="url(#ac)" stroke-width="3" opacity="0.25"/>
  <circle cx="980" cy="180" r="100" fill="none" stroke="url(#ac)" stroke-width="2" opacity="0.18"/>
  <text x="80" y="250" font-family="Arial, Helvetica, sans-serif" font-size="96" font-weight="800" fill="#e9eef7" letter-spacing="2">ESPORTS</text>
  <text x="80" y="356" font-family="Arial, Helvetica, sans-serif" font-size="96" font-weight="800" fill="url(#ac)" letter-spacing="2">SANDBOX</text>
  <text x="84" y="424" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="600" fill="#9aa6ba" letter-spacing="3">MATCH PREDICTION SIMULATOR</text>
  <text x="84" y="510" font-family="Arial, Helvetica, sans-serif" font-size="24" fill="#6c788d">CS2 · VALORANT · LOL · DOTA2 · KPL · MLBB · OW · R6</text>
  <rect x="84" y="540" width="72" height="4" rx="2" fill="url(#ac)"/>
</svg>`;

await sharp(Buffer.from(icon)).resize(200, 200).png().toFile("public/icon.png");
await sharp(Buffer.from(cover)).png().toFile("public/cover-1.png");
console.log("assets written: public/icon.png, public/cover-1.png");
