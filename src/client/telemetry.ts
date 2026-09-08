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

// gate per-frame Debug sampling on the panel being open: the timer calls add up
// on profile traces and only the panel consumes them. server metrics stay
// always-on (they ship regardless), and opening the panel builds the dashboard.
export function bindToStore(state: EngineClient): void {
    let prevDebugOpen = useClient.getState().debugOpen;
    Debug.setEnabled(state.metrics, prevDebugOpen);
    useClient.subscribe((s) => {
        if (s.debugOpen === prevDebugOpen) return;
        prevDebugOpen = s.debugOpen;
        Debug.setEnabled(state.metrics, s.debugOpen);
        for (const room of state.rooms.rooms.values()) {
            Debug.setEnabled(room.clientMetrics, s.debugOpen);
            Debug.setEnabled(room.serverMetrics, s.debugOpen);
        }
        if (s.debugOpen) ensureDebugDashboard().setOpen(true);
        else setDebugDashboardOpen(false);
    });
}

// edge-triggered subscribe/unsubscribe: one message per open/close. server
// pushes room_metrics (server-throttled) for every room we hold a Player in
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

export function applyRoomMetrics(rooms: Rooms.Rooms, message: Protocol.RoomMetrics): void {
    for (const room of Rooms.getRoomsByRoomId(rooms, message.roomId)) {
        for (const [id, value] of Object.entries(message.values)) {
            let unit = 'ms';
            if (id === 'proc/cpu') unit = '%';
            else if (id.startsWith('proc/')) unit = 'mb';
            else if (id.startsWith('net/')) unit = 'kb/s';
            Debug.record(room.serverMetrics, id, value as number, unit);
        }
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
// debug traffic (net/ingress|egress), and true totals (net/{in,out}/total).
export function recordNetStats(metrics: Debug.Metrics, stats: NetStats, delta: number): void {
    const seen = new Set<string>();
    let inGame = 0;
    let outGame = 0;
    for (const [type, bytes] of stats.bytesInByType) {
        const id = `net/in/${type}`;
        Debug.record(metrics, id, bytes / 1024 / delta, 'kb/s');
        seen.add(id);
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) inGame += bytes;
    }
    for (const [type, bytes] of stats.bytesOutByType) {
        const id = `net/out/${type}`;
        Debug.record(metrics, id, bytes / 1024 / delta, 'kb/s');
        seen.add(id);
        if (!Protocol.DEBUG_MESSAGE_TYPES.has(type)) outGame += bytes;
    }
    Debug.record(metrics, 'net/ingress', inGame / 1024 / delta, 'kb/s');
    Debug.record(metrics, 'net/egress', outGame / 1024 / delta, 'kb/s');
    Debug.record(metrics, 'net/in/total', stats.bytesIn / 1024 / delta, 'kb/s');
    Debug.record(metrics, 'net/out/total', stats.bytesOut / 1024 / delta, 'kb/s');
    seen.add('net/in/total');
    seen.add('net/out/total');
    // stale decay: a per-type rate is only written on frames its type had
    // traffic. zero every known net/{in,out} id absent this frame so a type that
    // goes quiet reads 0 and the panel's trailing average decays instead of
    // freezing at its last instantaneous value.
    for (const id of Debug.getIds(metrics)) {
        if (!seen.has(id) && (id.startsWith('net/in/') || id.startsWith('net/out/'))) {
            Debug.record(metrics, id, 0, 'kb/s');
        }
    }
}
