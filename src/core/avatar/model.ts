// core/avatar/model.ts, shared avatar→character wiring, used by BOTH the script
// API (api/avatars) and the engine player-join path (server/avatars). This is the
// ctx-less core; scripts use loadAvatar/assignAvatar from api/avatars, never these
// directly.
//
//   - acquireAvatarModel, the load half: acquire + ensure the model bytes
//     (refcounted for runtime avatars, ensure-only for bundled/builtin).
//   - assignAvatar, the stamp half: point a node's CharacterTrait at an
//     already-loaded model + mark it for sync. No refcount.
//
// `acquireAvatarModel` MUST precede `assignAvatar` for runtime avatars: acquire
// registers the resource entry that ensure + the rig reconciler load from.

import { RIG_TYPE_6BONE } from 'bongle/avatar/rig';
import type { ResolvedAvatar } from 'bongle/interface';
import { getTrait, type Node } from '../../api/scene-graph';
import { CharacterTrait, modelIdSync } from '../../builtins/character';
import * as Resources from '../resources';

/**
 * Acquire + ensure a resolved avatar's runtime model (bundled: ensure-only, no
 * refcount). +1 refcount for runtime avatars and kicks the payload fetch. Returns
 * the `modelId`/`rigType` to hand to `assignAvatar` (or store as the client's
 * avatar identity). Balance each call with one `Resources.releaseRuntimeModel`.
 */
export function acquireAvatarModel(resources: Resources.Resources, avatar: ResolvedAvatar): { modelId: string; rigType: string } {
    if (avatar.source === 'runtime') {
        Resources.acquireRuntimeModel(resources, avatar.modelId, {
            clientUrl: avatar.clientUrl,
            serverUrl: avatar.serverUrl,
            source: 'runtime',
            hash: avatar.hash,
        });
        Resources.ensureModel(resources, avatar.modelId);
        return { modelId: avatar.modelId, rigType: avatar.rigType ?? RIG_TYPE_6BONE };
    }
    // bundled, entry exists via codegen; ensure keeps the load path uniform (no-op
    // once ready). no refcount: bundled models live for the engine lifetime.
    Resources.ensureModel(resources, avatar.modelId);
    return { modelId: avatar.modelId, rigType: RIG_TYPE_6BONE };
}

/**
 * Point a `CharacterTrait` node at an already-loaded avatar (acquire the model
 * first for runtime avatars). Sets the synced `modelId`/`rigType`; the rig
 * reconciler mounts it once the payload lands. No refcount, safe to call
 * repeatedly / swap freely. No-op if `node` has no `CharacterTrait`.
 */
export function assignAvatar(node: Node, modelId: string, rigType: string = RIG_TYPE_6BONE): void {
    const ch = getTrait(node, CharacterTrait);
    if (!ch) return;
    ch.modelId = modelId;
    ch.rigType = rigType;
    modelIdSync.dirty(ch);
}
