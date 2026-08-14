// bongle/os/apps — the engine's editor-app definition module: what this engine
// version provides to the editor OS, as code, typed, versioned with the pin.
// The host evaluates this through the runner at boot (after the seed), checks
// `abi`, auto-starts the `start: 'auto'` services with the session, and lists
// the rest as startable. A different pin declares a different app set /
// topology; the host hardcodes nothing.
//
// Keep this module dependency-light (type imports only) — evaluating it must
// not drag engine runtime into the boot graph.

import type { AppDefs } from '../interface';

/** the Env/def ABI this artifact was built against. The host supports a range
 *  and refuses (with a clear shell error) outside it. Additive-only. */
export const abi = 1;

export const apps = {
    pipeline: { module: 'bongle/os/apps/pipeline', start: 'auto' },
    server: { module: 'bongle/os/apps/server', start: 'auto' },
    client: { module: 'bongle/os/apps/client', surface: true },
} satisfies AppDefs;
