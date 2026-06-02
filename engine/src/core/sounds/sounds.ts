// sound registration — module-scope api for declaring audio clips.
//
// follows the same pattern as model(): called at module scope, returns a
// typed SoundHandle. parallels how models work — `soundsRegistry` is the
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
// the handle — keeping the handle free of routing data means the runtime
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

import { recordSound } from '../capture/module-scope';
import { claimOwnership, get, registry, touch, upsert, upsertPlaceholder } from '../registry';

/* ── types ── */

export type SoundOptions = {
    /** human-readable display name for editor UIs. falls back to the
     *  string id when omitted. purely cosmetic — IDs remain the lookup
     *  key everywhere else. */
    name?: string;
    /**
     * source audio (.wav/.mp3/.ogg/.flac). either:
     *   - a string path relative to project root, or
     *   - a URL (typically `new URL('./clip.ogg', import.meta.url)`).
     *
     * the URL form lets engine builtins + 3rd-party deps ship audio
     * bundled with their modules: vite statically rewrites the
     * `new URL(...)` call in client bundles, and the asset pipeline
     * (running under bun) resolves the `file://` URL via fileURLToPath
     * to a disk path ffmpeg can read.
     *
     * stored as a string at registration — URLs are normalized to
     * `.href` so downstream consumers (registry hashes, codegen, the
     * pipeline) only deal with one shape.
     */
    src: string | URL;
    /**
     * opt out of the audio atlas — ship + decode standalone. default false.
     *
     * use for long-form audio (background tracks, voice lines, ambient
     * loops) where adding to the atlas would bloat the eager-at-boot
     * fetch. first play of a long clip pays a fetch + decodeAudioData
     * latency; subsequent plays are instant (decoded buffer is cached).
     */
    long?: boolean;
};

/**
 * Empty base interface — augmented by the codegen'd registry barrel
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

export type SoundHandle = {
    readonly soundId: string;
    /** human-readable display name for editor UIs. always set —
     *  defaults to `soundId` when the author didn't supply one, so
     *  readers can show `handle.name` unconditionally. */
    readonly name: string;
    /** DepGraph dependency — see SceneHandle.dependency. */
    dependency: { registry: 'sounds'; id: string };
    readonly src: string;
    readonly long: boolean;
    /**
     * clip duration in seconds — ffprobed at codegen and baked into the
     * sidecar. zero on the placeholder handle that `sound()` returns when
     * codegen hasn't run yet for this id; the barrel mutates it in place
     * on the next pipeline pass.
     */
    readonly duration: number;
    /** bumped on HMR via registry.touch(). */
    version: number;
};

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/* ── codegen-seeded registry ── */

/**
 * Called by the per-project barrel `src/generated/sounds.ts` at module-
 * eval to populate each handle's codegen'd fields. Barrel does not own
 * registry entries — see file header. Mutates the existing payload in
 * place so user code refs stay valid, then `touch()`es so consumers
 * react via the dispatch path.
 *
 * If no entry exists (cold start where the barrel ran before any user
 * `sound()` call), the payload is registered under `PLACEHOLDER_OWNER`;
 * the first user `sound()` call promotes ownership.
 *
 * Re-runs on every barrel re-import (hot reload). The `touch` call is
 * what bumps `revision` so the cli's flush handler picks up duration
 * changes for downstream consumers.
 */
export function _registerSoundHandle(id: string, handle: SoundHandle): void {
    const existing = get(registry.sounds, id);
    if (existing) {
        const target = existing as Mutable<SoundHandle>;
        target.src = handle.src;
        target.long = handle.long;
        target.duration = handle.duration;
        target.version = handle.version;
        touch(registry.sounds, id);
    } else {
        upsertPlaceholder(registry.sounds, id, handle);
    }
}

/**
 * Build a per-id placeholder handle. Used by `sound()` when the user
 * declares a sound before codegen has run for it — the placeholder sits
 * in the registry so the cli can discover the declaration (`.src` is the
 * cli's codegen input). `_registerSoundHandle` mutates this payload in
 * place once codegen catches up, preserving the user-held reference.
 *
 * `duration: 0` is the placeholder sentinel — user code that reads
 * `handle.duration` before the first pipeline pass sees zero, which is
 * also the correct value for an empty handle.
 */
function createPlaceholderHandle(id: string, src: string, long: boolean, name: string): SoundHandle {
    return {
        soundId: id,
        name,
        dependency: { registry: 'sounds', id },
        src,
        long,
        duration: 0,
        version: 0,
    };
}

/* ── registration ── */

/**
 * Declare an audio clip. Called at module scope.
 *
 * Returns the codegen'd `SoundHandle` (typed via `SoundHandleMap` if the
 * cli has emitted the registry barrel yet, generic `SoundHandle` otherwise).
 *
 * ```ts
 * import { sound } from 'bongle';
 * const Footstep = sound('footstep', { src: 'audio/footstep.wav' });
 * const Ambient  = sound('ambient', { src: 'audio/ambient.ogg', long: true });
 * ```
 *
 * The kit's asset pipeline reads `soundsRegistry` on every flush and
 * builds the atlas (long:false bucket) + standalone files (long:true
 * bucket) into `resources/client/`, then codegens per-id sidecars +
 * barrel under `src/generated/sounds*`. Playback is via the script APIs
 * in `api/audio.ts` (`playMono` / `playAt` / `playOnNode`).
 */
export function sound<const Id extends string>(
    id: Id,
    options: SoundOptions,
): Id extends keyof SoundHandleMap ? SoundHandleMap[Id] : SoundHandle {
    const long = options.long ?? false;
    const src = options.src instanceof URL ? options.src.href : options.src;
    const name = options.name ?? id;
    const existing = get(registry.sounds, id);
    if (existing) {
        // claim ownership — promotes from PLACEHOLDER_OWNER (barrel-first
        // boot) to this user module, adds id to module's pending set so
        // endModuleRun doesn't fire removed on this run, throws on
        // duplicate declaration from another file.
        claimOwnership(registry.sounds, id);
        // patch `src` / `long` / `name` when the user changed args so the
        // cli pipeline picks up the new source on its next pass. `touch()`
        // re-hashes and fires `changed`, bumping `revision`.
        if (existing.src !== src || existing.long !== long || existing.name !== name) {
            const target = existing as Mutable<SoundHandle>;
            target.src = src;
            target.long = long;
            target.name = name;
            touch(registry.sounds, id);
        }
        recordSound(id);
        return existing as never;
    }

    // no warning here — placeholder is the normal cold-start state. the
    // user-entry shim wipes `src/generated/sounds.ts` on every dev start
    // (schema-drift protection in `resetGeneratedBarrels`), so EVERY
    // declared sound hits this path before the pipeline's first flush
    // populates the barrel. warning would fire on every cold boot for
    // every sound declared in the project, which isn't actionable.
    const placeholder = createPlaceholderHandle(id, src, long, name);
    const handle = upsert(registry.sounds, id, placeholder);
    recordSound(id);
    return handle.payload as never;
}
