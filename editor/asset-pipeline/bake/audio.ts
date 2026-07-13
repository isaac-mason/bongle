// builds the audio atlas + standalone files + codegen from soundsRegistry.
//
// reads source audio files (.wav/.mp3/.ogg/.flac) listed by `sound()`
// declarations, partitions on `long: true` and emits:
//   resources/client/audio-atlas.flac, concatenated long:false bucket
//   resources/client/audio/{id}.mp3, one file per long:true clip
//   resources/client/audio-manifest.json, both buckets, with offsets
//   src/generated/sounds.ts, single barrel: all handles inline
//
// codegen emits ALL SoundHandles inline in a single barrel file (no per-id
// sidecars). Each handle is a small object literal so the whole file stays
// short even with 77+ engine builtins. The barrel declaration-merges
// `SoundHandleMap` for typed lookup and calls `__kit.registerSound(id, handle)`
// to mutate the existing registry payload in place. User code holding
// `const Foo = sound('foo', ...)` sees the updated `.duration` on next
// access without ref invalidation.
//
// Single-file rationale: cold start writes 1 file vs N+1, eliminating the
// HMR wall when many sounds are declared (the engine ships 77 builtins).
// Re-evaluating all handles on any sound edit is cheap, they're inert
// object literals.
//
// the artifact manifest is the cache marker for the atlas + standalone
// build (single rebuild gate). independent hashes per bucket inside the
// manifest let us skip atlas rebuilds when only a long clip changed and
// vice-versa. sidecars are always re-emitted from the decoded durations
// (cheap, keeps types in sync). change gates hash source BYTES (loaded via
// the injected loader), not mtimes: mtimes don't exist in the browser fs,
// and content hashing is the same gate every other builder uses.
//
// codecs — no native binary, no child_process, no ffprobe:
//   - decode: the injected `decodeAudio` capability (browser
//     OfflineAudioContext, resamples in one call). durations come from the
//     decoded PCM sample counts, exact for the atlas offsets, no probe.
//   - atlas: our own FLAC encoder (bake/flac.ts). FLAC is lossless AND gapless
//     — decode returns the EXACT sample count, so the concatenated atlas's
//     per-clip offsets stay sample-aligned with zero delay compensation. It's
//     also compressed (~4:1 on tonal SFX) and `decodeAudioData`-decodable on
//     every browser, so the play client's atlas read is unchanged bar the
//     filename. (MP3/AAC/Opus all carry encoder delay that would smear the
//     offsets; lamejs can't write the gapless LAME header. FLAC sidesteps all
//     of it.)
//   - standalone: MP3 via lamejs (bake/mp3.ts). long clips play from offset 0
//     so encoder delay is irrelevant, and they need lossy compression.

import type { ResourceLoader } from '../../../src/core/resource-loader';
import type { KindStore, SoundHandle } from '../../../src/internal';
import type { Filesystem } from '../../fs';
import type { DecodeAudio } from './decode-audio';
import { encodeFlacMono } from './flac';
import { encodeMp3 } from './mp3';

const SAMPLE_RATE = 48000;
const STANDALONE_BITRATE_KBPS = 128;

// folded into atlasHash so that a builder-format change invalidates any
// on-disk atlas + manifest without the user having to nuke their cache.
// bump this when the encode pipeline changes in a way that affects manifest
// offsets or the atlas byte layout.
const ATLAS_FORMAT_VERSION = 'v7-flac-mono';

export type BuildAudioOptions = {
    /** the editor project filesystem the atlas/standalone/manifest/barrel
     *  write into (host-provided; see pipeline InitCtx). */
    fs: Filesystem;
    /** bake-input byte loader: registry `src` refs (URLs / project-relative
     *  paths) → bytes. host-provided (see pipeline InitCtx). */
    loader: ResourceLoader;
    /** host-injected audio decode (browser OfflineAudioContext). See
     *  bake/decode-audio.ts and the pipeline InitCtx. */
    decodeAudio: DecodeAudio;
};

export type AudioManifestAtlasEntry = {
    id: string;
    /** seconds, feeds AudioBufferSourceNode.start(when, offset, duration). */
    offset: number;
    duration: number;
};

export type AudioManifestStandaloneEntry = {
    id: string;
    /** url relative to the resources/client serve root (e.g. "audio/theme.mp3"). */
    url: string;
    durationSec: number;
};

export type AudioManifest = {
    /** combined hash over both buckets, drives the artifact cache check. */
    hash: string;
    /** hash over only the atlas bucket sources, for selective rebuild. */
    atlasHash: string;
    /** hash over only the standalone bucket sources, for selective rebuild. */
    standaloneHash: string;
    sampleRate: number;
    atlas: AudioManifestAtlasEntry[];
    standalone: AudioManifestStandaloneEntry[];
};

/** Per-id codegen entry, input to the barrel emitter. */
type CodegenEntry = {
    id: string;
    src: string;
    long: boolean;
    duration: number;
};

/** A declared sound with its source bytes resolved through the loader. */
type LoadedSource = {
    id: string;
    src: string;
    long: boolean;
    bytes: Uint8Array;
};

// project-relative outputs on the ctx Filesystem.
const CLIENT_DIR = 'resources/client';
const ATLAS_PATH = `${CLIENT_DIR}/audio-atlas.flac`;
const STANDALONE_DIR = `${CLIENT_DIR}/audio`;
const MANIFEST_PATH = `${CLIENT_DIR}/audio-manifest.json`;
const BARREL_PATH = 'src/generated/sounds.ts';

const enc = new TextEncoder();

const EMPTY_BARREL = `// auto-generated by asset pipeline — do not edit
export {};
`;

/**
 * build the audio atlas + standalone files + barrel from soundsRegistry
 * contents.
 *
 * iterates soundsRegistry, partitions on `long`. produces one FLAC atlas
 * for the long:false bucket plus one MP3 per long:true clip. manifest
 * carries hashes per bucket so a long-clip edit doesn't bust the atlas
 * cache and vice versa. duration (from the decoded PCM sample count) is
 * baked into each handle literal in the barrel so user code reads
 * `handle.duration` statically.
 *
 * returns true if anything was rebuilt, false on full cache hit.
 */
export async function buildAudio(soundsRegistry: KindStore<SoundHandle>, opts: BuildAudioOptions): Promise<boolean> {
    const { fs, loader, decodeAudio } = opts;

    // partition sources, sorted by id for deterministic order (the atlas
    // concatenation order — and thus its offsets — follows this).
    const all = [...soundsRegistry.byId.entries()]
        .map(([id, h]) => ({ id, src: h.payload.src, long: h.payload.long }))
        .sort((a, b) => a.id.localeCompare(b.id));

    if (all.length === 0) {
        // No sounds declared: emit a valid empty manifest (no clips) rather than
        // deleting it, so the client never 404s on audio-manifest.json. Drop the
        // atlas/standalone binaries (unreferenced with 0 clips). The empty `hash`
        // reads back falsy, so change gates treat it like missing audio and a
        // later non-empty build rebuilds.
        await fs.remove(ATLAS_PATH);
        await fs.remove(STANDALONE_DIR, { recursive: true });
        const empty: AudioManifest = {
            hash: '',
            atlasHash: '',
            standaloneHash: '',
            sampleRate: SAMPLE_RATE,
            atlas: [],
            standalone: [],
        };
        await fs.write(MANIFEST_PATH, JSON.stringify(empty, null, 2));
        await fs.writeIfChanged(BARREL_PATH, EMPTY_BARREL);
        return false;
    }

    // Resolve source bytes once, up front: they feed the content hash gate
    // (and, on rebuild, the decoder). A missing source is fatal (a declared
    // sound with no file can't be baked).
    const atlasSources = await loadSources(
        loader,
        all.filter((s) => !s.long),
    );
    const standaloneSources = await loadSources(
        loader,
        all.filter((s) => s.long),
    );

    const atlasHash = await computeBucketHash(atlasSources, ATLAS_FORMAT_VERSION);
    const standaloneHash = await computeBucketHash(standaloneSources);
    const combinedHash = await sha256Hex(enc.encode(`${atlasHash}${standaloneHash}`));

    const existing = await readManifest(fs);
    const atlasUpToDate = existing?.atlasHash === atlasHash && (atlasSources.length === 0 || (await fs.exists(ATLAS_PATH)));
    const standaloneUpToDate =
        existing?.standaloneHash === standaloneHash &&
        (await allExist(
            fs,
            standaloneSources.map((s) => standalonePath(s.id)),
        ));

    let manifest: AudioManifest;
    let rebuilt = false;

    if (existing?.hash === combinedHash && atlasUpToDate && standaloneUpToDate) {
        // full cache hit, reuse the on-disk manifest for codegen durations.
        manifest = existing;
    } else {
        console.log(`[bongle] building audio (${atlasSources.length} atlas, ${standaloneSources.length} standalone)...`);

        const atlasEntries: AudioManifestAtlasEntry[] =
            atlasUpToDate && existing ? existing.atlas : await buildAtlas(decodeAudio, atlasSources, fs);

        let standaloneEntries: AudioManifestStandaloneEntry[];
        if (standaloneUpToDate && existing) {
            standaloneEntries = existing.standalone;
        } else {
            standaloneEntries = await buildStandalones(decodeAudio, standaloneSources, fs);
            // prune stale standalones whose id is no longer declared.
            await pruneStandalones(fs, new Set(standaloneEntries.map((e) => e.id)));
        }

        manifest = {
            hash: combinedHash,
            atlasHash,
            standaloneHash,
            sampleRate: SAMPLE_RATE,
            atlas: atlasEntries,
            standalone: standaloneEntries,
        };
        await fs.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
        rebuilt = true;
        console.log(`[bongle] audio built: atlas ${atlasEntries.length} clips, standalone ${standaloneEntries.length} files`);
    }

    // ── codegen barrel ──────────────────────────────────────────────
    // assemble per-id entries by joining all declared sounds against the
    // manifest's decoded durations, then emit a single barrel file with
    // all handle literals inline. Cheap to re-emit unconditionally;
    // keeps the generated types in lockstep with current handle metadata.
    const durationById = new Map<string, number>();
    for (const e of manifest.atlas) durationById.set(e.id, e.duration);
    for (const e of manifest.standalone) durationById.set(e.id, e.durationSec);

    const codegenEntries: CodegenEntry[] = all.map((s) => ({
        id: s.id,
        src: s.src,
        long: s.long,
        duration: durationById.get(s.id) ?? 0,
    }));

    await fs.writeIfChanged(BARREL_PATH, renderBarrel(codegenEntries));

    return rebuilt;
}

/* ── source loading ── */

async function loadSources(
    loader: ResourceLoader,
    sounds: Array<{ id: string; src: string; long: boolean }>,
): Promise<LoadedSource[]> {
    const out: LoadedSource[] = [];
    for (const s of sounds) {
        let bytes: Uint8Array;
        try {
            bytes = await loader.loadBytes(s.src);
        } catch {
            throw new Error(`[bongle] sound "${s.id}" source missing or unreadable: ${s.src}`);
        }
        out.push({ ...s, bytes });
    }
    return out;
}

/* ── manifest helpers ── */

async function readManifest(projectFs: Filesystem): Promise<AudioManifest | null> {
    try {
        const parsed = JSON.parse(await projectFs.readText(MANIFEST_PATH)) as Partial<AudioManifest>;
        if (
            typeof parsed.hash === 'string' &&
            typeof parsed.atlasHash === 'string' &&
            typeof parsed.standaloneHash === 'string' &&
            Array.isArray(parsed.atlas) &&
            Array.isArray(parsed.standalone)
        ) {
            return parsed as AudioManifest;
        }
    } catch {
        /* fall through */
    }
    return null;
}

/** Content hash over a bucket's sources, in declaration order (id-sorted by
 *  the caller — order matters, it's the atlas concat order). Folds in each
 *  source's id + src + byte digest, plus an optional format-version salt. */
async function computeBucketHash(sources: LoadedSource[], salt = ''): Promise<string> {
    const parts: string[] = [];
    if (salt) parts.push(salt);
    for (const s of sources) parts.push(s.id, s.src, await sha256Hex(s.bytes));
    return sha256Hex(enc.encode(parts.join('\0')));
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    // cast: loader/TextEncoder Uint8Arrays are ArrayBuffer-backed in practice,
    // but their type is the wider ArrayBufferLike that BufferSource rejects.
    const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
    const view = new Uint8Array(digest);
    let hex = '';
    for (const b of view) hex += b.toString(16).padStart(2, '0');
    return hex;
}

/* ── builders ── */

/** Downmix per-channel s16 → mono s16 (channel average). The atlas is mono. */
function downmixMono(channels: Int16Array[]): Int16Array {
    if (channels.length === 1) return channels[0]!;
    const n = channels[0]!.length;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
        let sum = 0;
        for (const c of channels) sum += c[i]!;
        out[i] = Math.round(sum / channels.length);
    }
    return out;
}

async function buildAtlas(decodeAudio: DecodeAudio, sources: LoadedSource[], fs: Filesystem): Promise<AudioManifestAtlasEntry[]> {
    if (sources.length === 0) {
        await fs.remove(ATLAS_PATH);
        return [];
    }

    // Decode every source to mono s16 PCM at SAMPLE_RATE, concatenate, then
    // FLAC-encode the whole stream. FLAC is lossless + gapless, so decoding the
    // atlas back yields exactly these samples in the same positions and every
    // clip's offset + duration (from the PCM sample counts below) lands
    // sample-accurate.
    const pcmChunks: Int16Array[] = [];
    const sampleCounts: number[] = [];
    for (const s of sources) {
        const decoded = await decodeAudio(s.bytes, SAMPLE_RATE);
        const mono = downmixMono(decoded.channels);
        pcmChunks.push(mono);
        sampleCounts.push(mono.length);
    }

    const atlasBytes = encodeFlacMono(concatInt16(pcmChunks), SAMPLE_RATE);
    await fs.write(ATLAS_PATH, atlasBytes);

    const entries: AudioManifestAtlasEntry[] = [];
    let cumSamples = 0;
    for (let i = 0; i < sources.length; i++) {
        const samples = sampleCounts[i]!;
        entries.push({
            id: sources[i]!.id,
            offset: cumSamples / SAMPLE_RATE,
            duration: samples / SAMPLE_RATE,
        });
        cumSamples += samples;
    }
    return entries;
}

async function buildStandalones(
    decodeAudio: DecodeAudio,
    sources: LoadedSource[],
    fs: Filesystem,
): Promise<AudioManifestStandaloneEntry[]> {
    const entries: AudioManifestStandaloneEntry[] = [];
    for (const s of sources) {
        const decoded = await decodeAudio(s.bytes, SAMPLE_RATE);
        const mp3 = encodeMp3(decoded.channels, SAMPLE_RATE, STANDALONE_BITRATE_KBPS);
        await fs.write(standalonePath(s.id), mp3);
        const durationSec = decoded.channels[0]!.length / SAMPLE_RATE;
        entries.push({ id: s.id, url: `audio/${s.id}.mp3`, durationSec });
    }
    return entries;
}

async function pruneStandalones(fs: Filesystem, liveIds: Set<string>): Promise<void> {
    for (const entry of await fs.list(STANDALONE_DIR)) {
        if (entry.kind !== 'file' || !entry.path.endsWith('.mp3')) continue;
        const id = entry.path
            .split('/')
            .pop()!
            .replace(/\.mp3$/, '');
        if (!liveIds.has(id)) await fs.remove(entry.path);
    }
}

function standalonePath(id: string): string {
    return `${STANDALONE_DIR}/${id}.mp3`;
}

async function allExist(fs: Filesystem, paths: string[]): Promise<boolean> {
    for (const p of paths) if (!(await fs.exists(p))) return false;
    return true;
}

function concatInt16(chunks: Int16Array[]): Int16Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Int16Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

/* ── codegen: single-file barrel ── */

function renderBarrel(entries: CodegenEntry[]): string {
    if (entries.length === 0) return EMPTY_BARREL;

    assertNoIdentCollisions(entries.map((e) => e.id));

    const lines: string[] = [];
    lines.push(`// auto-generated by asset pipeline — do not edit`);
    lines.push(``);
    lines.push(`import type { SoundHandle } from 'bongle';`);
    // `__kit` is provided in module scope by the kit Vite plugin's
    // prelude (see kit/src/vite/plugin.ts), re-importing it here would
    // collide with the prelude's top-level `import { __kit }` and parse
    // as "Identifier '__kit' has already been declared".
    lines.push(``);

    // inline every handle literal, one short block per id. ~7 lines each;
    // 77 builtins + N user sounds stays under ~1000 lines total.
    for (const e of entries) {
        const constId = sanitizeIdent(e.id);
        lines.push(`// source: ${e.src}`);
        lines.push(`const ${constId}: SoundHandle = {`);
        lines.push(`    soundId: ${JSON.stringify(e.id)},`);
        lines.push(`    name: ${JSON.stringify(e.id)},`);
        lines.push(`    dependency: { registry: 'sounds', id: ${JSON.stringify(e.id)} },`);
        lines.push(`    src: ${JSON.stringify(e.src)},`);
        lines.push(`    long: ${e.long},`);
        lines.push(`    duration: ${fmtNum(e.duration)},`);
        lines.push(`    version: 0,`);
        lines.push(`};`);
        lines.push(``);
    }

    lines.push(`declare module 'bongle' {`);
    lines.push(`    interface SoundHandleMap {`);
    for (const e of entries) {
        lines.push(`        ${JSON.stringify(e.id)}: typeof ${sanitizeIdent(e.id)};`);
    }
    lines.push(`    }`);
    lines.push(`}`);
    lines.push(``);

    for (const e of entries) {
        lines.push(`__kit.registerSound(${JSON.stringify(e.id)}, ${sanitizeIdent(e.id)});`);
    }
    lines.push(``);
    lines.push(`export {};`);
    lines.push(``);
    return lines.join('\n');
}

/* ── helpers ── */

/**
 * Sound ids must be unique AFTER `sanitizeIdent` because every id becomes
 * a top-level `const` name in the generated barrel. Two ids that sanitize
 * to the same identifier (`'foo-bar'` and `'foo_bar'` → `foo_bar`) would
 * silently produce duplicate declarations and fail downstream with a
 * cryptic TS error. Surface the actual conflict here with the offending ids.
 */
function assertNoIdentCollisions(ids: string[]): void {
    const byIdent = new Map<string, string[]>();
    for (const id of ids) {
        const ident = sanitizeIdent(id);
        const bucket = byIdent.get(ident);
        if (bucket) bucket.push(id);
        else byIdent.set(ident, [id]);
    }
    const collisions = [...byIdent.entries()].filter(([, raw]) => raw.length > 1);
    if (collisions.length === 0) return;
    const detail = collisions.map(([ident, raw]) => `  '${ident}' ← ${raw.map((s) => `'${s}'`).join(', ')}`).join('\n');
    throw new Error(`[bongle] sound ids collide after identifier sanitization (ids must be globally unique):\n${detail}`);
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function sanitizeIdent(id: string): string {
    if (IDENT_RE.test(id)) return id;
    let s = id.replace(/[^A-Za-z0-9_$]/g, '_');
    if (/^[0-9]/.test(s)) s = `_${s}`;
    return s;
}

function fmtNum(n: number): string {
    if (Object.is(n, -0)) return '0';
    return Number.isInteger(n) ? n.toFixed(1) : String(n);
}
