// Reconstructs the embedded V8 CPU profile(s) from a Chrome DevTools trace
// (Profile + ProfileChunk events, one series per profiled thread/target) and
// finds what's actually running underneath a named function — not just its
// own self-time, but every leaf sample where it appears as an ancestor.
//
//   node bench/analyze-trace-cpu.mjs <trace.json> <functionName>

import fs from 'node:fs';

const [, , file, fnName] = process.argv;
if (!file || !fnName) {
    console.error('usage: node bench/analyze-trace-cpu.mjs <trace.json> <functionName>');
    process.exit(1);
}

console.error('reading + parsing...');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const events = Array.isArray(data) ? data : data.traceEvents;

// group Profile/ProfileChunk by their profile id (each id = one thread's CPU profile).
const byId = new Map();
for (const e of events) {
    if (e.name !== 'Profile' && e.name !== 'ProfileChunk') continue;
    const id = e.id;
    let entry = byId.get(id);
    if (!entry) {
        entry = { pid: e.pid, tid: e.tid, startTime: undefined, nodes: [], samples: [], timeDeltas: [] };
        byId.set(id, entry);
    }
    const d = e.args?.data;
    if (!d) continue;
    if (d.startTime !== undefined) entry.startTime = d.startTime;
    const cp = d.cpuProfile;
    if (cp?.nodes) entry.nodes.push(...cp.nodes);
    if (cp?.samples) entry.samples.push(...cp.samples);
    if (d.timeDeltas) entry.timeDeltas.push(...d.timeDeltas);
}

console.error(`${byId.size} profile targets found`);

// url is only present on the FIRST node emitted for a given scriptId; later
// nodes referencing the same script omit it. build a scriptId -> url map up
// front so every node can resolve its source file regardless of which node
// happened to carry the url.
const scriptUrlById = new Map();
for (const profile of byId.values()) {
    for (const n of profile.nodes) {
        if (n.callFrame?.scriptId !== undefined && n.callFrame.url) {
            scriptUrlById.set(n.callFrame.scriptId, n.callFrame.url);
        }
    }
}

const shortUrl = (callFrame) => {
    const u = callFrame.url || scriptUrlById.get(callFrame.scriptId) || `script#${callFrame.scriptId}`;
    return u
        .replace(/^file:\/\//, '')
        .replace(/^https?:\/\/[^/]+/, '')
        .replace(/\?.*$/, '');
};

for (const [id, profile] of byId) {
    const nodeById = new Map();
    for (const n of profile.nodes) nodeById.set(n.id, n);

    const matches = profile.nodes.filter((n) => n.callFrame?.functionName === fnName);
    if (matches.length === 0) continue;

    console.log(
        `\n════ profile ${id}  (pid=${profile.pid} tid=${profile.tid})  ${profile.nodes.length} nodes, ${profile.samples.length} samples ════`,
    );
    console.log(`found ${matches.length} node(s) for "${fnName}":`);
    for (const m of matches) {
        console.log(`  node ${m.id}  ${shortUrl(m.callFrame)}:${m.callFrame.lineNumber + 1}`);
    }
    const targetIds = new Set(matches.map((m) => m.id));

    // walk each sample's ancestor chain; does it pass through a target node?
    // if so, tally the LEAF (self) function — what's actually executing while
    // fnName is somewhere up the stack. also tally total (non-leaf-only) time
    // fnName itself spends as a percentage of the whole profile.
    const isDescendant = (nodeId) => {
        let cur = nodeById.get(nodeId);
        while (cur) {
            if (targetIds.has(cur.id)) return true;
            cur = cur.parent !== undefined ? nodeById.get(cur.parent) : undefined;
        }
        return false;
    };

    let totalSamples = 0;
    let underTarget = 0;
    const leafUnderTarget = new Map();
    // also detect contiguous "runs" of consecutive samples under the target,
    // to approximate individual call durations (sum of timeDeltas across the run).
    const runs = [];
    let runStartIdx = -1;
    let runDur = 0;

    for (let i = 0; i < profile.samples.length; i++) {
        totalSamples++;
        const dt = profile.timeDeltas[i] ?? 0;
        const nodeId = profile.samples[i];
        const inside = isDescendant(nodeId);
        if (inside) {
            underTarget++;
            const node = nodeById.get(nodeId);
            const key = `${node.callFrame.functionName || '(anonymous)'}  ${shortUrl(node.callFrame)}:${node.callFrame.lineNumber + 1}`;
            leafUnderTarget.set(key, (leafUnderTarget.get(key) ?? 0) + 1);
            if (runStartIdx === -1) runStartIdx = i;
            runDur += dt;
        } else if (runStartIdx !== -1) {
            runs.push(runDur);
            runStartIdx = -1;
            runDur = 0;
        }
    }
    if (runStartIdx !== -1) runs.push(runDur);

    console.log(
        `\nsamples where "${fnName}" is an ancestor: ${underTarget} / ${totalSamples} (${((100 * underTarget) / totalSamples).toFixed(1)}%)`,
    );

    console.log(`\nleaf (self) function during those samples:`);
    for (const [k, n] of [...leafUnderTarget.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
        console.log(`  ${((100 * n) / underTarget).toFixed(1).padStart(5)}%  ${k}`);
    }

    runs.sort((a, b) => b - a);
    console.log(`\n${runs.length} contiguous call-instances detected. slowest 15 (approx wall time, us):`);
    for (const r of runs.slice(0, 15)) console.log(`  ${(r / 1000).toFixed(2)}ms`);
}
