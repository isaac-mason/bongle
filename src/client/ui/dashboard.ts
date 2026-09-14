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

/** every `gpu/upload/*` counter, averaged over the smoothing window, as a sorted
 *  plain-text report on the clipboard.
 *
 *  Sorted by bytes descending and grouped by section, because the question being
 *  asked of it is always "what is biggest" - a dump in recording order buries that
 *  under whatever happened to be written first. */
function copyUploadDump(profiler: Debug.Profiler | null): void {
    if (!profiler) return;
    const lines: string[] = [];
    const total = trailingAvg(profiler, 'gpu/upload/bytes', SMOOTH_TICK);
    const calls = trailingAvg(profiler, 'gpu/upload/calls', SMOOTH_TICK);
    lines.push(`gpu upload: ${fmtBytes(total)}/frame over ${calls.toFixed(0)} writeBuffer calls`);
    lines.push(`draws ${latest(profiler, 'gpu/draws').toFixed(0)}  (avg over ${SMOOTH_TICK} frames)`);

    const section = (title: string, prefix: string, unit: 'B' | 'count'): void => {
        const rows = Debug.counterNames(profiler)
            .filter((key) => key.startsWith(prefix))
            .map((key) => ({ name: key.slice(prefix.length), value: trailingAvg(profiler, key, SMOOTH_TICK) }))
            .filter((row) => row.value > 0)
            .sort((a, b) => b.value - a.value);
        if (rows.length === 0) return;
        lines.push('', title);
        for (const row of rows) {
            lines.push(`  ${row.name.padEnd(40)} ${unit === 'B' ? fmtBytes(row.value) : row.value.toFixed(1)}`);
        }
    };
    section('bytes by buffer:', 'gpu/upload/by/', 'B');
    section('changed bytes (uniform blocks):', 'gpu/upload/changed/', 'B');
    section('writes per frame:', 'gpu/upload/writes/', 'count');

    navigator.clipboard?.writeText(lines.join('\n'));
}

function latest(profiler: Debug.Profiler | null, key: string): number {
    return profiler ? Debug.counter(profiler, key) : 0;
}

/** trailing average of a recorded scalar, keeps headline stats from flickering. */
function trailingAvg(profiler: Debug.Profiler | null, key: string, count: number): number {
    if (!profiler) return 0;
    const frames = Math.min(count, Debug.frameCount(profiler));
    if (frames === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += Debug.counter(profiler, key, i);
    return sum / frames;
}

function avgIncl(profiler: Debug.Profiler | null, key: string, count: number): number {
    if (!profiler) return 0;
    const frames = Math.min(count, Debug.frameCount(profiler));
    if (frames === 0) return 0;
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += Debug.inclusive(profiler, i)[key] ?? 0;
    return sum / frames;
}

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

// the character transform is a foot-pivot: the subject's world position is
// the foot position, and the camera sits eye-height above it.

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
    // guards the result, not the inputs: a throwing monitor would kill the whole poll loop.
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

/** byte counts at readable magnitude, decimal kB/MB (not KiB/MiB). */
function fmtBytes(bytes: number): string {
    if (bytes < 1000) return `${bytes.toFixed(0)} B`;
    if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(1)} kB`;
    return `${(bytes / (1000 * 1000)).toFixed(2)} MB`;
}

function toDashLog(entry: Debug.LogEntry): LogEntry {
    const tag = entry.source ? `[${entry.source.traitId}#${entry.source.nodeId}]` : '[engine]';
    const level = entry.level === 'log' ? 'info' : entry.level;
    return { text: `${tag} ${entry.msg}`, level, time: entry.ts };
}

// polled every frame; caches the mapped array and only rebuilds when the buffer changes.
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

// charts read a profiler ring directly (no widget keeps its own history), so a
// frozen ring holds every chart still at once. phase lists are discovered from
// the tree (`childNames`) rather than hardcoded, so a stack follows the loop
// that produced it; children of a scope are siblings and stack to their parent.

// physics phases inside the server room scope: trait sync, solver step, writeback.
const PHYSICS_PHASES = ['physics/pre', 'physics', 'physics/post'] as const;

const FRAME_BUDGET_MS = 1000 / 60; // 16.67ms, the 60fps line drawn on the frame stack

/** frames plotted per chart: the whole client ring, ~2s at 60Hz. */
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

function scopeSeries(profiler: Debug.Profiler | null, keys: readonly string[], length: number): Record<string, number[]> {
    return fillSeries(profiler, keys, readIncl, length);
}

/** recorded-scalar history, keyed `display name -> counter key`. */
function counterSeries(profiler: Debug.Profiler | null, keys: Record<string, string>, length: number): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    const names = Object.keys(keys);
    const raw = fillSeries(profiler, Object.values(keys), readCounter, length);
    for (const name of names) out[name] = raw[keys[name]!]!;
    return out;
}

/** recorded-scalar history for every counter under `prefix`, keyed bare. the key
 *  set is dynamic; `<prefix>total` is skipped so the stack sums to the true total. */
function prefixCounterSeries(profiler: Debug.Profiler | null, prefix: string, length: number): Record<string, number[]> {
    if (!profiler) return {};
    const keys = Debug.counterNames(profiler).filter((key) => key.startsWith(prefix) && key !== `${prefix}total`);
    const raw = fillSeries(profiler, keys, readCounter, length);
    const out: Record<string, number[]> = {};
    for (const key of keys) out[key.slice(prefix.length)] = smooth(raw[key]!, SMOOTH_NET_ALPHA);
    return out;
}

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

/** client frame time as a stacked band per top-level phase, 60fps budget as a dashed baseline. */
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

/** one physics world's tick cost, body tallies and contact counts, off `profiler`'s ring. */
function addPhysicsSide(side: Container, profiler: () => Debug.Profiler | null, smooth: number): void {
    const int = { format: (v: number) => String(v) };
    side.monitor(() => avgIncl(profiler(), 'physics', smooth), { label: 'physics tick', unit: 'ms' });
    // pre (trait sync) + step (solver) + post (writeback), stacked = total cost.
    side.series(() => scopeSeries(profiler(), PHYSICS_PHASES, CHART_HISTORY), {
        label: 'physics tick (ms)',
        stacked: true,
        height: 120,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    const bodies = side.folder('bodies');
    bodies.monitor(() => latest(profiler(), 'physics/bodies'), { label: 'total', ...int });
    bodies.monitor(() => latest(profiler(), 'physics/bodies/active'), { label: 'active', ...int });
    bodies.bars(
        () => ({
            static: latest(profiler(), 'physics/bodies/static'),
            kinematic: latest(profiler(), 'physics/bodies/kinematic'),
            dynamic: latest(profiler(), 'physics/bodies/dynamic'),
        }),
        { label: 'by motion type' },
    );
    const contacts = side.folder('contacts');
    contacts.monitor(() => latest(profiler(), 'physics/contacts'), { label: 'pairs', ...int });
    contacts.monitor(() => latest(profiler(), 'physics/contacts/vcc'), { label: 'character', ...int });
}

/** overlaid in/out throughput. `side` picks 'client'/'server'; omitted shows all four. */
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

type DebugDashboard = {
    dash: Dashboard;
    tabs: TabGroup;
    setOpen(open: boolean): void;
};

let instance: DebugDashboard | null = null;

/** a tab a host adds to the debug panel. registered before the dashboard is
 *  built it lands in order; after, it appends. */
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

/** one pause for the whole panel: freezes every ring the dashboard reads. */
let paused = false;

function setPaused(next: boolean): void {
    paused = next;
    const client = clientProfiler();
    if (client) client.frozen = next;
    for (const room of useClient.getState().rooms.values()) room.serverProfiler.frozen = next;
}

function build(): DebugDashboard {
    // dashboard() manages floating panels on a full-cover layer that passes pointer
    // events through except over its panels; backtick shows/hides the whole layer.
    const dash = dashboard();
    dash.root.style.zIndex = String(UILayer.debug);
    dash.root.style.display = 'none';

    // offset from the top-left so it clears the editor's toolbars (default is 16px).
    const panel = dash.panel({ title: 'debug', closable: false, position: [64, 64], resizable: true });
    // widen past the toolkit default 320px; inline so we don't fork the vendored css.
    panel.root.style.width = 'min(460px, calc(100vw - 24px))';
    panel.add({ get: () => paused, set: setPaused }, { label: 'pause capture', listen: true });
    const tabs = panel.tabs();

    const overview = tabs.tab('overview');
    const str = { format: (v: string) => v };
    const strCopy = { format: (v: string) => v, copy: true };
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

    const perf = tabs.tab('perf');
    perf.monitor(() => 1000 / Math.max(avgFrameMs(clientProfiler(), SMOOTH_TICK), 0.001), {
        label: 'fps',
        format: (v) => v.toFixed(0),
    });
    perf.monitor(() => avgFrameMs(clientProfiler(), SMOOTH_TICK), { label: 'client frame', unit: 'ms' });
    // server frames arrive on the server's 5Hz push, so a 30-frame window would lag badly.
    perf.monitor(() => avgFrameMs(serverProfiler(), SMOOTH_SERVER), { label: 'server frame', unit: 'ms' });
    perf.monitor(() => trailingAvg(clientProfiler(), 'net/ping', SMOOTH_NET), {
        label: 'ping',
        unit: 'ms',
    });
    addClientFrameStack(perf, 190);
    addThroughput(perf, 80);

    const cpu = tabs.tab('cpu');
    addClientFrameStack(cpu, 210);
    // server tick's top level: the room's scope alongside process-wide stages
    // (inbox, discovery, netflush) shared with every other room.
    cpu.series(() => phaseSeries(serverProfiler(), null, CHART_HISTORY), {
        label: 'server tick (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 190,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    // inside this room's scope: scripts, animation, physics, lighting, chat.
    cpu.series(() => phaseSeries(serverProfiler(), serverRoomKey(), CHART_HISTORY), {
        label: 'server room (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 190,
        unit: 'ms',
        min: 0,
        hover: true,
    });

    // one server process per game-room container in prod; sampled at ~1Hz server-side.
    const proc = cpu.folder('server process');
    proc.monitor(() => latest(serverProfiler(), 'proc/cpu'), { label: 'cpu', format: (v) => `${v.toFixed(0)}%` });
    proc.monitor(() => latest(serverProfiler(), 'proc/rss'), { label: 'rss', unit: 'mb' });
    proc.monitor(() => latest(serverProfiler(), 'proc/heap'), { label: 'heap', unit: 'mb' });

    // upload bytes spike with flat call count when a batch re-uploads its whole
    // capacity for one moved slot; the reverse means many tiny queued ranges.
    // WebGPU-only: the WebGL backend records no upload counters, so those rows read 0.
    const gpu = tabs.tab('gpu');
    // One-press snapshot of everything the upload breakdown knows, as text worth
    // pasting somewhere. Averaged over SMOOTH_TICK frames rather than sampling one:
    // a single frame catches whatever happened to upload on it, which for anything
    // phased across frames is exactly the misleading answer.
    gpu.button('copy upload dump', () => copyUploadDump(clientProfiler()));
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
    // floor, not a total: indirect draws (voxel terrain) count GPU-side, so they
    // add a draw call here but no triangles.
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
    // WHAT sent the bytes, not just how many. Keyed by `GpuBuffer.label`; buffers that never
    // asked for one fall back to `usage:byteLength`, which is already enough to pick the big
    // allocations out - a multi-megabyte `storage` row is unmistakable, and the raw uniform
    // path (per-object and per-group blocks, which own no GpuBuffer) reports as `uniform:<size>`.
    gpu.series(() => prefixCounterSeries(clientProfiler(), 'gpu/upload/by/', CHART_HISTORY), {
        label: 'upload by buffer (B/frame)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 160,
        unit: 'B',
        min: 0,
        hover: true,
    });
    // How much of each upload ACTUALLY differed from last frame. Read against the row above:
    // bytes high with changed tiny is a large mostly-static uniform block being dragged up by
    // one per-frame value, and the fix is splitting the block rather than uploading less.
    gpu.series(() => prefixCounterSeries(clientProfiler(), 'gpu/upload/changed/', CHART_HISTORY), {
        label: 'changed bytes (B/frame)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 120,
        unit: 'B',
        min: 0,
        hover: true,
    });

    // CPU half: time spent packing this frame's GPU data, per visual system.
    gpu.series(() => phaseSeries(clientProfiler(), 'visuals', CHART_HISTORY), {
        label: 'visual update (ms)',
        color: (key) => hashColor(key),
        stacked: true,
        height: 160,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    // `dirty` is the honest change count; `span` is what the min..max range uploads.
    // span >> dirty means scattered slots are inflating the write.
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

    // what the renderer holds, not what it pushed; should sit flat once a room settles.
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
    // largest-free is the figure that matters: a full arena with a fragmented free
    // list stalls chunk uploads even while usedPct looks healthy.
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

    // the drain spends a fixed per-frame budget, so a queue that stays deep during
    // ordinary play means something is re-marking chunks, not a per-tile cost problem.
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

    // reads the renderer's atlases live, so a swapped atlas (HMR, room change) shows without wiring.
    addAtlasTab(
        tabs,
        () => useClient.getState().renderer?.atlases() ?? { voxel: null, sprite: null },
        () => registry.blockRegistry.textures,
    );

    // both hosts run the full solver: the server as authority, the client for its own
    // player and predicted bodies. non-owned dynamic bodies run kinematic on the client
    // and edit mode clamps everything static, so the motion-type split differs by side.
    const physics = tabs.tab('physics');
    const clientPhysics = physics.folder('client');
    clientPhysics.add(
        { get: () => useClient.getState().showPhysicsColliders, set: (v) => useClient.getState().setShowPhysicsColliders(v) },
        { label: 'colliders', listen: true },
    );
    clientPhysics.add(
        { get: () => useClient.getState().showPhysicsContacts, set: (v) => useClient.getState().setShowPhysicsContacts(v) },
        { label: 'contacts', listen: true },
    );
    addPhysicsSide(clientPhysics, clientProfiler, SMOOTH_TICK);
    addPhysicsSide(physics.folder('server'), serverProfiler, SMOOTH_SERVER);

    // net/in/*, net/out/* per-message-type breakdowns are recorded client-side only;
    // the server records only its totals.
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
    net.series(() => counterSeries(clientProfiler(), { ping: 'net/ping' }, CHART_HISTORY), {
        label: 'ping (ms)',
        height: 130,
        unit: 'ms',
        min: 0,
        hover: true,
    });
    addThroughput(net, 130);
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

    // pause freezes both rings; the offset here scrubs the frames they hold.
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

    for (const extend of extensions) extend(tabs);

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

    tabs.active('overview');

    return {
        dash,
        tabs,
        setOpen(open) {
            dash.root.style.display = open ? '' : 'none';
            dash.pause(!open);
        },
    };
}

export function ensureDebugDashboard(): DebugDashboard {
    if (!instance) {
        instance = build();
        instance.setOpen(useClient.getState().debugOpen);
    }
    return instance;
}

export function setDebugDashboardOpen(open: boolean): void {
    if (instance) instance.setOpen(open);
}

// shared across every room's `ctx.client.debug`; `dashboard` is a lazy getter
// so the surface is built only on first access.
export const clientDebug = {
    get dashboard(): Dashboard {
        return ensureDebugDashboard().dash;
    },
};
