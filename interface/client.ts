import type { ResolvedAvatar } from './server';

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

export const Channel = { RELIABLE: 0, UNRELIABLE: 1 } as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

/** The client's own player: identity + the avatar they wear. Deliberately NOT the
 *  server's identity-only `User` — the client knows its full player (the host injects
 *  it), whereas a server room's avatar is matchmaker-resolved separately. Anon hosts
 *  pass a guest id/username + a bundled/builtin avatar. */
export type ClientUser = { id: string; username: string; avatar: ResolvedAvatar };

export type ClientDriver = {
    matchmake(opts: { options: Record<string, string | number | boolean>; joinData?: Record<string, JsonValue> }): void;
    /** Send this player to a DIFFERENT project, subject to the host asking them
     *  first. Resolves false whenever the player stays (declined, target
     *  unavailable, or a host with nowhere to send them); true means the host is
     *  navigating away and this session is over. Hosts with no platform around
     *  them resolve false. */
    transfer(req: {
        slug: string;
        options: Record<string, string | number | boolean>;
        joinData?: Record<string, JsonValue>;
    }): Promise<boolean>;
    platform: Platform;
    user: ClientUser;
    /** Report what the renderer actually did, for a host that chose the backend.
     *  The host picks a backend (by probing the device) and hands it in as
     *  `?renderer=`; these tell it whether the choice held. `started` fires once the
     *  device handshake succeeds, carrying the backend the engine landed on, which
     *  differs from the requested one when it had to fall back. `deviceLost` fires
     *  if the device dies later in the session.
     *
     *  Optional: a host with nowhere to record the answer (the editor's own realms,
     *  a client booted straight off disk) omits it, and the engine still renders.
     *
     *  `none` (the load-generation backend) reports like any other. It's reachable
     *  only by asking for it, and a host that keeps backend history already ignores
     *  a session whose backend was forced, so it needs no special case. */
    graphics?: {
        started(backend: 'webgpu' | 'webgl' | 'none'): void;
        deviceLost(backend: 'webgpu' | 'webgl' | 'none'): void;
    };
    /** The game is up: the player is in a room and the frame that drew its world
     *  has been submitted. A host holding a loading screen drops it here, and a
     *  host inside a portal reports the end of loading here.
     *
     *  Nothing else tells a host this. `load()` resolving means assets are in the
     *  tab, and the socket opening means a room exists — a client can be past both
     *  with a black canvas, waiting on the join to apply or on chunk meshes to come
     *  back from the worker. So the engine says it, because only the engine knows.
     *
     *  Fired once per room, not once per session: an in-game `matchmake` tears the
     *  world down and builds another, and a host that re-raised its loading card
     *  needs telling again. Optional, like `graphics` — a host with nothing to drop
     *  omits it. */
    ready?(): void;
    send(channel: Channel, bytes: Uint8Array): void;
};

export type Platform = {
    /** Interstitial at a natural break; resolves when done or skipped. */
    commercialBreak(): Promise<void>;
    /** Opt-in ad for a reward; resolves whether the reward was earned. */
    rewardedBreak(): Promise<boolean>;
};

export type ClientApp<S = any> = {
    init: (driver: ClientDriver) => S;
    load: (state: S) => Promise<void>;
    update: (state: S, dt: number) => void;
    dispose: (state: S) => void;
    receive: (state: S, channel: Channel, bytes: Uint8Array) => void;
};

export function client<S>(app: ClientApp<S>): ClientApp<S> {
    return app;
}
