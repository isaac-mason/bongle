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

// a rejoin drops the server's subscription; clear the flags so the next
// reconcile re-subscribes if the panel is still open
export function resetSubscriptions(telemetry: Telemetry): void {
    telemetry.metricsSubscribed = false;
    telemetry.debugLogsSubscribed = false;
}

// gate frame recording on the panel being open: a disabled profiler releases its
// ring, since only the panel consumes the recorded scopes
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

// edge-triggered: one message per open/close. debug_logs is editor-only.
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

/** mirror a server frame into the room's server-side ring. the packet carries
 *  only the names minted since our last one, since ids are dense and assigned
 *  in order. */
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

// per-message-type net rates, a game headline excluding debug traffic
// (net/ingress|egress), and true totals (net/{in,out}/total)
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
