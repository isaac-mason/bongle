// Bundle manifest emitted into `dist/bongle.json` by `build`. Read by
// `apps/game-room` at boot (entries + integrity check) and by the CLI
// on upload (size + integrity inputs).
//
// Bundles are identity-free: the manifest carries only "what's in this
// bundle" — no game/team slug. The CLI specifies the destination game
// at deploy time (`bongle-cli deploy <team>/<game>`), so the same artifact can
// be uploaded to any game the user owns.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';

/** Bumped when the bundle layout the platform expects changes
 *  in a non-backwards-compatible way. */
export const BUNDLE_SCHEMA = 1;

export type BundleManifest = {
    schema: number;
    engine: {
        /** Resolved exact versions of the workspace packages this bundle
         *  was built against. Surfaced in the platform UI; lets the
         *  platform later filter / warn on stale bundles. */
        bongle: string;
        interface: string;
    };
    client: {
        entry: string;
        integrity: string;
        /** Optional sibling stylesheet emitted next to `entry`. Only
         *  present when the client build pulled in CSS (Tailwind +
         *  any `import './x.css'` side-effects). The platform fetches
         *  this and injects it into the iframe; absent → the bundle
         *  has no styles to ship. */
        styles?: { entry: string; integrity: string };
    };
    server: { entry: string; integrity: string };
    assets: { publicDir: string };
    build: { id: string; createdAt: string; tool: string };
    /** Per-game matchmaking knobs harvested from the user's matchmaking()
     *  call (or defaults if the user didn't call it). The platform's
     *  matchmaker reads this at create-room time; the upload worker
     *  range-checks it. Always present — kit fills defaults. */
    matchmaking: { maxPlayers: number };
};

/** SHA-384 SRI digest of `filePath`, in `sha384-<base64>` form. */
export function computeIntegrity(filePath: string): string {
    const buf = fs.readFileSync(filePath);
    const digest = crypto.createHash('sha384').update(buf).digest('base64');
    return `sha384-${digest}`;
}

export type BuildManifestArgs = {
    clientEntry: string;
    /** Optional sibling stylesheet path. When present, the manifest
     *  records it as `client.styles` with its own SRI digest. */
    clientStyles?: string;
    serverEntry: string;
    /** kit's package version, e.g. "0.1.2". stamped into build.tool. */
    kitVersion: string;
    /** Resolved version of `bongle` (engine package) at build time. */
    bongleVersion: string;
    /** Resolved version of `@bongle/interface` at build time. */
    interfaceVersion: string;
    /** Per-game matchmaking config, harvested by the asset-pipeline
     *  introspection pass from the user's matchmaking() call (or
     *  defaults if the user didn't call it). */
    matchmaking: { maxPlayers: number };
};

export function buildManifest(args: BuildManifestArgs): BundleManifest {
    const client: BundleManifest['client'] = {
        entry: 'client/index.js',
        integrity: computeIntegrity(args.clientEntry),
    };
    if (args.clientStyles) {
        client.styles = {
            entry: 'client/index.css',
            integrity: computeIntegrity(args.clientStyles),
        };
    }
    return {
        schema: BUNDLE_SCHEMA,
        engine: {
            bongle: args.bongleVersion,
            interface: args.interfaceVersion,
        },
        client,
        server: { entry: 'server/index.js', integrity: computeIntegrity(args.serverEntry) },
        assets: { publicDir: 'public' },
        build: {
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            tool: `@bongle/kit@${args.kitVersion}`,
        },
        matchmaking: { maxPlayers: args.matchmaking.maxPlayers },
    };
}
