// sound registration, module-scope api for declaring audio clips.
//
// follows the same pattern as model(): called at module scope, returns a
// typed SoundHandle. parallels how models work, `soundsRegistry` is the
// single source of truth, the user module that called `sound('id', ...)`
// owns the entry, and the codegen barrel (`src/generated/sounds.ts`)
// mutates the payload in place via `_registerSoundHandle` to populate
// metadata that's only knowable after probing the source file (currently
// just `duration`; room to add `channels` / `sampleRate` / loop hints
// later without churning the public surface).
//
// `long: true` opts the clip out of the audio atlas: it ships as a
// standalone sibling file and the runtime lazy-loads + decodes it on
// first play. atlas vs standalone routing is owned by the runtime's
// `audio-manifest.json` map (loaded by client/audio/audio.ts), not by
// the handle, keeping the handle free of routing data means the runtime
// can change transports without re-codegen.
//
// Ownership story (same as model())
// ---------------------------------
//   - user module owns the registry entry. on `sound()` removal from
//     user code, the entry fires `removed` so the asset pipeline GCs
//     sidecar + atlas slot, and the runtime drops the resolved clip.
//   - barrel does NOT own. `_registerSoundHandle` mutates payload in
//     place + `touch()`es. user code refs (`const Footstep = sound(...)`)
//     stay valid across codegen swaps.
//   - cold-start (barrel runs before user-eval): `upsertPlaceholder`
//     under `PLACEHOLDER_OWNER`; the first user `sound()` call promotes
//     ownership via `claimOwnership`.

/* ── types ── */

import type { AssetMeta, ResolvedAssetMeta } from '../asset-meta';

export type SoundOptions = AssetMeta & {
    /**
     * source audio (.wav/.mp3/.ogg/.flac): either a string path relative to
     * project root, or a module-relative `asset('./clip.ogg', import.meta.url)`
     * ref. The `asset()` form lets engine builtins + 3rd-party deps ship audio
     * alongside their modules — it resolves relative to the calling module
     * wherever it's installed, and the pipeline reads the resolved path.
     */
    src: string;
    /**
     * opt out of the audio atlas, ship + decode standalone. default false.
     *
     * use for long-form audio (background tracks, voice lines, ambient
     * loops) where adding to the atlas would bloat the eager-at-boot
     * fetch. first play of a long clip pays a fetch + decodeAudioData
     * latency; subsequent plays are instant (decoded buffer is cached).
     */
    long?: boolean;
};

/**
 * Empty base interface, augmented by the codegen'd registry barrel
 * (`src/generated/sounds.ts`) via declaration merging to map sound ids
 * to their precise handle types. Mirrors ModelHandleMap.
 *
 * @example codegen output:
 * ```ts
 * declare module 'bongle' {
 *     interface SoundHandleMap {
 *         footstep: typeof footstep;
 *         ambient: typeof ambient;
 *     }
 * }
 * ```
 */
// biome-ignore lint/suspicious/noEmptyInterface: augmented by codegen
export interface SoundHandleMap {}

/** The declared + codegen'd data for one sound. Pure data: hashed for change
 *  detection, swapped wholesale when the barrel re-registers (see `declare`). */
export type SoundDef = {
    readonly soundId: string;
    /** human-readable display name for editor UIs. always set,
     *  defaults to `soundId` when the author didn't supply one, so
     *  readers can show `handle.name` unconditionally. */
    readonly name: string;
    /** search words for editor UIs, normalised (see `AssetMeta`). */
    readonly tags: readonly string[];
    readonly src: string;
    readonly long: boolean;
    /**
     * clip duration in seconds, ffprobed at codegen and baked into the
     * sidecar. zero on the placeholder handle that `sound()` returns when
     * codegen hasn't run yet for this id; the barrel mutates it in place
     * on the next pipeline pass.
     */
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

/* ── codegen-seeded registry ── */

/**
 * Build a per-id placeholder handle. Used by `sound()` when the user
 * declares a sound before codegen has run for it, the placeholder sits
 * in the registry so the cli can discover the declaration (`.src` is the
 * cli's codegen input). `_registerSoundHandle` mutates this payload in
 * place once codegen catches up, preserving the user-held reference.
 *
 * `duration: 0` is the placeholder sentinel, user code that reads
 * `handle.duration` before the first pipeline pass sees zero, which is
 * also the correct value for an empty handle.
 */
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

/* ── registration ── */
