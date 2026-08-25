// os/control.ts — the control-link protocol between the OS (os.ts) and the
// app-side runtime (runtime.ts), tunnelled over `Link`.
//
// HOST-INTERNAL: apps never see these frames — they see `Env`. Both ends ship
// with the editor, so this protocol versions with the DEPLOY, not the engine
// pin; that's why it lives here and not in the public `interface.ts`. It's the
// one contract the OS and the runtime must agree on, so it's a typed union both
// switch over (add a frame → both ends fail to compile until handled).
//
// Named by DIRECTION: `ToApp` flows OS → app, `ToOS` flows app → OS. Frames
// marked (+port) carry a transferred MessagePort in the post's transfer list,
// delivered out-of-band as `ports[0]` — the type models the frame, the
// transport carries the port.

import type { ConnMeta } from './interface';

/** OS → app/shim. */
export type ToApp =
    | { k: 'start'; ref: string; init: unknown; projectName: string; module: string; surface?: boolean } // (+port: the runner conduit)
    | { k: 'incoming'; name: string; conn: number; meta: ConnMeta } // (+port)
    | { k: 'channel'; req: number; conn: number } // (+port)
    | { k: 'closed'; conn: number }
    | { k: 'spawned'; req: number; pid: number }
    | { k: 'exited'; req: number; code: number }
    /** a `connect` that will never pair — the name is not routable, or the far side
     *  refused it. Without this an app's connect just never settles. */
    | { k: 'refused'; req: number; reason: string }
    | { k: 'stdin'; data: string | Uint8Array }
    | { k: 'dispose' };

/** app → OS. */
export type ToOS =
    | { k: 'listen'; name: string }
    | { k: 'unlisten'; name: string }
    | { k: 'connect'; name: string; req: number }
    | { k: 'cancel-connect'; req: number }
    | { k: 'close'; conn: number }
    | { k: 'spawn'; ref: string; init?: unknown; req: number }
    | { k: 'wait'; pid: number; req: number }
    | { k: 'kill'; pid: number }
    | { k: 'disposed' }
    | { k: 'stdout'; line: string }
    | { k: 'stderr'; line: string }
    | { k: 'progress'; status: unknown }
    | { k: 'exit'; code: number };
