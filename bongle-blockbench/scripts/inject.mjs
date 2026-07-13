// Inject the merged bongle plugin (bongle.js) + branding (bongle.css) into a
// built Blockbench index.html. Idempotent: running twice does not duplicate tags.
//
// Usage: node scripts/inject.mjs <path-to-index.html>

import { readFileSync, writeFileSync } from 'node:fs';

const target = process.argv[2];
if (!target) {
    console.error('usage: node scripts/inject.mjs <index.html>');
    process.exit(1);
}

const STYLE_TAG = '<link rel="stylesheet" href="bongle.css">';
// Classic (non-module) script; the plugin waits internally for the Blockbench
// bundle to define the plugin API before registering.
const SCRIPT_TAG = '<script src="bongle.js"></script>';

// Runs before Blockbench boots (boot_loader reads `startups` for its
// startup_count). Seeding it past the first-run thresholds skips the Quick Setup
// panel + changelog/onboarding, so the embed opens straight into editing.
// Blockbench's defaults (Dark / Default keymap / English) are what we want.
const PREBOOT_TAG =
    "<script>try{if(!localStorage.getItem('startups'))localStorage.setItem('startups','20');}catch(e){}</script>";

let html = readFileSync(target, 'utf8');
if (!html.includes("localStorage.setItem('startups'")) {
    html = html.replace('<head>', `<head>\n\t${PREBOOT_TAG}`);
}
if (!html.includes(STYLE_TAG)) {
    html = html.replace('</head>', `\t${STYLE_TAG}\n</head>`);
}
if (!html.includes(SCRIPT_TAG)) {
    html = html.replace('</body>', `\t${SCRIPT_TAG}\n</body>`);
}
writeFileSync(target, html);
console.log(`injected bongle plugin + styles into ${target}`);
