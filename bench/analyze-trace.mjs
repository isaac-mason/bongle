// Parses a Chrome DevTools "Trace-*.json" export (Node.js CPU profiling via
// DevTools attached to --inspect) and finds the worst instances of a named
// function, then breaks down what ran inside each instance's time window.
//
//   node bench/analyze-trace.mjs <trace.json> <functionName> [topN]

import fs from 'node:fs';

const [, , file, fnName, topNArg] = process.argv;
if (!file || !fnName) {
    console.error('usage: node bench/analyze-trace.mjs <trace.json> <functionName> [topN]');
    process.exit(1);
}
const topN = Number(topNArg ?? 10);

console.error('reading...');
const raw = fs.readFileSync(file, 'utf8');
console.error('parsing...');
const data = JSON.parse(raw);
const events = Array.isArray(data) ? data : data.traceEvents;
console.error(`${events.length} trace events`);

// named duration events (Chrome's devtools-timeline synthetic "X" phase events
// reconstructed from the sampled CPU profile, one per (start,end) call instance).
const named = events.filter((e) => e.name === fnName && e.ph === 'X' && typeof e.dur === 'number');
console.error(`${named.length} named "X" events for "${fnName}"`);

if (named.length === 0) {
    // fall back: list what event names/categories exist so we can retarget.
    const catCounts = new Map();
    for (const e of events) {
        if (e.ph !== 'X') continue;
        catCounts.set(e.cat, (catCounts.get(e.cat) ?? 0) + 1);
    }
    console.log('\nno matches. "X"-phase event categories present:');
    for (const [cat, n] of [...catCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        console.log(`  ${n.toString().padStart(8)}  ${cat}`);
    }
    // sample a few X-phase names to see naming convention.
    const sampleNames = new Set();
    for (const e of events) {
        if (e.ph === 'X' && e.name) sampleNames.add(e.name);
        if (sampleNames.size > 40) break;
    }
    console.log('\nsample "X"-phase event names:');
    for (const n of sampleNames) console.log(`  ${n}`);
    process.exit(0);
}

named.sort((a, b) => b.dur - a.dur);

console.log(`\ntop ${Math.min(topN, named.length)} slowest "${fnName}" instances:\n`);
for (const e of named.slice(0, topN)) {
    console.log(`  ${(e.dur / 1000).toFixed(2)}ms  ts=${e.ts}  tid=${e.tid}  pid=${e.pid}`);
}

// for each of the top instances, find every "X"-phase event on the SAME
// thread whose interval is nested inside [ts, ts+dur], and sum duration by
// name (a rough call-tree flatten — double-counts nested calls at each level,
// which is fine for "what dominates", not for a total that must sum to 100%).
console.log(`\nwhat ran inside the ${Math.min(3, named.length)} slowest instances:\n`);
for (const target of named.slice(0, 3)) {
    const start = target.ts;
    const end = target.ts + target.dur;
    const inside = events.filter(
        (e) => e.ph === 'X' && e.tid === target.tid && e.pid === target.pid && e.ts >= start && e.ts + (e.dur ?? 0) <= end,
    );
    const byName = new Map();
    for (const e of inside) {
        byName.set(e.name, (byName.get(e.name) ?? 0) + e.dur);
    }
    console.log(`── instance @ ts=${start}, dur=${(target.dur / 1000).toFixed(2)}ms, ${inside.length} nested events ──`);
    const sorted = [...byName.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [name, dur] of sorted) {
        console.log(`  ${(dur / 1000).toFixed(3).padStart(10)}ms  ${name}`);
    }
    console.log();
}
