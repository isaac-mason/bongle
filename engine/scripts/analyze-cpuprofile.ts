// Reads a Node --cpu-prof output (.cpuprofile JSON) and prints
// per-function self-time, filtered to engine voxels/ source.
//
// usage: node scripts/analyze-cpuprofile.ts <path-to-cpuprofile>

import { readFileSync } from 'node:fs';

type CpuProfileNode = {
    id: number;
    callFrame: { functionName: string; url?: string; lineNumber?: number };
    children?: number[];
};
type CpuProfile = {
    nodes: CpuProfileNode[];
    samples?: number[];
    timeDeltas?: number[];
    startTime: number;
    endTime: number;
};

const path = process.argv[2];
if (!path) {
    console.error('usage: analyze-cpuprofile.ts <path>');
    process.exit(1);
}

const prof: CpuProfile = JSON.parse(readFileSync(path, 'utf-8'));
const samples = prof.samples ?? [];
const deltas = prof.timeDeltas ?? [];

// per-node self time (sum of deltas that landed on it).
const selfUs = new Map<number, number>();
for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!;
    const d = deltas[i] ?? 0;
    selfUs.set(id, (selfUs.get(id) ?? 0) + d);
}

const total = prof.endTime - prof.startTime;
let voxelsTotal = 0;

// group by (file, function-name) — V8 emits one node per call-site, so
// the same function appears N times. Sum to get its true cost.
const groups = new Map<string, { fn: string; file: string; selfMs: number; sites: number }>();
for (const node of prof.nodes) {
    const us = selfUs.get(node.id) ?? 0;
    if (us === 0) continue;
    const url = node.callFrame.url ?? '';
    if (!url.includes('voxels/')) continue;
    const file = url.replace(/^file:\/\//, '').split('/voxels/')[1] ?? url;
    const fn = node.callFrame.functionName || '(anonymous)';
    const key = `${file}::${fn}`;
    const existing = groups.get(key);
    if (existing) {
        existing.selfMs += us / 1000;
        existing.sites++;
    } else {
        groups.set(key, { fn, file, selfMs: us / 1000, sites: 1 });
    }
    voxelsTotal += us;
}
const rows = [...groups.values()].sort((a, b) => b.selfMs - a.selfMs);

console.log(`# total profile window: ${(total / 1000).toFixed(0)} ms`);
console.log(`# voxels/ self-time total: ${(voxelsTotal / 1000).toFixed(0)} ms (${((voxelsTotal / total) * 100).toFixed(1)}% of wall)`);
console.log('');
console.log(`# ${'self ms'.padStart(10)}  ${'%vox'.padStart(6)}  sites  function @ file`);
let cum = 0;
for (const r of rows.slice(0, 25)) {
    const pct = (r.selfMs * 1000 / voxelsTotal) * 100;
    cum += pct;
    console.log(
        `  ${r.selfMs.toFixed(0).padStart(10)}  ${pct.toFixed(1).padStart(5)}%  ${String(r.sites).padStart(5)}  ${r.fn}  @ ${r.file}`,
    );
}
console.log(`  ${'─'.repeat(60)}`);
console.log(`  cumulative top-25: ${cum.toFixed(1)}%`);
