// ── edit-mode perf digest ────────────────────────────────────────────
//
// formats the per-tick timing already collected in `Debug.Metrics` (the begin/end
// phase spans + the `script/<key>` per-script timings) into a compact line block
// for the server CLI. pure formatting — `engine-server` owns the cadence and the
// edit-mode gate, and does the actual `console.log`.
//
// the layout is stable + greppable (`[perf …]` prefix, `avg/max` pairs) so an
// agentic loop can parse "where is time going / is it spiking" straight from stdout.

import * as Debug from '../core/debug';

/** emit cadence (seconds of sim time) — engine-server accumulates against this. */
export const PERF_EMIT_INTERVAL_S = 1.0;
/** a tick over this many ms is counted "over budget" (60Hz frame). */
export const FRAME_BUDGET_MS = 1000 / 60;

const MIN_MS = 0.1; // hide stages/scripts cheaper than this
const TOP_SCRIPTS = 4;

// per-room tick stages, in pipeline order (matches engine-server's begin/end ids).
const STAGES = [
    'inbox',
    'nodes/update',
    'nodes/tick',
    'animation',
    'nodes/post-animate',
    'prefab',
    'physics/pre',
    'physics',
    'physics/post',
    'block-hooks',
    'lighting',
    'nodes/frame',
    'chat',
    'discovery',
];

// stages whose time is per-script — expanded to their top `script/<hook>/<key>`
// contributors. (physics-step hooks aren't timed; input is client-only.)
const STAGE_HOOKS: Record<string, string> = {
    'nodes/update': 'onUpdate',
    'nodes/tick': 'onTick',
    'nodes/post-animate': 'onPostAnimate',
    'nodes/frame': 'onFrame',
};

// whole-server (non-room) stages — read from the global tick metrics, merged into
// the same breakdown so a spike in save / drain / net-pack / discovery sub-phase
// is attributable.
const GLOBAL_STAGES = ['inbox', 'rooms/drain', 'save', 'netflush', 'discovery/diff', 'discovery/scene', 'discovery/voxels'];

type Stat = { avg: number; max: number; n: number };

function stat(values: number[] | undefined): Stat {
    if (!values || values.length === 0) return { avg: 0, max: 0, n: 0 };
    let sum = 0;
    let max = 0;
    for (const v of values) {
        sum += v;
        if (v > max) max = v;
    }
    return { avg: sum / values.length, max, n: values.length };
}

const ms = (n: number) => n.toFixed(1);

/**
 * build the digest for one room, headlined by the whole-server `tick` metric, or
 * null when nothing's been measured yet. stats are over each metric's rolling
 * history (~last 100 ticks).
 */
export function formatPerfDigest(tickMetrics: Debug.Metrics, roomMetrics: Debug.Metrics, label: string): string | null {
    const tickVals = Debug.getValues(tickMetrics, 'tick');
    const tick = stat(tickVals);
    if (tick.n === 0) return null;

    let over = 0;
    if (tickVals) for (const v of tickVals) if (v > FRAME_BUDGET_MS) over++;

    const lines = [`[perf ${label} · ${tick.n}t] tick avg ${ms(tick.avg)} max ${ms(tick.max)}ms · over-budget ${over}/${tick.n}`];

    const stages = [
        ...STAGES.map((id) => ({ id, ...stat(Debug.getValues(roomMetrics, id)) })),
        ...GLOBAL_STAGES.map((id) => ({ id, ...stat(Debug.getValues(tickMetrics, id)) })),
    ]
        .filter((s) => s.max >= MIN_MS)
        .sort((a, b) => b.max - a.max);

    for (const s of stages) {
        let line = `  ${s.id.padEnd(17)} ${ms(s.avg)}/${ms(s.max)}`;
        const hook = STAGE_HOOKS[s.id];
        if (hook) {
            const prefix = `script/${hook}/`;
            const scripts = Debug.getIds(roomMetrics)
                .filter((id) => id.startsWith(prefix))
                .map((id) => ({ name: id.slice(prefix.length), ...stat(Debug.getValues(roomMetrics, id)) }))
                .filter((x) => x.max >= MIN_MS)
                .sort((a, b) => b.max - a.max)
                .slice(0, TOP_SCRIPTS);
            if (scripts.length) line += '  ' + scripts.map((x) => `·${x.name} ${ms(x.avg)}/${ms(x.max)}`).join(' ');
        }
        lines.push(line);
    }

    return lines.join('\n');
}
