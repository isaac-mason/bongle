// key-level rotate/flip — the bridge between blueprint/voxel-rotate
// (which work on string keys) and the block-def hooks (which work on
// stateIds).
//
// each call dispatches to the block's `rotate` / `flip` hook. presets
// in block-presets.ts implement these hooks for every directional shape
// (stairs, slab, trapdoor, ladder, column, fence, pane, wall, torch).
// stateless blocks and blocks that lack a hook are returned unchanged.
//
// returns the original key when the hook returns an unregistered stateId.

import type { RotAxis } from './block-orient';
import { parseKey, type BlockRegistry } from './block-registry';

export function rotateBlockKey(key: string, axis: RotAxis, cw: boolean, registry: BlockRegistry): string {
    const parsed = parseKey(key);
    if (!parsed) return key;
    const def = registry.idToDef.get(parsed.blockId);
    if (!def?.rotate) return key;
    const stateId = registry.keyToState.get(key);
    if (stateId === undefined) return key;
    const rotatedId = def.rotate(stateId, axis, cw);
    return registry.stateToKey[rotatedId] ?? key;
}

export function flipBlockKey(key: string, axis: RotAxis, registry: BlockRegistry): string {
    const parsed = parseKey(key);
    if (!parsed) return key;
    const def = registry.idToDef.get(parsed.blockId);
    if (!def?.flip) return key;
    const stateId = registry.keyToState.get(key);
    if (stateId === undefined) return key;
    const flippedId = def.flip(stateId, axis);
    return registry.stateToKey[flippedId] ?? key;
}
