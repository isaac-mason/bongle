import type { Client } from 'bongle/interface';
import * as Debug from '../core/debug';
import * as physics from '../core/physics/physics';
import * as Protocol from '../core/protocol';
import type { NetStats } from './net';
import * as Net from './net';
import * as Rooms from './rooms';
import type { EngineServer } from './server';

/**
 * Server-side debug telemetry: who's subscribed to `debug_logs` / `room_metrics`
 * and the throttled pushes to them, plus the metric recorders (net / process /
 * physics). Pushes are server-paced, independent of any client's frame timing.
 */
export type Telemetry = {
    /** per-client `roomId -> last cursor sent`; presence = client wants debug_logs. */
    debugLogSubscribers: Map<Client, Map<string, number>>;
    /** presence = client wants room_metrics for the rooms it holds a Player in. */
    metricsSubscribers: Set<Client>;
    /** seconds accumulated since the last metrics push. */
    metricsPushSince: number;
};

export function init(): Telemetry {
    return { debugLogSubscribers: new Map(), metricsSubscribers: new Set(), metricsPushSince: 0 };
}

export function subscribeMetrics(t: Telemetry, client: Client, enabled: boolean): void {
    if (enabled) t.metricsSubscribers.add(client);
    else t.metricsSubscribers.delete(client);
}

export function subscribeDebugLogs(t: Telemetry, client: Client, enabled: boolean): void {
    if (enabled) {
        if (!t.debugLogSubscribers.has(client)) t.debugLogSubscribers.set(client, new Map());
    } else {
        t.debugLogSubscribers.delete(client);
    }
}

/** drop a disconnected client from both subscriber sets. */
export function dropClient(t: Telemetry, client: Client): void {
    t.debugLogSubscribers.delete(client);
    t.metricsSubscribers.delete(client);
}

// ── recorders ───────────────────────────────────────────────────────

/** per-message-type net rates + game/total aggregates onto a room's metrics.
 *  global byte counts are split evenly across rooms (1/roomCount), matching the
 *  per-room metric model. */
export function recordNetStats(metrics: Debug.Metrics, stats: NetStats, delta: number, roomCount: number): void {
    const seen = new Set<string>();
    let inGame = 0;
    let outGame = 0;
    for (const [type, bytes] of stats.bytesInByType) {
        const id = `net/in/${type}`;
        Debug.record(metrics, id, bytes / 1024 / delta / roomCount);
        seen.add(id);
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) inGame += bytes;
    }
    for (const [type, bytes] of stats.bytesOutByType) {
        const id = `net/out/${type}`;
        Debug.record(metrics, id, bytes / 1024 / delta / roomCount);
        seen.add(id);
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) outGame += bytes;
    }
    Debug.record(metrics, 'net/ingress', inGame / 1024 / delta / roomCount);
    Debug.record(metrics, 'net/egress', outGame / 1024 / delta / roomCount);
    Debug.record(metrics, 'net/in/total', stats.bytesIn / 1024 / delta / roomCount);
    Debug.record(metrics, 'net/out/total', stats.bytesOut / 1024 / delta / roomCount);
    seen.add('net/in/total');
    seen.add('net/out/total');
    // stale decay: a per-type rate is only written on frames its type had
    // traffic. zero every known net/{in,out} id absent this frame so a type that
    // goes quiet reads 0 and the panel's trailing average decays.
    for (const id of Debug.getIds(metrics)) {
        if (!seen.has(id) && (id.startsWith('net/in/') || id.startsWith('net/out/'))) {
            Debug.record(metrics, id, 0);
        }
    }
}

// One server process per game-room container in prod, so process CPU + RSS are
// that room's utilization. The engine carries no node types, so shim the two
// `process` calls and no-op when absent (browser-hosted server in tests).
type ProcessStats = {
    cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
    memoryUsage(): { rss: number; heapUsed: number };
};
const proc = (globalThis as { process?: ProcessStats }).process;

// CPU% needs a wall-clock window to divide by, so sample on an interval rather
// than every tick (a per-tick % over a ~16ms window is mostly noise).
let lastCpuUsage: { user: number; system: number } | null = proc ? proc.cpuUsage() : null;
let procSampleAccumMs = 0;
const PROC_SAMPLE_INTERVAL_MS = 1000; // 1Hz; the 600-sample ring then holds ~10min of trend

/** record process CPU% (of one core) + memory (RSS/heap, MB) onto the global
 *  metrics bag; throttled to ~1Hz. `delta` is the tick delta in seconds. */
export function recordProcessStats(metrics: Debug.Metrics, delta: number): void {
    if (!proc || lastCpuUsage === null) return;
    procSampleAccumMs += delta * 1000;
    if (procSampleAccumMs < PROC_SAMPLE_INTERVAL_MS) return;
    const windowMs = procSampleAccumMs;
    procSampleAccumMs = 0;

    const used = proc.cpuUsage(lastCpuUsage); // microseconds of CPU since the last sample
    lastCpuUsage = proc.cpuUsage();
    Debug.record(metrics, 'proc/cpu', ((used.user + used.system) / 1000 / windowMs) * 100, '%'); // us over the wall window

    const mem = proc.memoryUsage();
    Debug.record(metrics, 'proc/rss', mem.rss / 1024 / 1024, 'mb');
    Debug.record(metrics, 'proc/heap', mem.heapUsed / 1024 / 1024, 'mb');
}

/** physics world counts (bodies by motion type, live contact pairs) onto the
 *  room metrics bag. gated on `enabled` since it walks the rigid body pool. */
export function recordPhysicsStats(metrics: Debug.Metrics, world: physics.Physics): void {
    if (!metrics.enabled) return;
    const s = physics.stats(world);
    Debug.record(metrics, 'physics/bodies', s.bodies, 'count');
    Debug.record(metrics, 'physics/bodies/active', s.active, 'count');
    Debug.record(metrics, 'physics/bodies/static', s.static, 'count');
    Debug.record(metrics, 'physics/bodies/kinematic', s.kinematic, 'count');
    Debug.record(metrics, 'physics/bodies/dynamic', s.dynamic, 'count');
    Debug.record(metrics, 'physics/contacts', s.contacts, 'count');
    Debug.record(metrics, 'physics/contacts/vcc', s.vccContacts, 'count');
}

// ── pushes ──────────────────────────────────────────────────────────

/** push debug-log deltas to subscribed clients: for each, walk every room it
 *  holds a Player in and emit one `debug_logs` per room with entries since the
 *  cached cursor. drops stale cursors for rooms it no longer observes. */
export function pushDebugLogs(state: EngineServer): void {
    if (state.telemetry.debugLogSubscribers.size === 0) return;
    for (const [client, cursors] of state.telemetry.debugLogSubscribers) {
        const seen = new Set<string>();
        for (const player of Rooms.getPlayersForClient(state.rooms, client)) {
            const roomId = player.roomId;
            if (seen.has(roomId)) continue;
            seen.add(roomId);
            const room = Rooms.getRoom(state.rooms, roomId);
            if (!room) continue;
            const cursor = cursors.get(roomId) ?? 0;
            const delta = Debug.readDelta(room.logs, cursor);
            if (delta.entries.length === 0 && delta.dropped === 0) continue;
            cursors.set(roomId, delta.cursor);
            Net.send(state.net, client, { type: 'debug_logs', roomId, entries: delta.entries, dropped: delta.dropped });
        }
        for (const key of cursors.keys()) {
            if (!seen.has(key)) cursors.delete(key);
        }
    }
}

/** cadence the server pushes room_metrics to subscribed panels, independent of
 *  any client's frame timing. */
const METRICS_PUSH_INTERVAL_S = 0.2; // 5Hz

/** push room_metrics snapshots to subscribed panels, server-throttled. each
 *  snapshot merges the room's latest values with the global (non-room) stages. */
export function pushRoomMetrics(state: EngineServer, delta: number): void {
    state.telemetry.metricsPushSince += delta;
    if (state.telemetry.metricsSubscribers.size === 0 || state.telemetry.metricsPushSince < METRICS_PUSH_INTERVAL_S) return;
    state.telemetry.metricsPushSince = 0;

    const global = Debug.getLatestValues(state.metrics);
    for (const client of state.telemetry.metricsSubscribers) {
        const seen = new Set<string>();
        for (const player of Rooms.getPlayersForClient(state.rooms, client)) {
            const roomId = player.roomId;
            if (seen.has(roomId)) continue;
            seen.add(roomId);
            const room = Rooms.getRoom(state.rooms, roomId);
            if (!room) continue;
            const values = {
                ...Debug.getLatestValues(room.metrics),
                tick: global.tick ?? 0,
                inbox: global.inbox ?? 0,
                'proc/cpu': global['proc/cpu'] ?? 0,
                'proc/rss': global['proc/rss'] ?? 0,
                'proc/heap': global['proc/heap'] ?? 0,
            };
            Net.send(state.net, client, { type: 'room_metrics', roomId: room.id, values });
        }
    }
}
