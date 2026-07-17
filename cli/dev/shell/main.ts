// cli/dev/shell/main.ts — the play-client shell entry (Vite `client` env).
// Boots the play client; userEntry dynamic-imports the project's src (via the
// `bongle-project-entry` resolve.alias) AFTER env is set, so user declarations
// evaluate in the right env. The dynamic import is the HMR boundary: capture
// self-accepts settle inside the user graph, they don't cascade into the shell.

import { start } from '../../realms/client/edit-client';

start({
    // @ts-expect-error — a Vite resolve.alias (→ <projectDir>/src/index.ts), not resolvable by tsgo.
    userEntry: () => import('bongle-project-entry'),
}).catch((e) => {
    console.error('[bongle dev] client boot failed', e);
    document.body.innerHTML = `<pre style="color:#f66;padding:1rem;font:13px/1.5 monospace;white-space:pre-wrap">bongle dev — client boot failed:\n${(e as Error)?.stack ?? e}</pre>`;
});
