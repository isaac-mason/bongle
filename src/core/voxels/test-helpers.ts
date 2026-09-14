// test-helpers.ts, shared scaffolding for voxel unit tests.
//
// instead of fabricating BlockDef / BlockHandle objects, tests call the
// real `block()` / `tile()` APIs so they exercise the same code
// paths production does (default resolution, hook bitmask, dust deriver,
// state encoding). `resetVoxelRegistry()` clears the affected KindStores
// in `beforeEach` so test files don't cross-pollute.

import { block, registry, reindexRegistry, tile } from '../registry';
import { _resetBlockSlots, type Blocks } from './block-registry';
import type { BlockStateDef, PropsDef } from './block-state';
import type { BlockHandle, BlockOptions } from './blocks';

type AnyStore = {
    byId: Map<unknown, unknown>;
    meta: Map<unknown, unknown>;
    moduleToIds: Map<unknown, unknown>;
    seen: Map<unknown, unknown>;
    pendingChanges: unknown[];
    revision: number;
};

function clearStore(store: AnyStore): void {
    store.byId.clear();
    store.meta.clear();
    store.moduleToIds.clear();
    store.seen.clear();
    store.pendingChanges.length = 0;
    store.revision++;
}

/** clear voxel-adjacent registry state between tests. covers the stores
 *  `block()` / `tile()` write into directly, plus the auto-derived
 *  texture/sprite/particle entries the registry builder emits per cube. */
/** clear the voxel-adjacent registry STORES but keep block state-id reservations,
 *  which is what an HMR re-declaration looks like: user modules re-evaluate into a
 *  wiped store, but the process (and so `reserveBlockSlot`) lives on. */
export function resetVoxelRegistryStoresOnly(): void {
    clearStore(registry.blocks as unknown as AnyStore);
    clearStore(registry.tiles as unknown as AnyStore);
    clearStore(registry.sprites as unknown as AnyStore);
    clearStore(registry.particles as unknown as AnyStore);
    // tiles hold frame REFERENCES and dust derives computed textures, so the
    // texture store is voxel-adjacent too — leaving it would carry a previous
    // test's frames into the next one's atlas derivation.
    clearStore(registry.textures as unknown as AnyStore);
    // these clears bypass the registration path, so rebuild the derived index
    // fields to reflect the now-empty stores (mirrors a real boot/flush).
    reindexRegistry(registry);
}

export function resetVoxelRegistry(): void {
    _resetBlockSlots();
    clearStore(registry.blocks as unknown as AnyStore);
    clearStore(registry.tiles as unknown as AnyStore);
    clearStore(registry.sprites as unknown as AnyStore);
    clearStore(registry.particles as unknown as AnyStore);
    // tiles hold frame REFERENCES and dust derives computed textures, so the
    // texture store is voxel-adjacent too — leaving it would carry a previous
    // test's frames into the next one's atlas derivation.
    clearStore(registry.textures as unknown as AnyStore);
    // these clears bypass the registration path, so rebuild the derived index
    // fields to reflect the now-empty stores (mirrors a real boot/flush).
    reindexRegistry(registry);
}

// biome-ignore lint/complexity/noBannedTypes: {} is the intentional empty-props default (matches block()'s signature)
export type TestBlockSpec<P extends PropsDef = {}> = BlockOptions<P> & {
    id: string;
    /** convenience: when set (and `model` is omitted), registers a
     *  single-frame `tile(texId, ...)` and uses it as the
     *  default cube model (all faces). leave omitted for invisible
     *  blocks or when `model` is supplied directly. */
    texId?: string;
};

/** declare one test block via the real `tile()` + `block()`. */
// biome-ignore lint/complexity/noBannedTypes: {} is the intentional empty-props default (matches block()'s signature)
export function defineTestBlock<const P extends PropsDef = {}>(spec: TestBlockSpec<P>): BlockHandle<P> {
    const { id, texId, ...opts } = spec;
    // a tile is referenced by handle, so declare it and keep the handle rather
    // than round-tripping through its id.
    const faceTile = texId !== undefined ? tile(texId, { src: `textures/${texId}.png` }) : undefined;
    const model =
        opts.model ?? (faceTile !== undefined ? () => ({ type: 'cube' as const, tiles: { all: faceTile } }) : undefined);
    return block(id, { ...(opts as BlockOptions<P>), model, states: opts.states as BlockStateDef<P> | undefined });
}

/** declare a batch and return the resulting BlockRegistry. tests that
 *  don't need the handles individually can use this shorthand. */
export function buildTestRegistry(specs: TestBlockSpec[]): Blocks {
    for (const s of specs) defineTestBlock(s);
    // registrations bypass a boot/flush here; rebuild derived fields so the
    // returned BlockRegistry (and any later `registry.blockRegistry` read)
    // reflects the just-declared blocks.
    reindexRegistry(registry);
    return registry.blockRegistry;
}
