import { registry } from '../registry';
import { addChild, deserializeNode, type Node, refreshTraitIssues, type SerializedSceneTree } from '../scene/scene-tree';
import { buildTraitInstance } from '../scene/traits';
import * as bitset from '../utils/bitset';
import type { Blocks } from '../voxels/block-registry';
import { loadVoxels, type SavedVoxels } from '../voxels/voxel-savefile';
import { createVoxels } from '../voxels/voxels';
import type { Content } from './index';

/** Raw, on-the-wire scene data; fed into `populateScene`, which caches it on `content.payloads` and deserializes it into the registered `SceneHandle`. */
export type ScenePayload = {
    nodes: SerializedSceneTree;
    voxels: SavedVoxels | null;
};

/**
 * Caches the parsed payload on `content.payloads` regardless of relevance (so the server can
 * push `server: false` scenes to clients without a populated handle server-side), then, if
 * `side` matches the handle's `server`/`client` flag, mutates the declared `SceneHandle` in
 * place so prefabs depending on it rebuild. The `node` reference itself is preserved.
 */
export function populateScene(
    content: Content,
    blockRegistry: Blocks,
    id: string,
    raw: ScenePayload,
    side: 'server' | 'client',
): void {
    content.payloads.set(id, raw);

    const handle = registry.scenes.handles.get(id);
    if (!handle) return;
    if (side === 'server' && !handle.def.server) return;
    if (side === 'client' && !handle.def.client) return;

    // handle.node is free-floating (no scene tree runtime), so no unregister is needed.
    for (const child of handle.node.children) {
        detachOrphan(child);
    }
    handle.node.children.length = 0;

    handle.node.traits.length = 0;
    handle.node.bitset = bitset.init();
    handle.node.unresolved = null;

    if (raw.nodes.root.traits) {
        for (const st of raw.nodes.root.traits) {
            const traitHandle = registry.traits.handles.get(st.id);
            if (!traitHandle) {
                console.warn(`[bongle] unresolved trait "${st.id}" on root of scene "${id}" — preserving raw data`);
                if (handle.node.unresolved === null) handle.node.unresolved = new Map();
                handle.node.unresolved.set(st.id, structuredClone(st.controls) as Record<string, unknown> | undefined);
                continue;
            }
            const controls = structuredClone(st.controls);
            const instance = buildTraitInstance(traitHandle, controls);
            instance._node = handle.node;
            handle.node.traits[traitHandle.slot] = instance;
            bitset.add(handle.node.bitset, traitHandle.slot);
            refreshTraitIssues(traitHandle.def, instance, `root of scene "${id}"`);
        }
    }

    for (const childData of raw.nodes.root.children) {
        addChild(handle.node, deserializeNode(childData));
    }

    if (raw.voxels) {
        const voxels = createVoxels(blockRegistry);
        loadVoxels(voxels, raw.voxels, blockRegistry);
        handle.voxels = voxels;
    } else {
        handle.voxels = null;
    }

    handle.version++;
}

/** Drops a scene from the cache and empties its declared handle. Gates handle mutation on the side flag, mirroring `populateScene`. */
export function clearScene(content: Content, id: string, side: 'server' | 'client'): void {
    content.payloads.delete(id);

    const handle = registry.scenes.handles.get(id);
    if (!handle) return;
    if (side === 'server' && !handle.def.server) return;
    if (side === 'client' && !handle.def.client) return;

    for (const child of handle.node.children) {
        detachOrphan(child);
    }
    handle.node.children.length = 0;
    handle.voxels = null;
    handle.version++;
}

/** Detaches a free-floating subtree's root; unregistered descendants become unreachable and get GC'd. */
function detachOrphan(child: Node): void {
    child.parent = null;
}
