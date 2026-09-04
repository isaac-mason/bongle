// Top self-time functions from a Chrome DevTools trace export, per profiled thread.
// The trace-shaped sibling of `analyze-profile.mjs` (which reads a raw .cpuprofile).
//
//   node bench/analyze-trace-top.mjs <trace.json> [topN] [gapMs]
//
// Sampling gaps are dropped, not attributed. When the profiler stalls (a long GC, a
// backgrounded tab, startup), the next sample carries a `timeDelta` covering the whole
// stall, and V8 charges it to whichever function was on the stack. One 851 ms gap in a
// 1000-character capture put `refreshStates` at 16.6% of the thread when its real share
// was 6.8%. Deltas over `gapMs` (default 50) are excluded from both the numerator and
// the total, and reported separately so they are not silently swallowed.

import fs from 'node:fs';

const [, , file, topNArg, gapArg] = process.argv;
if (!file) {
    console.error('usage: node bench/analyze-trace-top.mjs <trace.json> [topN] [gapMs]');
    process.exit(1);
}
const topN = Number(topNArg ?? 30);
const gapUs = Number(gapArg ?? 50) * 1000;

console.error('reading + parsing...');
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
const shortUrl = (cf) =>
    (cf.url || scriptUrlById.get(cf.scriptId) || `script#${cf.scriptId}`)
        .replace(/^file:\/\//, '')
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/\?.*$/, '');

for (const [id, profile] of byId) {
    if (profile.samples.length === 0) continue;
    const nodeById = new Map();
    for (const n of profile.nodes) nodeById.set(n.id, n);

    // self time per node id, in microseconds, from the sample stream
    const selfUs = new Map();
    let totalUs = 0;
    let gapUsTotal = 0;
    let gapCount = 0;
    for (let i = 0; i < profile.samples.length; i++) {
        const dt = profile.timeDeltas[i] ?? 0;
        if (dt < 0) continue;
        if (dt > gapUs) {
            gapUsTotal += dt;
            gapCount++;
            continue;
        }
        const sid = profile.samples[i];
        selfUs.set(sid, (selfUs.get(sid) ?? 0) + dt);
        totalUs += dt;
    }
    if (totalUs === 0) continue;

    // fold by (function, file) so V8's many nodes for one function collapse
    const byFn = new Map();
    for (const [nid, us] of selfUs) {
        const n = nodeById.get(nid);
        if (!n) continue;
        const cf = n.callFrame;
        const key = `${cf.functionName || '(anonymous)'}\t${shortUrl(cf)}`;
        byFn.set(key, (byFn.get(key) ?? 0) + us);
    }

    const rows = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);
    console.log(
        `\n=== profile ${id}  (pid=${profile.pid} tid=${profile.tid})  ${profile.samples.length} samples  ${(totalUs / 1000).toFixed(0)} ms attributed ===`,
    );
    if (gapCount > 0) {
        console.log(`    (${gapCount} sampling gap(s) over ${gapUs / 1000} ms excluded, ${(gapUsTotal / 1000).toFixed(0)} ms total)`);
    }
    console.log('');
    console.log('  self%     ms  function');
    for (const [key, us] of rows) {
        const [fn, url] = key.split('\t');
        console.log(`  ${((us / totalUs) * 100).toFixed(1).padStart(5)}  ${(us / 1000).toFixed(0).padStart(5)}  ${fn}  ${url}`);
    }
}
