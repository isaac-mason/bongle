import type { ResolvedAvatar } from 'bongle/interface';
import { RIG_TYPE_6BONE } from '../../../avatar/rig';
import { getTrait, type Node } from '../../api/scene-tree';
import { CharacterTrait, modelIdSync } from '../../builtins/character';
import * as Resources from '../resources';

/** Acquires + ensures a resolved avatar's runtime model (bundled: ensure-only, no refcount). Balance each call with one `Resources.releaseRuntimeModel`. */
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
    // Bundled models live for the engine lifetime, no refcount.
    Resources.ensureModel(resources, avatar.modelId);
    return { modelId: avatar.modelId, rigType: RIG_TYPE_6BONE };
}

/** Points a `CharacterTrait` node at an already-loaded avatar; the rig reconciler mounts it once the payload lands. No-op if `node` has no `CharacterTrait`. */
export function assignAvatar(node: Node, modelId: string, rigType: string = RIG_TYPE_6BONE): void {
    const ch = getTrait(node, CharacterTrait);
    if (!ch) return;
    ch.modelId = modelId;
    ch.rigType = rigType;
    modelIdSync.dirty(ch);
}
