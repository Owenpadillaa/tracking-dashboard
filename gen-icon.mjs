import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'fs';

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0a0a0f"/>
      <stop offset="50%" stop-color="#12121a"/>
      <stop offset="100%" stop-color="#0e0e14"/>
    </linearGradient>
    <linearGradient id="aGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#818CF8"/>
      <stop offset="100%" stop-color="#6366F1"/>
    </linearGradient>
    <radialGradient id="glowGrad" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%" stop-color="rgba(99,102,241,0.12)"/>
      <stop offset="40%" stop-color="rgba(99,102,241,0.06)"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
    <linearGradient id="shineGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="rgba(255,255,255,0.03)"/>
      <stop offset="100%" stop-color="transparent"/>
    </linearGradient>
  </defs>
  
  <!-- Base rounded rect -->
  <rect width="512" height="512" rx="112" fill="url(#bgGrad)"/>
  
  <!-- Shine overlay -->
  <rect width="512" height="256" rx="112" fill="url(#shineGrad)"/>
  
  <!-- Glass border -->
  <rect x="2" y="2" width="508" height="508" rx="110" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="1.5"/>
  
  <!-- Outer glow ring -->
  <rect x="-1" y="-1" width="514" height="514" rx="113" fill="none" stroke="rgba(99,102,241,0.06)" stroke-width="1"/>
  
  <!-- Center glow -->
  <circle cx="256" cy="256" r="140" fill="url(#glowGrad)"/>
  
  <!-- Decorative rings -->
  <circle cx="256" cy="256" r="130" fill="none" stroke="rgba(99,102,241,0.08)" stroke-width="1"/>
  <circle cx="256" cy="256" r="100" fill="none" stroke="rgba(99,102,241,0.05)" stroke-width="0.8"/>
  
  <!-- A letterform -->
  <g filter="url(#aShadow)">
    <!-- Left leg -->
    <line x1="180" y1="380" x2="256" y2="120" stroke="url(#aGrad)" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Right leg -->
    <line x1="332" y1="380" x2="256" y2="120" stroke="url(#aGrad)" stroke-width="18" stroke-linecap="round" stroke-linejoin="round"/>
    <!-- Crossbar -->
    <line x1="205" y1="300" x2="307" y2="300" stroke="url(#aGrad)" stroke-width="11" stroke-linecap="round"/>
    <!-- Top vertex extended hint -->
    <line x1="256" y1="120" x2="256" y2="150" stroke="url(#aGrad)" stroke-width="18" stroke-linecap="round"/>
  </g>
</svg>`;

writeFileSync('icon.svg', svg);
console.log('SVG written');

// Generate 512x512
await sharp('icon.svg').resize(512, 512).png().toFile('icon-512.png');
console.log('icon-512.png created');

// Generate 192x192
await sharp('icon.svg').resize(192, 192).png().toFile('icon-192.png');
console.log('icon-192.png created');

// Copy 512 as default icon
import { cp } from 'fs';
cp('icon-512.png', 'icon.png', () => {});
console.log('icon.png created');
