// ── debug dashboard ─────────────────────────────────────────────────
//
// the client's debug surface: one vanilla dashcat Dashboard, opened by
// backtick. replaces the old React + <canvas> panel. engine panels (perf
// graphs, logs) live here; games dock their own panels alongside via
// `ctx.client.debug.dashboard` or the scoped `debug.panel(ctx, …)` helper.
//
// a single module-level instance backs every room's `ctx.client.debug`
// (there is one client per page). it is created lazily on first access —
// backtick opening it, or a game calling `debug.panel(ctx)` — so nothing
// is built until debug is actually used. reconcile of the dynamic perf
// metric set runs on an interval only while the dashboard is open;
// dashcat's own ticker samples the monitors.

import { type Container, type Dashboard, dashboard, type LogEntry } from 'dashcat';
import { type Vec3, vec3 } from 'mathcat';
import { CharacterControllerTrait } from '../../builtins/character-controller';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../../builtins/transform';
import * as Debug from '../../core/debug';
import * as SceneTree from '../../core/scene/scene-tree';
import { stateToBlock } from '../../core/voxels/block-registry';
import { CHUNK_BITS } from '../../core/voxels/voxels';
import { useEditor } from '../../editor/editor-store';
import { env } from '../../env';
import type { ClientRoom } from '../rooms';
import { useClient } from './stores/client-store';
import { UILayer } from './util/ui-layers';

// ── live reads off the client store (same source the old PerfCanvas used) ──

function activeRoom(): ClientRoom | null {
    const s = useClient.getState();
    return s.activePlayerId != null ? (s.rooms.get(s.activePlayerId) ?? null) : null;
}

function clientGlobal(): Debug.Metrics | null {
    return useClient.getState().clientGlobalMetrics;
}

function latest(metrics: Debug.Metrics | null, id: string): number {
    if (!metrics) return 0;
    const values = Debug.getValues(metrics, id);
    return values && values.length > 0 ? values[values.length - 1]! : 0;
}

/** short trailing average, keeps the headline stats from flickering per-frame. */
function trailingAvg(metrics: Debug.Metrics | null, id: string, count: number): number {
    if (!metrics) return 0;
    const values = Debug.getValues(metrics, id);
    if (!values || values.length === 0) return 0;
    const start = Math.max(0, values.length - count);
    let sum = 0;
    for (let i = start; i < values.length; i++) sum += values[i]!;
    return sum / (values.length - start);
}

const SMOOTH_TICK = 30; // ~500ms at 60Hz
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
    if (!room || !cc) return '—';
    return stateToBlock(room.context.blocks, cc.state.groundBlockState).name;
}

/** full state key of the block under the feet, e.g. 'oak_log[axis=y]' (copyable). */
function blockKey(): string {
    const room = activeRoom();
    const cc = footControlled();
    if (!room || !cc) return '—';
    return room.context.blocks.stateToKey[cc.state.groundBlockState] || '—';
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

// ── log adapter: Debug.LogEntry → dashcat LogEntry, gated on `pushed` ──
//
// dashcat's log monitor polls the source getter every frame; re-mapping
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

// ── frame-time phase taxonomy ────────────────────────────────────────
//
// the whole-frame 'tick' timer lives on the client GLOBAL metrics; the
// per-phase timers live on the active room's client metrics. these top-level
// phases are direct siblings under 'tick' (see engine-client's frame loop),
// so a stacked area of them sums to ~the frame time — that's the hero chart.
// 'render' and 'room' are themselves brackets: 'render' wraps the draw
// sub-phases below, 'room' wraps 'physics'. so the render sub-phases get their
// own stack rather than being double-counted in the frame stack.
//
// ordered biggest/most-stable first so the jittery small phases ride on top.

const FRAME_PHASES = [
    'render',
    'room',
    'animation',
    'interpolate',
    'on-update',
    'on-frame',
    'modelLighting',
    'visibility',
    'on-post-animate',
    'on-input',
    'particles-tick',
    'audio',
] as const;

// sub-phases timed inside 'render' (in webgpu.ts / webgl.ts).
const RENDER_PHASES = ['mesh', 'voxel-mesh', 'model', 'sprite', 'extruded-sprite', 'shadow', 'particle'] as const;

// server physics-tick phases: trait sync, the solver step, transform writeback.
const PHYSICS_PHASES = ['physics/pre', 'physics', 'physics/post'] as const;

const FRAME_BUDGET_MS = 1000 / 60; // 16.67ms — the 60fps line drawn on the frame stack

// samples plotted per series. dashcat samples once per frame (~60Hz), so 600 is
// a ~10s window (matches core/debug's MAX_HISTORY). the default 120 (~2s) scrolls
// too fast to read trends.
const CHART_HISTORY = 600;

/** snapshot the latest value of each id as a named series for a `lines` chart.
 *  always emits every id (zeros for absent ones) so series order + colors stay
 *  stable across frames and room switches. */
function seriesFrom(metrics: Debug.Metrics | null, ids: readonly string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of ids) out[id] = latest(metrics, id);
    return out;
}

/** every ms-unit component on a metrics buffer except the total 'tick' and net
 *  counters — used for the server stack, where the phase taxonomy isn't pinned
 *  down yet (nested timers may over-count; refine with a server phase list). */
function msComponents(metrics: Debug.Metrics | null): Record<string, number> {
    const out: Record<string, number> = {};
    if (!metrics) return out;
    for (const id of Debug.getIds(metrics)) {
        if (id === 'tick' || id.startsWith('net/')) continue;
        if (Debug.getUnit(metrics, id) !== 'ms') continue;
        out[id] = latest(metrics, id);
    }
    return out;
}

/** per-message-type net series under a prefix ('net/in/' | 'net/out/'), keyed by
 *  bare type name for the legend. skips the '<prefix>total' sum so a stacked area
 *  of these sums to the true total. dynamic: message types appear at runtime. */
function netSeries(metrics: Debug.Metrics | null, prefix: string): Record<string, number> {
    const out: Record<string, number> = {};
    if (!metrics) return out;
    for (const id of Debug.getIds(metrics)) {
        if (!id.startsWith(prefix) || id === `${prefix}total`) continue;
        out[id.slice(prefix.length)] = latest(metrics, id);
    }
    return out;
}

// ── shared chart builders (reused across tabs) ───────────────────────

/** the hero chart: client frame time as a stacked band per top-level phase,
 *  with the 60fps budget as a dashed baseline. */
function addClientFrameStack(c: Container, height: number): void {
    c.lines(() => seriesFrom(activeRoom()?.clientMetrics ?? null, FRAME_PHASES), {
        label: 'client frame (ms)',
        stacked: true,
        height,
        unit: 'ms',
        min: 0,
        baseline: FRAME_BUDGET_MS,
        smooth: 0.2,
        hover: true,
        history: CHART_HISTORY,
    });
}

/** overlaid in/out throughput (not stacked — distinct flows). `side` picks the
 *  scope: 'client'/'server' show that side's in+out; omitted shows all four
 *  (the compact glance on the perf tab). */
function addThroughput(c: Container, height: number, side?: 'client' | 'server'): void {
    c.lines(
        (): Record<string, number> => {
            const room = activeRoom();
            const client = room?.clientMetrics ?? null;
            const server = room?.serverMetrics ?? null;
            if (side === 'client') return { in: latest(client, 'net/ingress'), out: latest(client, 'net/egress') };
            if (side === 'server') return { in: latest(server, 'net/ingress'), out: latest(server, 'net/egress') };
            return {
                'client in': latest(client, 'net/ingress'),
                'client out': latest(client, 'net/egress'),
                'server in': latest(server, 'net/ingress'),
                'server out': latest(server, 'net/egress'),
            };
        },
        { label: 'throughput (kb/s)', height, unit: 'kb/s', min: 0, smooth: 0.2, hover: true, history: CHART_HISTORY },
    );
}

// ── the instance ─────────────────────────────────────────────────────

type DebugDashboard = {
    dash: Dashboard;
    setOpen(open: boolean): void;
};

let instance: DebugDashboard | null = null;

function build(): DebugDashboard {
    // dashboard() manages floating panels on a full-cover layer that passes
    // pointer events through except over its panels. we open one non-closable
    // "perf" panel and tab it (overview / cpu / net / logs) via the composable
    // tabs() primitive; backtick shows/hides the whole layer.
    const dash = dashboard();
    dash.root.style.zIndex = String(UILayer.debug);
    dash.root.style.display = 'none'; // hidden until opened

    // ── debug panel: overview / perf / cpu / net (/ logs) tabs ──
    //
    // overview is position/info readouts; the rest is perf. frames go on stacked
    // areas (a band per phase, summing to frame time) with the 60fps budget as a
    // dashed baseline — read where the ms go at a glance, hover to freeze per-band
    // values. all widgets read live getters, so they follow the active room
    // without any reconcile; dashcat samples them.
    // start offset a little further from the top-left corner so it clears the
    // editor's top/left toolbars (dashcat's default is a tight 16px).
    const panel = dash.panel({ title: 'debug', closable: false, position: [64, 64], resizable: true });
    // widen past dashcat's default 320px (charts + label/value rows read better),
    // keeping its small-viewport clamp. inline so we don't fork the vendored css;
    // `resizable` lets the user drag from here.
    panel.root.style.width = 'min(460px, calc(100vw - 24px))';
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
    world.monitor(() => activeRoom()?.nodes.nodes.size ?? 0, { label: 'nodes', ...int });
    world.monitor(() => activeRoom()?.voxels.chunks.size ?? 0, { label: 'chunks', ...int });
    world.monitor(() => activeRoom()?.clock.time ?? 0, { label: 'clock', format: (v) => `${v.toFixed(1)} s` });
    world.monitor(() => fmtTimeOfDay(activeRoom()?.environment.time ?? 0), { label: 'time of day', ...str });

    // perf: at-a-glance headline + hero frame stack + compact throughput.
    const perf = tabs.tab('perf');
    perf.monitor(() => 1000 / Math.max(trailingAvg(clientGlobal(), 'tick', SMOOTH_TICK), 0.001), {
        label: 'fps',
        format: (v) => v.toFixed(0),
    });
    perf.monitor(() => trailingAvg(clientGlobal(), 'tick', SMOOTH_TICK), { label: 'client frame', unit: 'ms' });
    perf.monitor(() => trailingAvg(activeRoom()?.serverMetrics ?? null, 'tick', SMOOTH_TICK), {
        label: 'server frame',
        unit: 'ms',
    });
    perf.monitor(() => trailingAvg(activeRoom()?.clientMetrics ?? null, 'net/ping', SMOOTH_NET), {
        label: 'ping',
        unit: 'ms',
    });
    addClientFrameStack(perf, 190);
    addThroughput(perf, 80);

    // cpu: the full frame breakdown — top-level phases + render internals + server.
    const cpu = tabs.tab('cpu');
    addClientFrameStack(cpu, 210);
    // render internals, stacked (sub-phases timed inside the 'render' band above).
    cpu.lines(() => seriesFrom(activeRoom()?.clientMetrics ?? null, RENDER_PHASES), {
        label: 'render (ms)',
        stacked: true,
        height: 140,
        unit: 'ms',
        min: 0,
        smooth: 0.2,
        hover: true,
        history: CHART_HISTORY,
    });
    // server frame time, stacked components (see msComponents caveat).
    cpu.lines(() => msComponents(activeRoom()?.serverMetrics ?? null), {
        label: 'server frame (ms)',
        stacked: true,
        height: 140,
        unit: 'ms',
        min: 0,
        smooth: 0.2,
        hover: true,
        history: CHART_HISTORY,
    });

    // physics: isolated server physics-tick cost + live body/contact counts.
    // physics is server-authoritative (the client runs interpolation, not the
    // solver), so every reading comes off serverMetrics.
    const physics = tabs.tab('physics');
    // collider overlay toggle (editor-only, same state the options tab drives).
    if (env.editor) {
        const ed = () => useEditor.getState();
        physics.add(
            { get: () => ed().showPhysicsColliders, set: (v) => ed().setShowPhysicsColliders(v) },
            { label: 'show colliders', listen: true },
        );
    }
    physics.monitor(() => trailingAvg(activeRoom()?.serverMetrics ?? null, 'physics', SMOOTH_TICK), {
        label: 'physics tick',
        unit: 'ms',
    });
    // pre (trait sync) + step (solver) + post (writeback), stacked = total cost.
    physics.lines(() => seriesFrom(activeRoom()?.serverMetrics ?? null, PHYSICS_PHASES), {
        label: 'physics tick (ms)',
        stacked: true,
        height: 160,
        unit: 'ms',
        min: 0,
        smooth: 0.2,
        hover: true,
        history: CHART_HISTORY,
    });
    const bodies = physics.folder('bodies');
    bodies.monitor(() => latest(activeRoom()?.serverMetrics ?? null, 'physics/bodies'), { label: 'total', ...int });
    bodies.monitor(() => latest(activeRoom()?.serverMetrics ?? null, 'physics/bodies/active'), {
        label: 'active',
        ...int,
    });
    // static / kinematic / dynamic split as live category bars (no history).
    bodies.bars(
        () => ({
            static: latest(activeRoom()?.serverMetrics ?? null, 'physics/bodies/static'),
            kinematic: latest(activeRoom()?.serverMetrics ?? null, 'physics/bodies/kinematic'),
            dynamic: latest(activeRoom()?.serverMetrics ?? null, 'physics/bodies/dynamic'),
        }),
        { label: 'by motion type' },
    );
    const contacts = physics.folder('contacts');
    contacts.monitor(() => latest(activeRoom()?.serverMetrics ?? null, 'physics/contacts'), {
        label: 'pairs',
        ...int,
    });
    contacts.monitor(() => latest(activeRoom()?.serverMetrics ?? null, 'physics/contacts/vcc'), {
        label: 'character',
        ...int,
    });

    // client net: ping + client throughput + per-message-type ingress/egress
    // breakdowns (net/in/*, net/out/* are recorded client-side only).
    const clientNet = tabs.tab('client net');
    clientNet.monitor(() => trailingAvg(activeRoom()?.clientMetrics ?? null, 'net/ping', SMOOTH_NET), {
        label: 'ping',
        unit: 'ms',
    });
    clientNet.monitor(() => trailingAvg(activeRoom()?.clientMetrics ?? null, 'net/ingress', SMOOTH_NET), {
        label: 'in',
        unit: 'kb/s',
    });
    clientNet.monitor(() => trailingAvg(activeRoom()?.clientMetrics ?? null, 'net/egress', SMOOTH_NET), {
        label: 'out',
        unit: 'kb/s',
    });
    addThroughput(clientNet, 110, 'client');
    // where the bytes go: one stacked band per message type, summing to the total.
    clientNet.lines(() => netSeries(activeRoom()?.clientMetrics ?? null, 'net/in/'), {
        label: 'ingress by type (kb/s)',
        stacked: true,
        height: 150,
        unit: 'kb/s',
        min: 0,
        smooth: 0.2,
        hover: true,
        history: CHART_HISTORY,
    });
    clientNet.lines(() => netSeries(activeRoom()?.clientMetrics ?? null, 'net/out/'), {
        label: 'egress by type (kb/s)',
        stacked: true,
        height: 150,
        unit: 'kb/s',
        min: 0,
        smooth: 0.2,
        hover: true,
        history: CHART_HISTORY,
    });

    // server net: server-side in/out (no per-type breakdown — not recorded server-side).
    const serverNet = tabs.tab('server net');
    serverNet.monitor(() => trailingAvg(activeRoom()?.serverMetrics ?? null, 'net/ingress', SMOOTH_NET), {
        label: 'in',
        unit: 'kb/s',
    });
    serverNet.monitor(() => trailingAvg(activeRoom()?.serverMetrics ?? null, 'net/egress', SMOOTH_NET), {
        label: 'out',
        unit: 'kb/s',
    });
    addThroughput(serverNet, 110, 'server');

    // ── options tab: editor debug toggles + ws-latency sim (editor-only) ──
    //
    // relocated from the right-sidebar DebugPane. all global editor state
    // (useEditor), bound via get/set accessors; `listen` reflects external
    // changes, `show` reveals the sim sliders only while latency sim is on.
    if (env.editor) {
        const options = tabs.tab('options');
        const ed = () => useEditor.getState();
        options.add(
            { get: () => ed().showPhysicsColliders, set: (v) => ed().setShowPhysicsColliders(v) },
            {
                label: 'physics colliders',
                listen: true,
            },
        );
        options.add({ get: () => ed().showGrid, set: (v) => ed().setShowGrid(v) }, { label: 'grid', listen: true });
        options.add(
            { get: () => ed().showOrientationCube, set: (v) => ed().setShowOrientationCube(v) },
            {
                label: 'orientation cube',
                listen: true,
            },
        );
        options.add(
            { get: () => ed().showChunkBoundaries, set: (v) => ed().setShowChunkBoundaries(v) },
            {
                label: 'chunk boundaries',
                listen: true,
            },
        );

        const simOn = () => useEditor.getState().netSimEnabled;
        options.add(
            { get: () => ed().netSimEnabled, set: (v) => ed().setNetSimEnabled(v) },
            {
                label: 'simulate ws latency',
                listen: true,
            },
        );
        options.add(
            { get: () => ed().netSimRttMs, set: (v) => ed().setNetSimRttMs(v) },
            {
                label: 'rtt ms',
                min: 0,
                max: 500,
                step: 10,
                show: simOn,
                listen: true,
            },
        );
        options.add(
            { get: () => ed().netSimJitterMs, set: (v) => ed().setNetSimJitterMs(v) },
            {
                label: 'jitter ms',
                min: 0,
                max: 300,
                step: 10,
                show: simOn,
                listen: true,
            },
        );
        options.add(
            { get: () => ed().netSimBurstMs, set: (v) => ed().setNetSimBurstMs(v) },
            {
                label: 'burst ms',
                min: 0,
                max: 1000,
                step: 10,
                show: simOn,
                listen: true,
            },
        );
        options.add(
            { get: () => ed().netSimBurstChance, set: (v) => ed().setNetSimBurstChance(v) },
            {
                label: 'burst pct',
                min: 0,
                max: 0.2,
                step: 0.01,
                show: simOn,
                listen: true,
            },
        );
    }

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
        setOpen(open) {
            dash.root.style.display = open ? '' : 'none';
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
// `dashboard` is a lazy getter so the dashcat surface is built only on first
// access. one object for all rooms — there is a single client per page.
export const clientDebug = {
    get dashboard(): Dashboard {
        return ensureDebugDashboard().dash;
    },
};
