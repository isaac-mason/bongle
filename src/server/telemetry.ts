import type { Client } from 'bongle/interface';
import * as Debug from '../core/debug';
import * as Protocol from '../core/protocol';
import type { NetStats } from './net';
import * as Net from './net';
import * as Rooms from './rooms';
import type { EngineServer } from './server';

/** recording is gated on there being a subscriber: with nobody watching, the
 *  profiler is disabled and every scope call returns immediately. */
export type Telemetry = {
    /** per-client `roomId -> last cursor sent`; presence = client wants debug_logs. */
    debugLogSubscribers: Map<Client, Map<string, number>>;
    /** per-client count of interned key names already sent. ids are dense and
     *  assigned in order, so the tail past this is the dictionary delta. */
    metricsSubscribers: Map<Client, number>;
    /** seconds accumulated since the last frame push. */
    metricsPushSince: number;
    /** index of the newest frame already pushed, so each push picks the worst
     *  frame since the last one rather than re-sending or missing frames. */
    lastPushedFrame: number;
    /** reusable scratch for the per-room slice; one push at a time. */
    slice: Debug.FrameSlice;
};

export function init(): Telemetry {
    return {
        debugLogSubscribers: new Map(),
        metricsSubscribers: new Map(),
        metricsPushSince: 0,
        lastPushedFrame: -1,
        slice: Debug.createFrameSlice(),
    };
}

/** subscribe/unsubscribe a panel, and enable recording iff anyone is watching. */
export function subscribeMetrics(state: EngineServer, client: Client, enabled: boolean): void {
    const t = state.telemetry;
    if (enabled) t.metricsSubscribers.set(client, 0);
    else t.metricsSubscribers.delete(client);
    Debug.setEnabled(state.profiler, t.metricsSubscribers.size > 0);
}

export function subscribeDebugLogs(t: Telemetry, client: Client, enabled: boolean): void {
    if (enabled) {
        if (!t.debugLogSubscribers.has(client)) t.debugLogSubscribers.set(client, new Map());
    } else {
        t.debugLogSubscribers.delete(client);
    }
}

/** drop a disconnected client from both subscriber sets. */
export function dropClient(state: EngineServer, client: Client): void {
    const t = state.telemetry;
    t.debugLogSubscribers.delete(client);
    t.metricsSubscribers.delete(client);
    Debug.setEnabled(state.profiler, t.metricsSubscribers.size > 0);
}

/** per-message-type net rates + game/total aggregates into the frame. global byte
 *  counts are split evenly across rooms (1/roomCount), matching the per-room view
 *  a panel gets. a type that saw no traffic records nothing, and the panel's
 *  history reads the gap as zero. */
export function recordNetStats(profiler: Debug.Profiler, stats: NetStats, delta: number, roomCount: number): void {
    let inGame = 0;
    let outGame = 0;
    for (const [type, bytes] of stats.bytesInByType) {
        Debug.record(profiler, `net/in/${type}`, bytes / 1024 / delta / roomCount, 'kb/s');
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) inGame += bytes;
    }
    for (const [type, bytes] of stats.bytesOutByType) {
        Debug.record(profiler, `net/out/${type}`, bytes / 1024 / delta / roomCount, 'kb/s');
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) outGame += bytes;
    }
    Debug.record(profiler, 'net/ingress', inGame / 1024 / delta / roomCount, 'kb/s');
    Debug.record(profiler, 'net/egress', outGame / 1024 / delta / roomCount, 'kb/s');
    Debug.record(profiler, 'net/in/total', stats.bytesIn / 1024 / delta / roomCount, 'kb/s');
    Debug.record(profiler, 'net/out/total', stats.bytesOut / 1024 / delta / roomCount, 'kb/s');
}

// engine carries no node types; shim the two `process` calls and no-op when
// absent (browser-hosted server in tests).
type ProcessStats = {
    cpuUsage(previous?: { user: number; system: number }): { user: number; system: number };
    memoryUsage(): { rss: number; heapUsed: number };
};
const proc = (globalThis as { process?: ProcessStats }).process;

// sampled on an interval rather than every tick; a per-tick % over a ~16ms window is noise.
let lastCpuUsage: { user: number; system: number } | null = proc ? proc.cpuUsage() : null;
let procSampleAccumMs = 0;
const PROC_SAMPLE_INTERVAL_MS = 1000; // 1Hz

/** record process CPU% (of one core) + memory (RSS/heap, MB) into the frame;
 *  throttled to ~1Hz. `delta` is the tick delta in seconds. */
export function recordProcessStats(profiler: Debug.Profiler, delta: number): void {
    if (!proc || lastCpuUsage === null) return;
    procSampleAccumMs += delta * 1000;
    if (procSampleAccumMs < PROC_SAMPLE_INTERVAL_MS) return;
    const windowMs = procSampleAccumMs;
    procSampleAccumMs = 0;

    const used = proc.cpuUsage(lastCpuUsage); // microseconds of CPU since the last sample
    lastCpuUsage = proc.cpuUsage();
    Debug.record(profiler, 'proc/cpu', ((used.user + used.system) / 1000 / windowMs) * 100, '%');

    const mem = proc.memoryUsage();
    Debug.record(profiler, 'proc/rss', mem.rss / 1024 / 1024, 'mb');
    Debug.record(profiler, 'proc/heap', mem.heapUsed / 1024 / 1024, 'mb');
}

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

/** cadence the server pushes frames to subscribed panels, independent of any
 *  client's frame timing. */
const FRAME_PUSH_INTERVAL_S = 0.2; // 5Hz

/** spans shorter than this are dropped, with their subtree, before a frame goes
 *  on the wire. sub-0.05ms scopes are the bulk of a busy frame's spans and the
 *  flame graph cannot draw them anyway. */
const WIRE_MIN_SPAN_MS = 0.05;

/** pushes one profiled frame per subscribed panel, server-throttled. sends the
 *  slowest frame since the last push, not the newest. each subscriber's slice drops
 *  other rooms' subtrees but keeps shared process-wide phases (inbox, discovery,
 *  netflush). */
export function pushRoomFrames(state: EngineServer, delta: number): void {
    const t = state.telemetry;
    t.metricsPushSince += delta;
    if (t.metricsSubscribers.size === 0 || t.metricsPushSince < FRAME_PUSH_INTERVAL_S) return;
    t.metricsPushSince = 0;

    // the worst frame recorded since the last push.
    let worst: Debug.Frame | null = null;
    for (let offset = 0; offset < Debug.frameCount(state.profiler); offset++) {
        const frame = Debug.getFrame(state.profiler, offset);
        if (!frame || frame.index <= t.lastPushedFrame) break;
        if (!worst || frame.duration > worst.duration) worst = frame;
    }
    if (!worst) return;
    t.lastPushedFrame = worst.index;

    // every room's scope key except the subscriber's own is dropped from the slice.
    const roomKeys = new Map<string, number>();
    for (const room of state.rooms.rooms.values()) {
        const id = state.profiler.keyToId.get(room.profileKey);
        if (id !== undefined) roomKeys.set(room.id, id);
    }
    const drop = new Set<number>();

    for (const [client, knownKeys] of t.metricsSubscribers) {
        const seen = new Set<string>();
        for (const player of Rooms.getPlayersForClient(state.rooms, client)) {
            const roomId = player.roomId;
            if (seen.has(roomId)) continue;
            seen.add(roomId);
            if (!Rooms.getRoom(state.rooms, roomId)) continue;

            drop.clear();
            for (const [id, keyId] of roomKeys) {
                if (id !== roomId) drop.add(keyId);
            }
            Debug.sliceFrame(worst, drop, WIRE_MIN_SPAN_MS, t.slice);

            const slice = t.slice;
            Net.send(state.net, client, {
                type: 'room_frames',
                roomId,
                keys: state.profiler.idToKey.slice(knownKeys),
                units: state.profiler.unitById.slice(knownKeys),
                duration: slice.duration,
                spanKey: slice.key.slice(0, slice.count),
                spanDepth: slice.depth.slice(0, slice.count),
                spanStart: slice.start.slice(0, slice.count),
                spanEnd: slice.end.slice(0, slice.count),
                counterKey: slice.counterKey.slice(0, slice.counterCount),
                counterValue: slice.counterValue.slice(0, slice.counterCount),
            });
        }
        // mark known once served, so every room this client holds gets the same name tail.
        t.metricsSubscribers.set(client, state.profiler.idToKey.length);
    }
}
