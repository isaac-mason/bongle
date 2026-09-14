import type { AssetMeta, ResolvedAssetMeta } from '../asset-meta';

export type SoundOptions = AssetMeta & {
    /** source audio (.wav/.mp3/.ogg/.flac): a string path relative to project root, or a
     *  module-relative `asset('./clip.ogg', import.meta.url)` ref for engine builtins and
     *  3rd-party deps shipping audio alongside their modules. */
    src: string;
    /** opts out of the audio atlas, ships + decodes standalone. default false. use for
     *  long-form audio where adding to the atlas would bloat the eager-at-boot fetch;
     *  first play pays a fetch + decode latency, later plays are instant. */
    long?: boolean;
};

/** empty base interface, augmented by the codegen'd registry barrel
 *  (`src/generated/sounds.ts`) via declaration merging to map sound ids to their
 *  precise handle types. mirrors ModelHandleMap. */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by codegen
export interface SoundHandleMap {}

/** the declared + codegen'd data for one sound. pure data: hashed for change detection,
 *  swapped wholesale when the barrel re-registers (see `declare`). */
export type SoundDef = {
    readonly soundId: string;
    /** display name for editor UIs; defaults to `soundId` when the author didn't
     *  supply one, so readers can show `handle.name` unconditionally. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    readonly src: string;
    readonly long: boolean;
    /** clip duration in seconds, ffprobed at codegen. zero on the placeholder handle
     *  that `sound()` returns before codegen has run for this id. */
    readonly duration: number;
    /** bumped on HMR via registry.touch(). */
    version: number;
};

/** Stable wrapper around a `SoundDef`; identity plus the live def. */
export type SoundHandle = {
    /** the declared id (identity, never changes). */
    readonly id: string;
    /** DepGraph dependency + the brand `isHandle` tests. */
    dependency: { registry: 'sounds'; id: string };
    /** the declared data. re-pointed on every re-declaration. */
    def: SoundDef;
};

/** used by `sound()` when the user declares a sound before codegen has run for it; the
 *  placeholder sits in the registry so the cli can discover the declaration. `duration: 0`
 *  is the placeholder sentinel until `_registerSoundHandle` mutates it in place. */
export function createSoundPlaceholderDef(id: string, src: string, long: boolean, meta: ResolvedAssetMeta): SoundDef {
    return {
        soundId: id,
        name: meta.name,
        tags: meta.tags,
        src,
        long,
        duration: 0,
        version: 0,
    };
}
