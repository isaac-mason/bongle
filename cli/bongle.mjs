#!/usr/bin/env node
// lib/cli/bongle.mjs — the installable `bongle` bin.
//
// bongle ships SOURCE (.ts), and so does the CLI + the engine it bundles/bakes —
// so the entry needs a TS-aware loader. We register tsx programmatically here
// rather than via a `#!/usr/bin/env -S node --import tsx` shebang: `--import`
// resolves the loader relative to CWD and trips on pnpm's non-hoisted layout,
// whereas `import('tsx/esm/api')` resolves relative to THIS file (bongle's own
// dep), so it works from any project after a plain install.
import { register } from 'tsx/esm/api';

register();
await import('./bongle.ts');
