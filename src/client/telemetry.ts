import * as Debug from '../core/debug';
import * as Protocol from '../core/protocol';
import { env } from '../env';
import type { EngineClient } from './client';
import type { NetStats } from './net';
import * as Net from './net';
import * as Rooms from './rooms';
import { ensureDebugDashboard, setDebugDashboardOpen } from './ui/dashboard';
import { useClient } from './ui/stores/client-store';

export type Telemetry = {
    metricsSubscribed: boolean;
    debugLogsSubscribed: boolean;
};

export function init(): Telemetry {
    return { metricsSubscribed: false, debugLogsSubscribed: false };
}

// a rejoin drops the server's subscription (disconnect cleanup); clear the edge
// flags so the next reconcile re-subscribes if the panel is still open.
export function resetSubscriptions(telemetry: Telemetry): void {
    telemetry.metricsSubscribed = false;
    telemetry.debugLogsSubscribed = false;
}

// gate frame recording on the panel being open: the scope calls add up on profile
// traces, only the panel consumes them, and a disabled profiler releases its ring.
// opening the panel builds the dashboard and subscribes to the server's frames.
export function bindToStore(state: EngineClient): void {
    let prevDebugOpen = useClient.getState().debugOpen;
    Debug.setEnabled(state.profiler, prevDebugOpen);
    useClient.subscribe((s) => {
        if (s.debugOpen === prevDebugOpen) return;
        prevDebugOpen = s.debugOpen;
        Debug.setEnabled(state.profiler, s.debugOpen);
        for (const room of state.rooms.rooms.values()) Debug.setEnabled(room.serverProfiler, s.debugOpen);
        if (s.debugOpen) ensureDebugDashboard().setOpen(true);
        else setDebugDashboardOpen(false);
    });
}

// edge-triggered subscribe/unsubscribe: one message per open/close. server
// pushes room_frames (server-throttled) for every room we hold a Player in
// while subscribed. debug_logs is editor-only.
export function reconcileSubscriptions(state: EngineClient): void {
    const debugOpen = useClient.getState().debugOpen;

    if (debugOpen !== state.telemetry.metricsSubscribed) {
        Net.send(state.net, { type: 'metrics_subscribe', enabled: debugOpen });
        state.telemetry.metricsSubscribed = debugOpen;
    }

    if (env.editor && debugOpen !== state.telemetry.debugLogsSubscribed) {
        Net.send(state.net, { type: 'debug_subscribe', enabled: debugOpen });
        state.telemetry.debugLogsSubscribed = debugOpen;
    }
}

/** mirror a server frame into the room's server-side ring. the packet carries the
 *  names minted since our last one (ids are dense and assigned in order, so the
 *  tail is all we need) followed by the frame's columns. */
export function applyRoomFrames(rooms: Rooms.Rooms, message: Protocol.RoomFrames): void {
    for (const room of Rooms.getRoomsByRoomId(rooms, message.roomId)) {
        const profiler = room.serverProfiler;
        for (let i = 0; i < message.keys.length; i++) {
            const id = Debug.intern(profiler, message.keys[i]!);
            const unit = message.units[i];
            if (unit) profiler.unitById[id] = unit;
        }
        Debug.pushFrame(profiler, {
            duration: message.duration,
            count: message.spanKey.length,
            key: message.spanKey,
            depth: message.spanDepth,
            start: message.spanStart,
            end: message.spanEnd,
            counterCount: message.counterKey.length,
            counterKey: message.counterKey,
            counterValue: message.counterValue,
        });
    }
}

export function applyDebugLogs(rooms: Rooms.Rooms, message: Protocol.DebugLogs): void {
    for (const room of Rooms.getRoomsByRoomId(rooms, message.roomId)) {
        if (message.dropped > 0) {
            Debug.pushLog(room.serverLogs, {
                ts: Date.now(),
                level: 'warn',
                msg: `... ${message.dropped} server log entries dropped (buffer overflow)`,
                source: undefined,
            });
        }
        for (const entry of message.entries) {
            Debug.pushLog(room.serverLogs, entry);
        }
    }
}

// per-message-type net rates (net/{in,out}/<type>), a game headline excluding
// debug traffic (net/ingress|egress), and true totals (net/{in,out}/total). a type
// that goes quiet simply records nothing that frame, and the panel's history reads
// the gap as zero — no stale value to decay.
export function recordNetStats(profiler: Debug.Profiler, stats: NetStats, delta: number): void {
    let inGame = 0;
    let outGame = 0;
    for (const [type, bytes] of stats.bytesInByType) {
        Debug.record(profiler, `net/in/${type}`, bytes / 1024 / delta, 'kb/s');
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) inGame += bytes;
    }
    for (const [type, bytes] of stats.bytesOutByType) {
        Debug.record(profiler, `net/out/${type}`, bytes / 1024 / delta, 'kb/s');
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) outGame += bytes;
    }
    Debug.record(profiler, 'net/ingress', inGame / 1024 / delta, 'kb/s');
    Debug.record(profiler, 'net/egress', outGame / 1024 / delta, 'kb/s');
    Debug.record(profiler, 'net/in/total', stats.bytesIn / 1024 / delta, 'kb/s');
    Debug.record(profiler, 'net/out/total', stats.bytesOut / 1024 / delta, 'kb/s');
}
