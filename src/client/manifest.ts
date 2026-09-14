import { protocolManifest, registry } from '../core/registry';
import type { ClientNet } from './net';
import * as Net from './net';

/** Outbound protocol-manifest publication, the client->server counterpart to
 *  the inbound decode table `state.inbound`. */
export type Manifest = {
    /** registry revision last published via wire_table; -1 forces a resend on
     *  the next sync, used after (re)join. */
    lastSent: number;
};

export function init(): Manifest {
    return { lastSent: -1 };
}

export function reset(manifest: Manifest): void {
    manifest.lastSent = -1;
}

/** Publish the manifest whenever our registrations change, before any command /
 *  sync this frame. Ordered transport guarantees it lands before the payloads it
 *  describes. */
export function sync(manifest: Manifest, net: ClientNet): void {
    if (registry.version === manifest.lastSent) return;
    Net.send(net, { type: 'wire_table', ...protocolManifest(registry) });
    manifest.lastSent = registry.version;
}
