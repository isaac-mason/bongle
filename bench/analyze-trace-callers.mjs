// Who calls the heaviest self-time frames in a trace? Resolves the ancestor chain
// for the top N self-time nodes, which is what names an `(anonymous)` hot spot.
//
//   node bench/analyze-trace-callers.mjs <trace.json> [topN] [depth]

import fs from 'node:fs';

const [, , file, topNArg, depthArg] = process.argv;
if (!file) {
    console.error('usage: node bench/analyze-trace-callers.mjs <trace.json> [topN] [depth]');
    process.exit(1);
}
const topN = Number(topNArg ?? 6);
const depth = Number(depthArg ?? 8);

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(data) ? data : data.traceEvents;

const byId = new Map();
for (const e of events) {
    if (e.name !== 'Profile' && e.name !== 'ProfileChunk') continue;
    let entry = byId.get(e.id);
    if (!entry) {
        entry = { pid: e.pid, tid: e.tid, nodes: [], samples: [], timeDeltas: [] };
        byId.set(e.id, entry);
    }
    const d = e.args?.data;
    if (!d) continue;
    const cp = d.cpuProfile;
    if (cp?.nodes) entry.nodes.push(...cp.nodes);
    if (cp?.samples) entry.samples.push(...cp.samples);
    if (d.timeDeltas) entry.timeDeltas.push(...d.timeDeltas);
}

const scriptUrlById = new Map();
for (const p of byId.values()) {
    for (const n of p.nodes) {
        if (n.callFrame?.scriptId !== undefined && n.callFrame.url) {
            scriptUrlById.set(n.callFrame.scriptId, n.callFrame.url);
        }
    }
}
const label = (cf) => {
    const u = (cf.url || scriptUrlById.get(cf.scriptId) || `script#${cf.scriptId}`)
        .replace(/^file:\/\//, '')
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/\?.*$/, '');
    return `${cf.functionName || '(anonymous)'}  ${u}:${(cf.lineNumber ?? -1) + 1}`;
};

for (const [id, profile] of byId) {
    if (profile.samples.length === 0) continue;
    const nodeById = new Map();
    const parentOf = new Map();
    for (const n of profile.nodes) {
        nodeById.set(n.id, n);
        for (const c of n.children ?? []) parentOf.set(c, n.id);
    }

    const selfUs = new Map();
    let totalUs = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const dt = profile.timeDeltas[i] ?? 0;
        if (dt < 0) continue;
        selfUs.set(profile.samples[i], (selfUs.get(profile.samples[i]) ?? 0) + dt);
        totalUs += dt;
    }
    if (totalUs === 0) continue;

    const top = [...selfUs.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
    console.log(`\n=== profile ${id} (tid=${profile.tid}) ${(totalUs / 1000).toFixed(0)} ms ===`);
    for (const [nid, us] of top) {
        const n = nodeById.get(nid);
        if (!n) continue;
        console.log(`\n  ${((us / totalUs) * 100).toFixed(1)}%  ${(us / 1000).toFixed(0)} ms  ${label(n.callFrame)}`);
        let cur = parentOf.get(nid);
        for (let d = 0; d < depth && cur !== undefined; d++) {
            const p = nodeById.get(cur);
            if (!p) break;
            console.log(`      called by  ${label(p.callFrame)}`);
            cur = parentOf.get(cur);
        }
    }
}
