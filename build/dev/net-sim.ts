// build/dev/net-sim.ts — artificial network-latency simulation for the edit clients.
//
// Both edit clients (cli/realms/client/edit-client.ts and editor/realms/client/
// client-main.ts) pump the engine net inbox/outbox each frame. Over a local link
// that round-trip is ~0ms, which hides the snapshot-interpolation and server-clock
// jitter a real connection exposes. This holds inbound + outbound frames in
// per-direction queues and only releases each once its scheduled time arrives, so a
// dev can dial in RTT + jitter from the debug pane and reproduce the laggy-link
// condition locally.
//
// `getConfig` is read fresh per stamp, so toggling the debug pane takes effect live.
// A frame's release time is clamped to never precede the previous frame's in the
// same direction: a real WS runs over TCP, which delays and jitters but never
// reorders — reordering would also break the snapshot delta-baseline chain. When
// disabled the hold is 0, so frames release the same frame they arrive and the path
// is behaviourally identical to draining straight through.

export type NetSimConfig = {
    enabled: boolean;
    /** full round-trip in ms; split half onto each direction. */
    rttMs: number;
    /** extra per-frame uniform random [0, jitterMs] on top of the one-way delay. */
    jitterMs: number;
};

type Held<T> = { releaseAt: number; payload: T };

export type NetSimSinks<In, Out> = {
    /** hand a released inbound frame to the engine (typically `inbox.push`). */
    deliverInbound: (payload: In) => void;
    /** hand a released outbound frame to the socket (typically `ws.send`). */
    deliverOutbound: (payload: Out) => void;
};

export type NetSim<In, Out> = {
    /** stamp an inbound frame with its release time and hold it. */
    receive: (payload: In, now: number) => void;
    /** stamp an outbound frame with its release time and hold it. */
    send: (payload: Out, now: number) => void;
    /** deliver every inbound then outbound frame now due, in arrival order. */
    pump: (now: number) => void;
};

export function createNetSim<In, Out>(getConfig: () => NetSimConfig, sinks: NetSimSinks<In, Out>): NetSim<In, Out> {
    const inbound: Held<In>[] = [];
    const outbound: Held<Out>[] = [];
    let lastInboundRelease = 0;
    let lastOutboundRelease = 0;

    // one-way hold (ms) for a frame arriving now: half the RTT plus per-frame jitter.
    const holdMs = (): number => {
        const cfg = getConfig();
        if (!cfg.enabled) return 0;
        return cfg.rttMs / 2 + Math.random() * cfg.jitterMs;
    };

    const drainDue = <T>(queue: Held<T>[], now: number, deliver: (payload: T) => void): void => {
        let released = 0;
        // monotonic release times → the first not-yet-due frame ends the run.
        while (released < queue.length && queue[released]!.releaseAt <= now) {
            deliver(queue[released]!.payload);
            released++;
        }
        if (released > 0) queue.splice(0, released);
    };

    return {
        receive(payload, now) {
            lastInboundRelease = Math.max(now + holdMs(), lastInboundRelease);
            inbound.push({ releaseAt: lastInboundRelease, payload });
        },
        send(payload, now) {
            lastOutboundRelease = Math.max(now + holdMs(), lastOutboundRelease);
            outbound.push({ releaseAt: lastOutboundRelease, payload });
        },
        pump(now) {
            drainDue(inbound, now, sinks.deliverInbound);
            drainDue(outbound, now, sinks.deliverOutbound);
        },
    };
}
