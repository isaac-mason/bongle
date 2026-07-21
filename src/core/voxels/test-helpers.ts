// test-helpers.ts, shared scaffolding for voxel unit tests.
//
// instead of fabricating BlockDef / BlockHandle objects, tests call the
// real `block()` / `blockTexture()` APIs so they exercise the same code
// paths production does (default resolution, hook bitmask, dust deriver,
// state encoding). `resetVoxelRegistry()` clears the affected KindStores
// in `beforeEach` so test files don't cross-pollute.

import { registry, reindex } from '../registry';
import type { Blocks } from './block-registry';
import type { BlockStateDef, PropsDef } from './block-state';
import { type BlockHandle, type BlockOptions, block, blockTexture } from './blocks';

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
 *  `block()` / `blockTexture()` write into directly, plus the auto-
 *  derived sprite/particle entries the registry builder emits per cube. */
export function resetVoxelRegistry(): void {
    clearStore(registry.blocks as unknown as AnyStore);
    clearStore(registry.blockTextures as unknown as AnyStore);
    clearStore(registry.sprites as unknown as AnyStore);
    clearStore(registry.particles as unknown as AnyStore);
    // these clears bypass the registration path, so rebuild the derived index
    // fields to reflect the now-empty stores (mirrors a real boot/flush).
    reindex(registry);
}

// biome-ignore lint/complexity/noBannedTypes: {} is the intentional empty-props default (matches block()'s signature)
export type TestBlockSpec<P extends PropsDef = {}> = BlockOptions<P> & {
    id: string;
    /** convenience: when set (and `model` is omitted), registers a
     *  single-frame `blockTexture(texId, ...)` and uses it as the
     *  default cube model (all faces). leave omitted for invisible
     *  blocks or when `model` is supplied directly. */
    texId?: string;
};

/** declare one test block via the real `blockTexture()` + `block()`. */
// biome-ignore lint/complexity/noBannedTypes: {} is the intentional empty-props default (matches block()'s signature)
export function defineTestBlock<const P extends PropsDef = {}>(spec: TestBlockSpec<P>): BlockHandle<P> {
    const { id, texId, ...opts } = spec;
    if (texId !== undefined) {
        blockTexture(texId, { src: `textures/${texId}.png` });
    }
    const model =
        opts.model ??
        (texId !== undefined ? () => ({ type: 'cube' as const, textures: { all: { texture: texId } } }) : undefined);
    return block(id, { ...(opts as BlockOptions<P>), model, states: opts.states as BlockStateDef<P> | undefined });
}

/** declare a batch and return the resulting BlockRegistry. tests that
 *  don't need the handles individually can use this shorthand. */
export function buildTestRegistry(specs: TestBlockSpec[]): Blocks {
    for (const s of specs) defineTestBlock(s);
    // registrations bypass a boot/flush here; rebuild derived fields so the
    // returned BlockRegistry (and any later `registry.blockRegistry` read)
    // reflects the just-declared blocks.
    reindex(registry);
    return registry.blockRegistry;
}
