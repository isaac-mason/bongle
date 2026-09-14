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

/** clears voxel-adjacent registry stores but keeps block state-id reservations, matching an HMR re-declaration: user modules re-evaluate into a wiped store, but `reserveBlockSlot`'s process lives on. */
export function resetVoxelRegistryStoresOnly(): void {
    clearStore(registry.blocks as unknown as AnyStore);
    clearStore(registry.tiles as unknown as AnyStore);
    clearStore(registry.sprites as unknown as AnyStore);
    clearStore(registry.particles as unknown as AnyStore);
    // tiles hold frame references and dust derives computed textures, so the texture store is voxel-adjacent too.
    clearStore(registry.textures as unknown as AnyStore);
    reindexRegistry(registry);
}

export function resetVoxelRegistry(): void {
    _resetBlockSlots();
    clearStore(registry.blocks as unknown as AnyStore);
    clearStore(registry.tiles as unknown as AnyStore);
    clearStore(registry.sprites as unknown as AnyStore);
    clearStore(registry.particles as unknown as AnyStore);
    clearStore(registry.textures as unknown as AnyStore);
    reindexRegistry(registry);
}

// biome-ignore lint/complexity/noBannedTypes: {} is the intentional empty-props default (matches block()'s signature)
export type TestBlockSpec<P extends PropsDef = {}> = BlockOptions<P> & {
    id: string;
    /** when set (and `model` is omitted), registers a single-frame `tile(texId, ...)` as the default cube model on all faces. */
    texId?: string;
};

/** declare one test block via the real `tile()` + `block()`. */
// biome-ignore lint/complexity/noBannedTypes: {} is the intentional empty-props default (matches block()'s signature)
export function defineTestBlock<const P extends PropsDef = {}>(spec: TestBlockSpec<P>): BlockHandle<P> {
    const { id, texId, ...opts } = spec;
    const faceTile = texId !== undefined ? tile(texId, { src: `textures/${texId}.png` }) : undefined;
    const model =
        opts.model ?? (faceTile !== undefined ? () => ({ type: 'cube' as const, tiles: { all: faceTile } }) : undefined);
    return block(id, { ...(opts as BlockOptions<P>), model, states: opts.states as BlockStateDef<P> | undefined });
}

/** declare a batch and return the resulting BlockRegistry. */
export function buildTestRegistry(specs: TestBlockSpec[]): Blocks {
    for (const s of specs) defineTestBlock(s);
    reindexRegistry(registry);
    return registry.blockRegistry;
}
