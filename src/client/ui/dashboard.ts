// ── debug dashboard ─────────────────────────────────────────────────
//
// the client's debug surface: one `Dashboard` from the widget toolkit in
// client/debug, opened by
// backtick. replaces the old React + <canvas> panel. engine panels (perf
// graphs, logs) live here; games dock their own panels alongside via
// `ctx.client.debug.dashboard` or the scoped `debug.panel(ctx, …)` helper.
//
// a single module-level instance backs every room's `ctx.client.debug`
// (there is one client per page). it is created lazily on first access —
// backtick opening it, or a game calling `debug.panel(ctx)` — so nothing
// is built until debug is actually used. reconcile of the dynamic perf
// metric set runs on an interval only while the dashboard is open;
// the toolkit's own ticker samples the monitors.

import { type Vec3, vec3 } from 'math';
import { CharacterControllerTrait } from '../../builtins/character-controller';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../../builtins/transform';
import * as Debug from '../../core/debug';
import { registry } from '../../core/registry';
import * as SceneTree from '../../core/scene/scene-tree';
import { stateToBlock } from '../../core/voxels/block-registry';
import { CHUNK_BITS } from '../../core/voxels/voxels';
import { env } from '../../env';
import { type Container, type Dashboard, dashboard, hashColor, type LogEntry, type TabGroup } from '../debug';
import type { ClientRoom } from '../rooms';
import { addAtlasTab } from './dashboard-atlas';
import { useClient } from './stores/client-store';
import { UILayer } from './util/ui-layers';

// ── live reads off the client store (same source the old PerfCanvas used) ──

function activeRoom(): ClientRoom | null {
    const s = useClient.getState();
    return s.activePlayerId != null ? (s.rooms.get(s.activePlayerId) ?? null) : null;
}

function clientProfiler(): Debug.Profiler | null {
    return useClient.getState().clientProfiler;
}

/** the server's mirrored frames for the active room (fed by `room_frames`). */
function serverProfiler(): Debug.Profiler | null {
    return activeRoom()?.serverProfiler ?? null;
}

/** the active room's scope key in the server frame, the parent of its phases. */
function serverRoomKey(): string | null {
    const room = activeRoom();
    return room ? `room:${room.roomId}` : null;
}

function latest(profiler: Debug.Profiler | null, key: string): number {
    return profiler ? Debug.counter(profiler, key) : 0;
}

/** short trailing average of a recorded scalar, keeps headline stats from flickering. */
function trailingAvg(profiler: Debug.Profiler | null, key: string, count: number): number {
    if (!profiler) return 0;
    const frames = Math.min(count, Debug.frameCount(profiler));
    if (frames === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += Debug.counter(profiler, key, i);
    return sum / frames;
}

/** short trailing average of a scope's inclusive time. */
function avgIncl(profiler: Debug.Profiler | null, key: string, count: number): number {
    if (!profiler) return 0;
    const frames = Math.min(count, Debug.frameCount(profiler));
    if (frames === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += Debug.inclusive(profiler, i)[key] ?? 0;
    return sum / frames;
}

/** short trailing average of whole-frame duration. */
function avgFrameMs(profiler: Debug.Profiler | null, count: number): number {
    if (!profiler) return 0;
    const frames = Math.min(count, Debug.frameCount(profiler));
    if (frames === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += Debug.frameMs(profiler, i);
    return sum / frames;
}

const SMOOTH_TICK = 30; // ~500ms at 60Hz
const SMOOTH_SERVER = 5; // server frames arrive at 5Hz, so this is a ~1s window
const SMOOTH_NET = 60; // ~1s at 60Hz

// ── position readouts ────────────────────────────────────────────────
//
// the character transform is a foot-pivot, so the subject's world position IS
// the foot position; the camera sits eye-height above it. 'foot block' is the
// integer voxel coord the foot occupies.

function nodeWorldPos(node: SceneTree.Node | null | undefined): Vec3 | null {
    if (!node) return null;
    const t = SceneTree.getTrait(node, TransformTrait);
    return t ? getWorldPosition(t) : null;
}

/** the node whose feet we report: the POV subject, falling back to the player body. */
function footNode(): SceneTree.Node | null {
    const client = activeRoom()?.client;
    return client?.subject ?? client?.player ?? null;
}

function fmtPos(v: Vec3 | null): string {
    return v ? `${v[0].toFixed(1)}, ${v[1].toFixed(1)}, ${v[2].toFixed(1)}` : '—';
}

function fmtBlock(v: Vec3 | null): string {
    return v ? `${Math.floor(v[0])}, ${Math.floor(v[1])}, ${Math.floor(v[2])}` : '—';
}

/** chunk coord containing a world position (world >> CHUNK_BITS, per axis). */
function fmtChunk(v: Vec3 | null): string {
    if (!v) return '—';
    return `${Math.floor(v[0]) >> CHUNK_BITS}, ${Math.floor(v[1]) >> CHUNK_BITS}, ${Math.floor(v[2]) >> CHUNK_BITS}`;
}

const FORWARD: Vec3 = [0, 0, -1];
const facingScratch = vec3.create();

/** camera facing: axis-labelled compass (E=+X, W=-X, S=+Z, N=-Z) + yaw/pitch. */
function cameraFacing(): string {
    const cam = activeRoom()?.client.camera;
    const t = cam ? SceneTree.getTrait(cam, TransformTrait) : null;
    if (!t) return '—';
    const f = vec3.transformQuat(facingScratch, FORWARD, getWorldQuaternion(t));
    const compass = Math.abs(f[0]) > Math.abs(f[2]) ? (f[0] > 0 ? 'E (+X)' : 'W (-X)') : f[2] > 0 ? 'S (+Z)' : 'N (-Z)';
    const yaw = ((Math.atan2(f[0], -f[2]) * 180) / Math.PI + 360) % 360;
    const pitch = (Math.asin(Math.max(-1, Math.min(1, f[1]))) * 180) / Math.PI;
    return `${compass} · yaw ${yaw.toFixed(0)}° pitch ${pitch.toFixed(0)}°`;
}

/** the character controller on the foot node, if any (play-mode player). */
function footControlled(): CharacterControllerTrait | null {
    const node = footNode();
    return node ? (SceneTree.getTrait(node, CharacterControllerTrait) ?? null) : null;
}

/** block the feet are standing in/on, by display name. */
function standingOn(): string {
    const room = activeRoom();
    const cc = footControlled();
    // Guard the RESULT, not the inputs. `stateToBlock` can miss for more reasons
    // than an unbuilt registry (a state id left over from before an editor hot
    // reload no longer addresses a handle), and one throwing monitor kills the
    // whole poll loop for the rest of the session, not just this readout. A
    // diagnostic panel must never be the thing that breaks.
    if (!room || !cc) return '—';
    return stateToBlock(room.context.blocks, cc.state.groundBlockState)?.def?.name ?? '—';
}

/** full state key of the block under the feet, e.g. 'oak_log[axis=y]' (copyable). */
function blockKey(): string {
    const room = activeRoom();
    const cc = footControlled();
    if (!room || !cc) return '—';
    return room.context.blocks.stateToKey?.[cc.state.groundBlockState] || '—';
}

/** speed + movement-state flags from the character controller. */
function movement(): string {
    const cc = footControlled();
    if (!cc) return '—';
    const v = cc.state.velocity;
    const speed = Math.hypot(v[0], v[1], v[2]);
    const flags = [
        cc.state.grounded ? 'grounded' : 'airborne',
        cc.state.inLiquid ? 'in liquid' : null,
        cc.state.isClimbing ? 'climbing' : null,
    ]
        .filter(Boolean)
        .join(', ');
    return `${speed.toFixed(1)} m/s · ${flags}`;
}

/** time-of-day (0..1 day fraction) as HH:MM on a 24h clock. */
function fmtTimeOfDay(day: number): string {
    const mins = Math.floor((((day % 1) + 1) % 1) * 24 * 60);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

/** byte counts at readable magnitude. kB/MB over the decimal thousand, matching how the
 *  upload budget is reasoned about (a 4096-slot instance buffer at 144 B/slot is "590 kB",
 *  not "576 KiB"). */
function fmtBytes(bytes: number): string {
    if (bytes < 1000) return `${bytes.toFixed(0)} B`;
    if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
    return `${(bytes / (1000 * 1000)).toFixed(2)} MB`;
}

// ── log adapter: Debug.LogEntry → toolkit LogEntry, gated on `pushed` ──
//
// the log monitor polls the source getter every frame; re-mapping
// the whole buffer each poll would allocate thousands of objects a second.
// cache the mapped array and rebuild only when the buffer changes.

function toDashLog(entry: Debug.LogEntry): LogEntry {
    const tag = entry.source ? `[${entry.source.traitId}#${entry.source.nodeId}]` : '[engine]';
    const level = entry.level === 'log' ? 'info' : entry.level;
    return { text: `${tag} ${entry.msg}`, level, time: entry.ts };
}

function logSource(get: () => Debug.Logs | null): () => LogEntry[] {
    let cache: LogEntry[] = [];
    let seenLogs: Debug.Logs | null = null;
    let seenPushed = -1;
    return () => {
        const logs = get();
        if (!logs) {
            if (seenLogs) {
                cache = [];
                seenLogs = null;
                seenPushed = -1;
            }
            return cache;
        }
        if (logs !== seenLogs || logs.pushed !== seenPushed) {
            seenLogs = logs;
            seenPushed = logs.pushed;
            cache = logs.entries.map(toDashLog);
        }
        return cache;
    };
}

// ── reading the rings ────────────────────────────────────────────────
//
// every chart here is a read of a profiler ring: the last N frames' reductions
// (self/inclusive per scope) or the last N frames' recorded scalars, assembled
// into aligned per-series arrays for `series`. no widget keeps its own history,
// so the x-axis is real frames and a frozen ring holds every chart still at once.
//
// the phase lists are DISCOVERED from the tree (`childNames`) rather than
// hardcoded, so a stack follows the loop that produced it instead of going stale
// beside it. children of a scope are siblings by construction, so their inclusive
// times stack to their parent.

// physics phases inside the server room scope: trait sync, solver step, writeback.
const PHYSICS_PHASES = ['physics/pre', 'physics', 'physics/post'] as const;

const FRAME_BUDGET_MS = 1000 / 60; // 16.67ms — the 60fps line drawn on the frame stack

/** frames plotted per chart. bounded by the ring (see core/debug's RING_FRAMES);
 *  120 frames is the whole client ring, ~2s at 60Hz. */
const CHART_HISTORY = 120;

/** newest sample at the right; frames the ring doesn't hold read 0. */
function fillSeries(
    profiler: Debug.Profiler | null,
    keys: readonly string[],
    read: (profiler: Debug.Profiler, key: string, offset: number) => number,
    length: number,
): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    for (const key of keys) out[key] = new Array<number>(length).fill(0);
    if (!profiler) return out;
    const frames = Math.min(length, Debug.frameCount(profiler));
    for (let offset = 0; offset < frames; offset++) {
        const x = length - 1 - offset;
        for (const key of keys) out[key]![x] = read(profiler, key, offset);
    }
    return out;
}

const readIncl = (profiler: Debug.Profiler, key: string, offset: number) => Debug.inclusive(profiler, offset)[key] ?? 0;
const readCounter = (profiler: Debug.Profiler, key: string, offset: number) => Debug.counters(profiler, offset)[key] ?? 0;

/** inclusive-time history for the scopes directly inside `parent` (null = the
 *  frame's top level), discovered from the newest frame. */
function phaseSeries(profiler: Debug.Profiler | null, parent: string | null, length: number): Record<string, number[]> {
    if (!profiler) return {};
    return fillSeries(profiler, Debug.childNames(profiler, parent), readIncl, length);
}

/** inclusive-time history for a fixed set of scopes. */
function scopeSeries(profiler: Debug.Profiler | null, keys: readonly string[], length: number): Record<string, number[]> {
    return fillSeries(profiler, keys, readIncl, length);
}

/** recorded-scalar history, `display name → counter key`. */
function counterSeries(profiler: Debug.Profiler | null, keys: Record<string, string>, length: number): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const names = Object.keys(keys);
    const raw = fillSeries(profiler, Object.values(keys), readCounter, length);
    for (const name of names) out[name] = raw[keys[name]!]!;
    return out;
}

/** recorded-scalar history for every counter under `prefix`, keyed bare. the set
 *  is dynamic (message types appear at runtime), so it is read off the newest
 *  frame. `<prefix>total` is skipped so the stack sums to the true total. */
function prefixCounterSeries(profiler: Debug.Profiler | null, prefix: string, length: number): Record<string, number[]> {
    if (!profiler) return {};
    const keys = Debug.counterNames(profiler).filter((key) => key.startsWith(prefix) && key !== `${prefix}total`);
    const raw = fillSeries(profiler, keys, readCounter, length);
    const out: Record<string, number[]> = {};
    for (const key of keys) out[key.slice(prefix.length)] = smooth(raw[key]!, SMOOTH_NET_ALPHA);
    return out;
}

/** exponential smoothing over a history, for per-frame rates too spiky to read raw. */
function smooth(values: number[], alpha: number): number[] {
    let acc = values[0] ?? 0;
    const out = new Array<number>(values.length);
    for (let i = 0; i < values.length; i++) {
        acc += (values[i]! - acc) * alpha;
        out[i] = acc;
    }
    return out;
}

const SMOOTH_NET_ALPHA = 0.2;

// ── shared chart builders (reused across tabs) ───────────────────────

/** the hero chart: client frame time as a stacked band per top-level phase,
 *  with the 60fps budget as a dashed baseline. */
function addClientFrameStack(c: Container, height: number): void {
    c.series(() => phaseSeries(clientProfiler(), null, CHART_HISTORY), {
        label: 'client frame (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height,
        unit: 'ms',
        min: 0,
        baseline: FRAME_BUDGET_MS,
        hover: true,
    });
}

/** overlaid in/out throughput (not stacked — distinct flows). `side` picks the
 *  scope: 'client'/'server' show that side's in+out; omitted shows all four
 *  (the compact glance on the perf tab). */
function addThroughput(c: Container, height: number, side?: 'client' | 'server'): void {
    c.series(
        (): Record<string, number[]> => {
            if (side === 'client')
                return counterSeries(clientProfiler(), { in: 'net/ingress', out: 'net/egress' }, CHART_HISTORY);
            if (side === 'server')
                return counterSeries(serverProfiler(), { in: 'net/ingress', out: 'net/egress' }, CHART_HISTORY);
            return {
                ...counterSeries(clientProfiler(), { 'client in': 'net/ingress', 'client out': 'net/egress' }, CHART_HISTORY),
                ...counterSeries(serverProfiler(), { 'server in': 'net/ingress', 'server out': 'net/egress' }, CHART_HISTORY),
            };
        },
        { label: 'throughput (kb/s)', height, unit: 'kb/s', min: 0, hover: true },
    );
}

// ── the instance ─────────────────────────────────────────────────────

type DebugDashboard = {
    dash: Dashboard;
    tabs: TabGroup;
    setOpen(open: boolean): void;
};

let instance: DebugDashboard | null = null;

/** a tab a host adds to the debug panel (the editor's options tab). Registered
 *  before the dashboard is built it lands in order; after, it appends. */
type DashboardExtension = (tabs: TabGroup) => void;
const extensions: DashboardExtension[] = [];

export function extendDebugDashboard(extend: DashboardExtension): void {
    extensions.push(extend);
    if (instance) extend(instance.tabs);
}

/** which ring the flame reads, and how far back. 0 = newest. */
type FlameSide = 'client' | 'server';
let flameSide: FlameSide = 'client';
let flameOffset = 0;
function flameProfiler(): Debug.Profiler | null {
    return flameSide === 'client' ? clientProfiler() : serverProfiler();
}

/** one pause for the whole panel: freeze every ring the dashboard reads. the
 *  charts, the flame and the readouts are all reads of those rings, so they hold
 *  still together and can be hovered and scrubbed in peace while the game runs on. */
let paused = false;

function setPaused(next: boolean): void {
    paused = next;
    const client = clientProfiler();
    if (client) client.frozen = next;
    for (const room of useClient.getState().rooms.values()) room.serverProfiler.frozen = next;
}

function build(): DebugDashboard {
    // dashboard() manages floating panels on a full-cover layer that passes
    // pointer events through except over its panels. we open one non-closable
    // "perf" panel and tab it (overview / cpu / net / logs) via the composable
    // tabs() primitive; backtick shows/hides the whole layer.
    const dash = dashboard();
    dash.root.style.zIndex = String(UILayer.debug);
    dash.root.style.display = 'none'; // hidden until opened

    // ── debug panel: overview / perf / cpu / gpu / physics / net (/ host tabs / logs) ──
    //
    // overview is position/info readouts; the rest is perf. frames go on stacked
    // areas (a band per phase, summing to frame time) with the 60fps budget as a
    // dashed baseline — read where the ms go at a glance, hover to freeze per-band
    // values. all widgets read live getters, so they follow the active room
    // without any reconcile; the toolkit samples them.
    // start offset a little further from the top-left corner so it clears the
    // editor's top/left toolbars (the toolkit default is a tight 16px).
    const panel = dash.panel({ title: 'debug', closable: false, position: [64, 64], resizable: true });
    // widen past the toolkit default 320px (charts + label/value rows read better),
    // keeping its small-viewport clamp. inline so we don't fork the vendored css;
    // `resizable` lets the user drag from here.
    panel.root.style.width = 'min(460px, calc(100vw - 24px))';
    // one pause for the whole panel, on the chrome rather than inside a tab: it
    // freezes what every tab is reading.
    panel.add({ get: () => paused, set: setPaused }, { label: 'pause capture', listen: true });
    const tabs = panel.tabs();

    // overview: F3-style "where am i" readouts, grouped into folders.
    const overview = tabs.tab('overview');
    const str = { format: (v: string) => v }; // string monitors need an explicit (non-numeric) format
    const strCopy = { format: (v: string) => v, copy: true }; // + click-to-copy (coords, keys)
    const int = { format: (v: number) => String(v) };

    const position = overview.folder('position');
    position.monitor(() => fmtPos(nodeWorldPos(activeRoom()?.client.camera)), { label: 'camera pos', ...strCopy });
    position.monitor(() => fmtPos(nodeWorldPos(footNode())), { label: 'foot pos', ...strCopy });
    position.monitor(() => fmtBlock(nodeWorldPos(footNode())), { label: 'foot block', ...strCopy });
    position.monitor(() => fmtChunk(nodeWorldPos(footNode())), { label: 'chunk', ...strCopy });
    position.monitor(cameraFacing, { label: 'facing', ...str });

    const character = overview.folder('character');
    character.monitor(standingOn, { label: 'standing on', ...str });
    character.monitor(blockKey, { label: 'block key', ...strCopy });
    character.monitor(movement, { label: 'movement', ...str });

    const session = overview.folder('session');
    session.monitor(
        () => {
            const r = activeRoom();
            return r ? `${r.roomId} · ${r.playerMode}` : '—';
        },
        { label: 'room', ...str },
    );
    session.monitor(() => activeRoom()?.client.subject?.name ?? '—', { label: 'subject', ...str });

    const world = overview.folder('world');
    world.monitor(() => activeRoom()?.scene.nodes.size ?? 0, { label: 'nodes', ...int });
    world.monitor(() => activeRoom()?.voxels.chunks.size ?? 0, { label: 'chunks', ...int });
    world.monitor(() => activeRoom()?.clock.time ?? 0, { label: 'clock', format: (v) => `${v.toFixed(1)} s` });
    world.monitor(() => fmtTimeOfDay(activeRoom()?.environment.time ?? 0), { label: 'time of day', ...str });

    // perf: at-a-glance headline + hero frame stack + compact throughput.
    const perf = tabs.tab('perf');
    perf.monitor(() => 1000 / Math.max(avgFrameMs(clientProfiler(), SMOOTH_TICK), 0.001), {
        label: 'fps',
        format: (v) => v.toFixed(0),
    });
    perf.monitor(() => avgFrameMs(clientProfiler(), SMOOTH_TICK), { label: 'client frame', unit: 'ms' });
    // server frames arrive on the server's 5Hz push, so a few of them is already
    // a second of wall time — a 30-frame window here would lag badly.
    perf.monitor(() => avgFrameMs(serverProfiler(), SMOOTH_SERVER), { label: 'server frame', unit: 'ms' });
    perf.monitor(() => trailingAvg(clientProfiler(), 'net/ping', SMOOTH_NET), {
        label: 'ping',
        unit: 'ms',
    });
    addClientFrameStack(perf, 190);
    addThroughput(perf, 80);

    // cpu: one client chart + one server chart, each the frame time stacked per
    // top-level phase (siblings summing to ~frame time).
    const cpu = tabs.tab('cpu');
    addClientFrameStack(cpu, 210);
    // the server tick's top level: the room's whole scope alongside the process-wide
    // stages (inbox, discovery, netflush) it shares with every other room.
    cpu.series(() => phaseSeries(serverProfiler(), null, CHART_HISTORY), {
        label: 'server tick (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 190,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    // and inside this room's scope: scripts, animation, physics, lighting, chat.
    cpu.series(() => phaseSeries(serverProfiler(), serverRoomKey(), CHART_HISTORY), {
        label: 'server room (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 190,
        unit: 'ms',
        min: 0,
        hover: true,
    });

    // the host process behind this room. one server process per game-room container
    // in prod, so these are that room's utilization rather than a shared machine's.
    // sampled at ~1Hz server-side, so they move slowly by design.
    const proc = cpu.folder('server process');
    proc.monitor(() => latest(serverProfiler(), 'proc/cpu'), { label: 'cpu', format: (v) => `${v.toFixed(0)}%` });
    proc.monitor(() => latest(serverProfiler(), 'proc/rss'), { label: 'rss', unit: 'mb' });
    proc.monitor(() => latest(serverProfiler(), 'proc/heap'), { label: 'heap', unit: 'mb' });

    // gpu: what the renderer pushes and what it holds. the upload rows are the ones that
    // move day to day — a batch re-uploading its whole capacity when one slot moved shows as
    // a bytes spike with flat call count, while a caller queueing many tiny ranges shows as
    // the reverse. WebGPU-only for now: the WebGL backend records no upload counters, so
    // those rows read 0 there.
    const gpu = tabs.tab('gpu');
    gpu.monitor(() => trailingAvg(clientProfiler(), 'gpu/upload/bytes', SMOOTH_TICK), {
        label: 'upload / frame',
        format: fmtBytes,
    });
    gpu.monitor(() => trailingAvg(clientProfiler(), 'gpu/upload/calls', SMOOTH_TICK), {
        label: 'writeBuffer calls',
        format: (v) => v.toFixed(0),
    });
    gpu.monitor(() => avgIncl(clientProfiler(), 'render', SMOOTH_TICK), { label: 'render', unit: 'ms' });
    gpu.monitor(() => latest(clientProfiler(), 'gpu/draws'), { label: 'draw calls', ...int });
    // floor, not a total: indirect draws keep their counts GPU-side, so they add a draw call here
    // but no triangles. the voxel terrain draws indirect, so expect this to undercount badly.
    gpu.monitor(() => latest(clientProfiler(), 'gpu/triangles'), {
        label: 'triangles (direct only)',
        format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(0)),
    });
    gpu.series(() => counterSeries(clientProfiler(), { bytes: 'gpu/upload/bytes' }, CHART_HISTORY), {
        label: 'upload (B/frame)',
        height: 120,
        unit: 'B',
        min: 0,
        hover: true,
    });
    // the CPU half: time spent packing this frame's GPU data, per visual system.
    gpu.series(() => phaseSeries(clientProfiler(), 'visuals', CHART_HISTORY), {
        label: 'visual update (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 160,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    // mesh instance batch: how tight the partial upload actually is. `dirty` is the honest
    // change count; `span` is what the one min..max range uploads. span >> dirty is the signal
    // that scattered slots are inflating the write — 144 B per slot in the gap.
    const meshInstances = gpu.folder('mesh instances');
    meshInstances.monitor(() => latest(clientProfiler(), 'mesh/instances/alive'), {
        label: 'alive',
        ...int,
    });
    meshInstances.monitor(() => latest(clientProfiler(), 'mesh/instances/dirty'), {
        label: 'dirty / frame',
        ...int,
    });
    meshInstances.monitor(() => latest(clientProfiler(), 'mesh/instances/span'), {
        label: 'uploaded span',
        ...int,
    });
    meshInstances.series(
        () => counterSeries(clientProfiler(), { dirty: 'mesh/instances/dirty', span: 'mesh/instances/span' }, CHART_HISTORY),
        { label: 'dirty vs uploaded span', height: 80, min: 0, hover: true },
    );

    // resident objects: what the renderer is holding, not what it pushed. these should sit
    // flat once a room settles — a count that climbs frame over frame is a leak.
    const resident = gpu.folder('resident');
    resident.monitor(() => latest(clientProfiler(), 'gpu/buffers'), { label: 'buffers', ...int });
    resident.monitor(() => latest(clientProfiler(), 'gpu/buffers/raw'), {
        label: 'raw buffers (ubo)',
        ...int,
    });
    resident.monitor(() => latest(clientProfiler(), 'gpu/pipelines/render'), {
        label: 'render pipelines',
        ...int,
    });
    resident.monitor(() => latest(clientProfiler(), 'gpu/pipelines/compute'), {
        label: 'compute pipelines',
        ...int,
    });
    resident.monitor(() => latest(clientProfiler(), 'gpu/bindGroupLayouts'), {
        label: 'bind group layouts',
        ...int,
    });
    // voxel quad arena occupancy. recorded every frame by both backends; the largest-free
    // figure is the one that matters — a full arena with a fragmented free list stalls
    // chunk uploads even while usedPct looks healthy.
    const arena = gpu.folder('voxel quad arena');
    arena.monitor(() => latest(clientProfiler(), 'voxels/arena/quad/usedPct'), {
        label: 'used',
        format: (v) => `${v.toFixed(1)}%`,
    });
    arena.monitor(() => latest(clientProfiler(), 'voxels/arena/quad/largestFreePct'), {
        label: 'largest free',
        format: (v) => `${v.toFixed(1)}%`,
    });
    arena.monitor(() => latest(clientProfiler(), 'voxels/arena/quad/allocs'), {
        label: 'allocs',
        ...int,
    });
    arena.series(
        () =>
            counterSeries(
                clientProfiler(),
                { used: 'voxels/arena/quad/usedPct', 'largest free': 'voxels/arena/quad/largestFreePct' },
                CHART_HISTORY,
            ),
        { label: 'quad arena (%)', height: 80, unit: '%', min: 0, hover: true },
    );

    // voxel light volume. `queued` is the diagnostic one: the drain spends a
    // fixed per-frame budget, so its cost alone only says the queue is non-empty.
    // A queue that stays deep during ordinary play means something is re-marking
    // chunks, which is a different problem from the per-tile cost.
    const lightVol = gpu.folder('voxel light volume');
    lightVol.monitor(() => latest(clientProfiler(), 'voxels/light/queued'), {
        label: 'queued',
        ...int,
    });
    lightVol.monitor(() => latest(clientProfiler(), 'voxels/light/urgent'), {
        label: 'urgent',
        ...int,
    });
    lightVol.monitor(() => latest(clientProfiler(), 'voxels/light/bakes'), {
        label: 'bakes/frame',
        ...int,
    });
    lightVol.monitor(() => latest(clientProfiler(), 'voxels/light/tiles'), {
        label: 'tiles resident',
        ...int,
    });
    lightVol.series(
        () => counterSeries(clientProfiler(), { queued: 'voxels/light/queued', bakes: 'voxels/light/bakes' }, CHART_HISTORY),
        { label: 'light queue', height: 80, min: 0, hover: true },
    );

    // physics: isolated server physics-tick cost + live body/contact counts.
    // physics is server-authoritative (the client runs interpolation, not the
    // solver), so every reading comes off the server's mirrored frames.
    // atlas: what the shader can see. reads the renderer's atlases live, so a
    // swapped atlas (HMR, room change) shows without any wiring.
    addAtlasTab(
        tabs,
        () => useClient.getState().renderer?.atlases() ?? { voxel: null, sprite: null },
        () => registry.blockRegistry.textures,
    );

    const physics = tabs.tab('physics');
    physics.monitor(() => avgIncl(serverProfiler(), 'physics', SMOOTH_SERVER), { label: 'physics tick', unit: 'ms' });
    // pre (trait sync) + step (solver) + post (writeback), stacked = total cost.
    physics.series(() => scopeSeries(serverProfiler(), PHYSICS_PHASES, CHART_HISTORY), {
        label: 'physics tick (ms)',
        stacked: true,
        height: 160,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    const bodies = physics.folder('bodies');
    bodies.monitor(() => latest(serverProfiler(), 'physics/bodies'), { label: 'total', ...int });
    bodies.monitor(() => latest(serverProfiler(), 'physics/bodies/active'), {
        label: 'active',
        ...int,
    });
    // static / kinematic / dynamic split as live category bars (no history).
    bodies.bars(
        () => ({
            static: latest(serverProfiler(), 'physics/bodies/static'),
            kinematic: latest(serverProfiler(), 'physics/bodies/kinematic'),
            dynamic: latest(serverProfiler(), 'physics/bodies/dynamic'),
        }),
        { label: 'by motion type' },
    );
    const contacts = physics.folder('contacts');
    contacts.monitor(() => latest(serverProfiler(), 'physics/contacts'), {
        label: 'pairs',
        ...int,
    });
    contacts.monitor(() => latest(serverProfiler(), 'physics/contacts/vcc'), {
        label: 'character',
        ...int,
    });

    // net: ping + client/server throughput (all four flows overlaid) + client-side
    // per-message-type ingress/egress breakdowns (net/in/*, net/out/* are recorded
    // client-side only; the server records only its totals).
    const net = tabs.tab('net');
    net.monitor(() => trailingAvg(clientProfiler(), 'net/ping', SMOOTH_NET), {
        label: 'ping',
        unit: 'ms',
    });
    net.monitor(() => trailingAvg(clientProfiler(), 'net/ingress', SMOOTH_NET), {
        label: 'client in',
        unit: 'kb/s',
    });
    net.monitor(() => trailingAvg(clientProfiler(), 'net/egress', SMOOTH_NET), {
        label: 'client out',
        unit: 'kb/s',
    });
    net.monitor(() => trailingAvg(serverProfiler(), 'net/ingress', SMOOTH_SERVER), {
        label: 'server in',
        unit: 'kb/s',
    });
    net.monitor(() => trailingAvg(serverProfiler(), 'net/egress', SMOOTH_SERVER), {
        label: 'server out',
        unit: 'kb/s',
    });
    // ping over time — single series so spikes read at a glance (hover to freeze).
    net.series(() => counterSeries(clientProfiler(), { ping: 'net/ping' }, CHART_HISTORY), {
        label: 'ping (ms)',
        height: 130,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    addThroughput(net, 130);
    // where the bytes go: one stacked band per message type, summing to the total.
    net.series(() => prefixCounterSeries(clientProfiler(), 'net/in/', CHART_HISTORY), {
        label: 'ingress by type (kb/s)',
        stacked: true,
        height: 150,
        unit: 'kb/s',
        min: 0,
        hover: true,
    });
    net.series(() => prefixCounterSeries(clientProfiler(), 'net/out/', CHART_HISTORY), {
        label: 'egress by type (kb/s)',
        stacked: true,
        height: 150,
        unit: 'kb/s',
        min: 0,
        hover: true,
    });

    // ── frames: the captured span tree of one frame, as a flame graph ──
    //
    // pause (the panel button) freezes both rings; the offset here scrubs the
    // frames they hold. `client` reads the page's own loop, `server` the ticks
    // mirrored off `room_frames` for this room (the server's whole tick, minus
    // other rooms).
    const frames = tabs.tab('frames');
    frames.monitor(
        () => {
            const profiler = flameProfiler();
            const held = profiler ? Debug.frameCount(profiler) : 0;
            return `${paused ? 'paused' : 'recording'} · ${held} frames`;
        },
        { label: 'capture', ...str },
    );
    frames.add(
        { get: () => flameSide, set: (side: FlameSide) => (flameSide = side) },
        { label: 'side', options: ['client', 'server'] as const },
    );
    frames.add(
        { get: () => flameOffset, set: (v: number) => (flameOffset = Math.round(v)) },
        { label: 'frame (0 = newest)', min: 0, max: Debug.RING_FRAMES - 1, step: 1 },
    );
    frames.monitor(
        () => {
            const profiler = flameProfiler();
            return profiler ? Debug.frameMs(profiler, flameOffset) : 0;
        },
        { label: 'frame time', unit: 'ms' },
    );
    frames.flame(
        () => {
            const profiler = flameProfiler();
            return profiler ? Debug.getFrame(profiler, flameOffset) : null;
        },
        {
            label: 'frame spans',
            height: 280,
            name: (id) => {
                const profiler = flameProfiler();
                return profiler ? Debug.keyName(profiler, id) : String(id);
            },
        },
    );

    // host extensions: the editor's options tab lands here, before logs and
    // before the active-tab reset below.
    for (const extend of extensions) extend(tabs);

    // ── logs tab: client + server tail views (editor-only, matches the old tab) ──
    if (env.editor) {
        const logs = tabs.tab('logs');
        logs.log(
            logSource(() => activeRoom()?.clientLogs ?? null),
            { label: 'client', timestamps: true, max: 2000 },
        );
        logs.log(
            logSource(() => activeRoom()?.serverLogs ?? null),
            { label: 'server', timestamps: true, max: 2000 },
        );
    }

    tabs.active('overview'); // start on overview, not the last tab added

    return {
        dash,
        tabs,
        setOpen(open) {
            dash.root.style.display = open ? '' : 'none';
            // a hidden dashboard samples nothing: the shared ticker holds, so no
            // widget reads a ring or repaints until it is shown again.
            dash.pause(!open);
        },
    };
}

/** create-or-get the singleton debug dashboard. */
export function ensureDebugDashboard(): DebugDashboard {
    if (!instance) {
        instance = build();
        // seed open state so a dashboard built while already open (e.g. a game
        // touched ctx.client.debug before first backtick) shows immediately.
        instance.setOpen(useClient.getState().debugOpen);
    }
    return instance;
}

/** drive open/close from the store's `debugOpen`. no-op if never built. */
export function setDebugDashboardOpen(open: boolean): void {
    if (instance) instance.setOpen(open);
}

// the shared ClientDebugState referenced by every room's `ctx.client.debug`.
// `dashboard` is a lazy getter so the dashboard surface is built only on first
// access. one object for all rooms — there is a single client per page.
export const clientDebug = {
    get dashboard(): Dashboard {
        return ensureDebugDashboard().dash;
    },
};
