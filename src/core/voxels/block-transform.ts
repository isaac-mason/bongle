import type { RotAxis } from './block-orient';
import { type Blocks, parseKey } from './block-registry';

/** Dispatches to the block's `rotate` hook, bridging string keys (blueprint/voxel-rotate) and stateIds (block-def hooks). Returns `key` unchanged for stateless blocks, blocks with no `rotate` hook, or an unregistered result stateId. */
export function rotateBlockKey(key: string, axis: RotAxis, cw: boolean, registry: Blocks): string {
    const parsed = parseKey(key);
    if (!parsed) return key;
    const def = registry.idToDef.get(parsed.blockId);
    if (!def?.rotate) return key;
    const stateId = registry.keyToState.get(key);
    if (stateId === undefined) return key;
    const rotatedId = def.rotate(stateId, axis, cw);
    return registry.stateToKey[rotatedId] ?? key;
}

/** Dispatches to the block's `flip` hook; same fallback rules as `rotateBlockKey`. */
export function flipBlockKey(key: string, axis: RotAxis, registry: Blocks): string {
    const parsed = parseKey(key);
    if (!parsed) return key;
    const def = registry.idToDef.get(parsed.blockId);
    if (!def?.flip) return key;
    const stateId = registry.keyToState.get(key);
    if (stateId === undefined) return key;
    const flippedId = def.flip(stateId, axis);
    return registry.stateToKey[flippedId] ?? key;
}
