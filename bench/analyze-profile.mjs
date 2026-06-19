// Reads a V8 .cpuprofile and prints the top functions by self-time (leaf samples)
// as text — a profile viewer for agentic loops, no speedscope/DevTools needed.
//
//   node bench/analyze-profile.mjs profiles/diff-static.cpuprofile [topN]

import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
    console.error('usage: node bench/analyze-profile.mjs <file.cpuprofile> [topN]');
    process.exit(1);
}
const topN = Number(process.argv[3] ?? 25);
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));

const byId = new Map();
for (const n of prof.nodes) byId.set(n.id, n);

const shortUrl = (u) =>
    (u || '')
        .replace(/^file:\/\//, '')
        .replace(/.*\/node_modules\/\.pnpm\/[^/]+\/node_modules\//, '')
        .replace(/.*\/node_modules\//, '')
        .replace(/.*\/lib\//, 'lib/');

// line-level self-samples via positionTicks (the line within a function where a
// sample hit). falls back to the function's start line when line info is absent.
const lineSelf = new Map();
const fnSelf = new Map();
let totalTicks = 0;
for (const node of prof.nodes) {
    const f = node.callFrame;
    const fn = f.functionName || '(anonymous)';
    const url = shortUrl(f.url);
    if (node.positionTicks?.length) {
        for (const { line, ticks } of node.positionTicks) {
            totalTicks += ticks;
            lineSelf.set(`${fn}  ${url}:${line}`, (lineSelf.get(`${fn}  ${url}:${line}`) ?? 0) + ticks);
            fnSelf.set(`${fn}  ${url}`, (fnSelf.get(`${fn}  ${url}`) ?? 0) + ticks);
        }
    } else if (node.hitCount) {
        totalTicks += node.hitCount;
        const lk = `${fn}  ${url}:${(f.lineNumber ?? 0) + 1}`;
        lineSelf.set(lk, (lineSelf.get(lk) ?? 0) + node.hitCount);
        fnSelf.set(`${fn}  ${url}`, (fnSelf.get(`${fn}  ${url}`) ?? 0) + node.hitCount);
    }
}

const pct = (t) => ((100 * t) / totalTicks).toFixed(1).padStart(5);
console.log(`total ${totalTicks} samples · ${file}\n`);

console.log('by function:\n  self%  function');
for (const [k, t] of [...fnSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${pct(t)}  ${k}`);
}

console.log('\nby line:\n  self%  function : line');
for (const [k, t] of [...lineSelf.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
    console.log(`  ${pct(t)}  ${k}`);
}
