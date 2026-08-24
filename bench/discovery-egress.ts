// ── discovery egress + cost report ───────────────────────────────────
//
// what `vitest bench` can't tell you: how many bytes per second discovery pushes
// at a client, split by message type, and how that scales with player count.
// drives the shared scenario (discovery-world.ts) for a fixed number of ticks and
// prints per-phase timings alongside the byte breakdown.
//
//   ./node_modules/.bin/tsx bench/discovery-egress.ts [--clients 1,8,32] [--props N]
//                                                     [--ticks N] [--terrain floor|empty]
//                                                     [--spread BLOCKS] [--motion walk|sprint|sled|fly|idle]
//                                                     [--hz N] [--prop-churn 0..1]
//                                                     [--json]

import * as Debug from '../src/core/debug';
import {
    chunkCrossingsPerSecond,
    createWorld,
    LOCOMOTION_SPEED,
    type Locomotion,
    moveBots,
    moveProps,
    type Terrain,
} from './discovery-world';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const CLIENT_COUNTS = flag('clients', '1,8,32,64').split(',').map(Number);
const PROPS = Number(flag('props', '1000'));
const TICKS = Number(flag('ticks', '600'));
const TERRAIN = flag('terrain', 'floor') as Terrain;
const SPREAD = Number(flag('spread', '96'));
// the engine's tick rate: cli/start.ts steps at 1000/60, and discovery's rate gate
// hardcodes 60 when deciding whether an hz-capped field may send this tick.
const TICK_RATE = Number(flag('hz', '60'));
const MOTION = flag('motion', 'walk') as Locomotion;
// fraction of props that emit each tick — the background scene churn the bots move
// against. set 0 to isolate bot motion.
const PROP_CHURN = Number(flag('prop-churn', '0.2'));
const asJson = args.includes('--json');

type Row = {
    clients: number;
    settleTicks: number;
    knownNodes: number;
    knownChunks: number;
    kbPerSecPerClient: number;
    byType: Record<string, number>; // kB/s per client
    ms: Record<string, { p50: number; p95: number; max: number }>;
};

function percentiles(values: number[]): { p50: number; p95: number; max: number } {
    if (values.length === 0) return { p50: 0, p95: 0, max: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return { p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

function run(clients: number): Row {
    const world = createWorld({ clients, props: PROPS, terrain: TERRAIN, spread: SPREAD });

    // let each client's AOI region finish expanding before measuring, otherwise the
    // numbers are dominated by the one-off join stream rather than steady state.
    const settleTicks = world.settle();
    world.egress(); // discard the join burst

    // metrics are off during setup (createMetrics(false)); turn them on now so the
    // per-phase timings cover only the measured window.
    Debug.setEnabled(world.metrics, true);

    for (let tick = 0; tick < TICKS; tick++) {
        moveBots(world, tick, MOTION, TICK_RATE);
        if (PROP_CHURN > 0) moveProps(world, tick, PROP_CHURN);
        world.tick();
    }

    const stats = world.egress();
    const perClientPerSec = (bytes: number) => ((bytes / clients / TICKS) * TICK_RATE) / 1024;

    const byType: Record<string, number> = {};
    for (const [type, bytes] of stats.bytesOutByType) byType[type] = perClientPerSec(bytes);

    const ms: Record<string, { p50: number; p95: number; max: number }> = {};
    for (const id of Debug.getIds(world.metrics)) {
        ms[id] = percentiles(Debug.getValues(world.metrics, id) ?? []);
    }

    // what one client ended up knowing, as a sanity check that AOI is culling
    // rather than admitting everything.
    const inspect = world.discovery as unknown as {
        clients: Map<
            number,
            { nodeKnowledge: Map<number, Map<number, unknown>>; voxelKnowledge: Map<number, { knownChunks: Set<string> }> }
        >;
    };
    const cs = inspect.clients.get(1);
    const knownNodes = cs ? ([...cs.nodeKnowledge.values()][0]?.size ?? 0) : 0;
    const knownChunks = cs ? ([...cs.voxelKnowledge.values()][0]?.knownChunks.size ?? 0) : 0;

    return {
        clients,
        settleTicks,
        knownNodes,
        knownChunks,
        kbPerSecPerClient: perClientPerSec(stats.bytesOut),
        byType,
        ms,
    };
}

const rows = CLIENT_COUNTS.map(run);

if (asJson) {
    console.log(
        JSON.stringify({ props: PROPS, ticks: TICKS, terrain: TERRAIN, motion: MOTION, tickRate: TICK_RATE, rows }, null, 2),
    );
} else {
    const n = (v: number, w = 8, d = 1) => v.toFixed(d).padStart(w);

    console.log(
        `\ndiscovery egress — ${PROPS} props over +/-${SPREAD} blocks, terrain=${TERRAIN}, ${TICKS} ticks @ ${TICK_RATE}Hz, zero-RTT acks\n` +
            `motion=${MOTION} (${LOCOMOTION_SPEED[MOTION]} blocks/s, ${chunkCrossingsPerSecond(MOTION).toFixed(2)} chunk crossings/s)   ` +
            `prop-churn=${PROP_CHURN}   ` +
            `tick budget ${(1000 / TICK_RATE).toFixed(2)}ms\n`,
    );
    console.log('clients  settle  knownNodes  knownChunks    kB/s/client');
    for (const r of rows) {
        console.log(
            `${String(r.clients).padStart(7)}  ${String(r.settleTicks).padStart(6)}  ${String(r.knownNodes).padStart(10)}  ${String(r.knownChunks).padStart(11)}  ${n(r.kbPerSecPerClient, 14, 2)}`,
        );
    }

    const types = [...new Set(rows.flatMap((r) => Object.keys(r.byType)))].sort();
    console.log('\nkB/s per client, by message type');
    console.log(`${'type'.padEnd(22)}${rows.map((r) => String(r.clients).padStart(10)).join('')}`);
    for (const type of types) {
        console.log(`${type.padEnd(22)}${rows.map((r) => n(r.byType[type] ?? 0, 10, 2)).join('')}`);
    }

    const phases = ['discovery/diff', 'discovery/voxels', 'discovery/scene'];
    console.log('\nms per tick (p50 / p95 / max)');
    console.log(`${'phase'.padEnd(22)}${rows.map((r) => String(r.clients).padStart(22)).join('')}`);
    for (const phase of phases) {
        const cells = rows.map((r) => {
            const m = r.ms[phase];
            return m ? `${m.p50.toFixed(2)}/${m.p95.toFixed(2)}/${m.max.toFixed(2)}`.padStart(22) : ''.padStart(22);
        });
        console.log(`${phase.padEnd(22)}${cells.join('')}`);
    }
    console.log();
}
