// bongle/os/apps — the engine's editor-app definition module: what this engine
// version provides to the editor OS, as code, typed, versioned with the pin.
// The host evaluates this through the runner at boot (after the seed), checks
// `abi`, auto-starts the `start: 'auto'` services with the session, and lists
// the rest as startable. A different pin declares a different app set /
// topology; the host hardcodes nothing.
//
// Only `boot` is auto: it's the supervisor that spawns + sequences pipeline and
// server (which are therefore plain manual apps it starts). The host runs `boot`
// blind — it no longer knows the service order or the boot phases.
//
// Keep this module dependency-light (type imports only) — evaluating it must
// not drag engine runtime into the boot graph.

import type { AppDefs } from '../interface';

/** the Env/def ABI this artifact was built against. The host supports a range
 *  and refuses (with a clear shell error) outside it. Additive-only. */
export const abi = 1;

export const apps = {
    boot: { module: 'bongle/os/apps/boot', start: 'auto' },
    pipeline: { module: 'bongle/os/apps/pipeline' },
    server: { module: 'bongle/os/apps/server' },
    client: { module: 'bongle/os/apps/client', surface: true },
} satisfies AppDefs;
