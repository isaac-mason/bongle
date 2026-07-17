// core/content/scene-store.ts, runtime mutation of declared scene handles.
//
// scenes are authored content. authored payloads ride on each
// `SceneHandle._payload` field, stamped at `scene()` declaration by the
// codegen barrel's `_registerScenePayload` calls (one map keyed by id holds
// barrel writes that land before the matching `scene()` call drains them).
// engine `load()` walks `module.scenes` and calls `populateScene` for any
// handle whose `_payload` is set. live updates (dev) flow through engine
// entries `applyScenePayload` / `clearScene` from HMR listeners in the
// realm boot entries, which both update `_payload` and re-`populateScene`.
//
// scene declarations live on `module.scenes` (captured by `scene()` in user
// code). this module does not keep a parallel registry, the project module
// is the source of truth.

import { registry } from '../registry';
import { addChild, deserializeNode, type Node, refreshTraitIssues, type SerializedSceneTree } from '../scene/scene-tree';
import { buildTraitInstance } from '../scene/traits';
import * as bitset from '../utils/bitset';
import type { BlockRegistry } from '../voxels/block-registry';
import { loadVoxels, type SavedVoxels } from '../voxels/voxel-savefile';
import { createVoxels } from '../voxels/voxels';
import type { Content } from './index';

/**
 * raw, on-the-wire scene data, what the codegen barrel imports at module
 * eval and what the plugin's HMR events carry (already parsed). fed into
 * `populateScene`, which both caches it on `content.payloads`
 * (authored-form-of-record) and deserializes it into the registered
 * `SceneHandle`.
 */
export type ScenePayload = {
    nodes: SerializedSceneTree;
    voxels: SavedVoxels | null;
};

/**
 * apply a scene payload: cache the parsed payload on `content.payloads`
 * (so server discovery can re-push without disk reads) and, if this side
 * declared the scene as relevant, mutate the declared `SceneHandle` so
 * prefabs depending on it rebuild.
 *
 * the cache always records the payload, even when the handle isn't
 * relevant on this side, so the server can push `server: false` scenes
 * to clients without keeping a populated handle for them server-side.
 *
 * `side` selects which handle flag gates handle mutation:
 *   - `'server'` → mutates only when `handle.server`
 *   - `'client'` → mutates only when `handle.client`
 *
 * the handle's `node` reference itself is preserved (closures over
 * `handle.node` stay valid); only its children change.
 */
export function populateScene(
    content: Content,
    blockRegistry: BlockRegistry,
    id: string,
    raw: ScenePayload,
    side: 'server' | 'client',
): void {
    content.payloads.set(id, raw);

    const handle = registry.scenes.byId.get(id)?.payload;
    if (!handle) return;
    if (side === 'server' && !handle.server) return;
    if (side === 'client' && !handle.client) return;

    // detach current children, the handle's node is free-floating (no
    // scene tree runtime), so no unregister is needed; just clear the list and
    // null parent pointers.
    for (const child of handle.node.children) {
        detachOrphan(child);
    }
    handle.node.children.length = 0;

    // clear current root traits before re-applying.
    handle.node._traits.clear();
    handle.node._bitset = bitset.init();
    handle.node._unresolvedTraits.clear();
    handle.node._traitIssues.clear();

    // apply root-level traits. handle.node is free-floating (no sceneTree, no
    // runtime), so no reindex / script instantiation, closures over
    // `handle.node` see the full authored shape including root traits.
    if (raw.nodes.root.traits) {
        for (const st of raw.nodes.root.traits) {
            const def = registry.traits.byId.get(st.id)?.payload;
            if (!def) {
                console.warn(`[bongle] unresolved trait "${st.id}" on root of scene "${id}" — preserving raw data`);
                handle.node._unresolvedTraits.set(st.id, {
                    json: structuredClone(st.controls) as Record<string, unknown> | undefined,
                });
                continue;
            }
            const controls = structuredClone(st.controls);
            const instance = buildTraitInstance(def, controls);
            instance._node = handle.node;
            handle.node._traits.set(def.slot, instance);
            bitset.add(handle.node._bitset, def.slot);
            refreshTraitIssues(handle.node, def, instance, `root of scene "${id}"`);
        }
    }

    // populate fresh children. persist:true is preserved from the source,
    // these aren't prefab outputs, they're authored scene content.
    for (const childData of raw.nodes.root.children) {
        addChild(handle.node, deserializeNode(childData));
    }

    // voxels: replace with a fresh canvas (or null if the scene has none).
    if (raw.voxels) {
        const voxels = createVoxels(blockRegistry);
        loadVoxels(voxels, raw.voxels, blockRegistry);
        handle.voxels = voxels;
    } else {
        handle.voxels = null;
    }

    handle.version++;
}

/**
 * drop a scene from the cache and empty its declared handle (used when a
 * scene declaration is removed, or a `bongle:scene-clear` HMR event fires
 * after an authored file is deleted on disk). gates handle mutation on the
 * side flag, mirroring `populateScene`.
 * the handle reference itself stays valid, module-scope closures still resolve.
 */
export function clearScene(content: Content, id: string, side: 'server' | 'client'): void {
    content.payloads.delete(id);

    const handle = registry.scenes.byId.get(id)?.payload;
    if (!handle) return;
    if (side === 'server' && !handle.server) return;
    if (side === 'client' && !handle.client) return;

    for (const child of handle.node.children) {
        detachOrphan(child);
    }
    handle.node.children.length = 0;
    handle.voxels = null;
    handle.version++;
}

/**
 * detach a free-floating subtree's root from its parent. the handle's
 * children are not registered in any scene tree runtime, so we just clear
 * the parent pointer, descendants are unreachable and get GC'd.
 */
function detachOrphan(child: Node): void {
    child.parent = null;
}
