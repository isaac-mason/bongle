// builds the audio atlas + standalone files + codegen from soundsRegistry.
//
// reads source audio files (.wav/.mp3/.ogg/.flac) listed by `sound()`
// declarations, partitions on `long: true` and emits:
//   resources/client/audio-atlas.mp3           — concatenated long:false bucket
//   resources/client/audio/{id}.mp3            — one file per long:true clip
//   resources/client/audio-manifest.json      — both buckets, with offsets
//   src/generated/sounds.ts                   — single barrel: all handles inline
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
// Re-evaluating all handles on any sound edit is cheap — they're inert
// object literals.
//
// the artifact manifest is the cache marker for the atlas + standalone
// build (single rebuild gate). independent hashes per bucket inside the
// manifest let us skip atlas rebuilds when only a long clip changed and
// vice-versa. sidecars are always re-emitted from the probed durations
// (cheap, keeps types in sync).
//
// transport (ffmpeg/ffprobe): we shell out via child_process.spawn and
// pull binaries via @ffmpeg-installer/ffmpeg / @ffprobe-installer/ffprobe
// (cross-platform, no system dep, no fluent-ffmpeg wrapper).
//
// encoding: MP3 (libmp3lame), 48000 Hz, atlas mono. MP3 is the most
// universally `decodeAudioData`-supported format (every browser incl.
// Safari), and libmp3lame writes the LAME gapless header (encoder delay +
// padding) that browsers honor — so a single-pass encode of the
// concatenated PCM round-trips sample-exact and the atlas offsets stay
// aligned. Opus-in-Ogg was dropped: Safari can't decode it via Web Audio
// at all, and some Chrome setups (e.g. high output-device sample rates)
// throw EncodingError on otherwise-valid Ogg/Opus.

import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import type { KindStore, SoundHandle } from '../../internal';
import { resolveSrcToAbsPath, writeFileIfChanged } from './util';

const FFMPEG = ffmpegInstaller.path;
const FFPROBE = ffprobeInstaller.path;

// pnpm sometimes strips the POSIX exec bit when extracting the ffmpeg/
// ffprobe installer tarballs (the platform sub-packages ship the binary
// as a regular data file — there's no `bin` field and no postinstall to
// chmod it). spawn() then fails with EACCES. force-set 0755 once at
// module load; cheap, idempotent, no-op on win32.
if (process.platform !== 'win32') {
    for (const bin of [FFMPEG, FFPROBE]) {
        try {
            fs.chmodSync(bin, 0o755);
        } catch {
            /* missing → real error surfaces on spawn */
        }
    }
}

const SAMPLE_RATE = 48000;
const ATLAS_BITRATE = '96k';
const STANDALONE_BITRATE = '128k';

// folded into atlasHash so that a builder-format change invalidates any
// on-disk atlas + manifest without the user having to nuke their cache.
// bump this when the encode pipeline changes in a way that affects manifest
// offsets or the atlas byte layout.
const ATLAS_FORMAT_VERSION = 'v5-pcm-concat-mp3';

export type BuildAudioOptions = {
    /** absolute path to the project root. */
    projectDir: string;
};

export type AudioManifestAtlasEntry = {
    id: string;
    /** seconds — feeds AudioBufferSourceNode.start(when, offset, duration). */
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
    /** combined hash over both buckets — drives the artifact cache check. */
    hash: string;
    /** hash over only the atlas bucket sources — for selective rebuild. */
    atlasHash: string;
    /** hash over only the standalone bucket sources — for selective rebuild. */
    standaloneHash: string;
    sampleRate: number;
    atlas: AudioManifestAtlasEntry[];
    standalone: AudioManifestStandaloneEntry[];
};

/** Per-id codegen entry — input to the sidecar + barrel emitters. */
type CodegenEntry = {
    id: string;
    src: string;
    long: boolean;
    duration: number;
};

type Paths = {
    outDir: string;
    atlasFile: string;
    standaloneDir: string;
    manifestPath: string;
    barrelPath: string;
};

function resolvePaths(projectDir: string): Paths {
    const outDir = path.join(projectDir, 'resources', 'client');
    return {
        outDir,
        atlasFile: path.join(outDir, 'audio-atlas.mp3'),
        standaloneDir: path.join(outDir, 'audio'),
        manifestPath: path.join(outDir, 'audio-manifest.json'),
        barrelPath: path.join(projectDir, 'src', 'generated', 'sounds.ts'),
    };
}

const EMPTY_BARREL = `// auto-generated by asset pipeline — do not edit
export {};
`;

/**
 * build the audio atlas + standalone files + sidecars + barrel from
 * soundsRegistry contents.
 *
 * iterates soundsRegistry, partitions on `long`. produces one MP3 atlas
 * for the long:false bucket plus one MP3 per long:true clip. manifest
 * carries hashes per bucket so a long-clip edit doesn't bust the atlas
 * cache and vice versa. duration (ffprobed during build) is baked into
 * each handle literal in the barrel so user code reads `handle.duration`
 * statically.
 *
 * returns true if anything was rebuilt, false on full cache hit.
 */
export async function buildAudio(soundsRegistry: KindStore<SoundHandle>, opts: BuildAudioOptions): Promise<boolean> {
    const paths = resolvePaths(opts.projectDir);

    // partition sources, sorted by id for deterministic order.
    const all = [...soundsRegistry.byId.entries()]
        .map(([id, h]) => ({ id, src: h.payload.src, long: h.payload.long }))
        .sort((a, b) => a.id.localeCompare(b.id));

    if (all.length === 0) {
        // no sounds declared — clean up any leftover artifacts + codegen.
        try {
            fs.unlinkSync(paths.atlasFile);
        } catch {
            /* missing is fine */
        }
        try {
            fs.unlinkSync(paths.manifestPath);
        } catch {
            /* missing is fine */
        }
        try {
            fs.rmSync(paths.standaloneDir, { recursive: true, force: true });
        } catch {
            /* */
        }
        ensureDir(path.dirname(paths.barrelPath));
        writeFileIfChanged(paths.barrelPath, EMPTY_BARREL);
        return false;
    }

    const atlasResolved = all.filter((s) => !s.long).map((s) => ({ ...s, absPath: resolveSrcToAbsPath(s.src, opts.projectDir) }));
    const standaloneResolved = all
        .filter((s) => s.long)
        .map((s) => ({ ...s, absPath: resolveSrcToAbsPath(s.src, opts.projectDir) }));

    const atlasHash = computeBucketHash(
        atlasResolved.map((s) => s.absPath),
        ATLAS_FORMAT_VERSION,
    );
    const standaloneHash = computeBucketHash(standaloneResolved.map((s) => s.absPath));
    const combinedHash = crypto.createHash('sha256').update(atlasHash).update(standaloneHash).digest('hex');

    const existing = readManifest(paths.manifestPath);
    const atlasUpToDate = existing?.atlasHash === atlasHash && (atlasResolved.length === 0 || fs.existsSync(paths.atlasFile));
    const standaloneUpToDate =
        existing?.standaloneHash === standaloneHash &&
        standaloneResolved.every((s) => fs.existsSync(path.join(paths.standaloneDir, `${s.id}.mp3`)));

    let manifest: AudioManifest;
    let rebuilt = false;

    if (existing?.hash === combinedHash && atlasUpToDate && standaloneUpToDate) {
        // full cache hit — reuse the on-disk manifest for codegen durations.
        manifest = existing;
    } else {
        console.log(`[bongle] building audio (${atlasResolved.length} atlas, ${standaloneResolved.length} standalone)...`);
        ensureDir(paths.outDir);

        const atlasEntries: AudioManifestAtlasEntry[] =
            atlasUpToDate && existing ? existing.atlas : await buildAtlas(atlasResolved, paths.atlasFile);

        let standaloneEntries: AudioManifestStandaloneEntry[];
        if (standaloneUpToDate && existing) {
            standaloneEntries = existing.standalone;
        } else {
            ensureDir(paths.standaloneDir);
            standaloneEntries = await buildStandalones(standaloneResolved, paths.standaloneDir);
            // prune stale standalones whose id is no longer declared.
            const liveIds = new Set(standaloneEntries.map((e) => e.id));
            try {
                for (const name of fs.readdirSync(paths.standaloneDir)) {
                    const id = name.replace(/\.mp3$/, '');
                    if (!liveIds.has(id)) {
                        try {
                            fs.unlinkSync(path.join(paths.standaloneDir, name));
                        } catch {
                            /* */
                        }
                    }
                }
            } catch {
                /* dir may not exist yet — fine */
            }
        }

        manifest = {
            hash: combinedHash,
            atlasHash,
            standaloneHash,
            sampleRate: SAMPLE_RATE,
            atlas: atlasEntries,
            standalone: standaloneEntries,
        };
        fs.writeFileSync(paths.manifestPath, JSON.stringify(manifest, null, 2));
        rebuilt = true;
        console.log(`[bongle] audio built: atlas ${atlasEntries.length} clips, standalone ${standaloneEntries.length} files`);
    }

    // ── codegen barrel ──────────────────────────────────────────────
    // assemble per-id entries by joining all declared sounds against the
    // manifest's probed durations, then emit a single barrel file with
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

    emitBarrel(paths, codegenEntries);

    return rebuilt;
}

/* ── manifest helpers ── */

function readManifest(p: string): AudioManifest | null {
    try {
        if (!fs.existsSync(p)) return null;
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as Partial<AudioManifest>;
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

function computeBucketHash(absPaths: string[], salt = ''): string {
    const hash = crypto.createHash('sha256');
    if (salt) hash.update(salt);
    for (const p of [...absPaths].sort()) {
        hash.update(p);
        try {
            const stat = fs.statSync(p);
            hash.update(String(stat.mtimeMs));
        } catch {
            hash.update('missing');
        }
    }
    return hash.digest('hex');
}

/* ── ffmpeg builders ── */

type ResolvedSource = { id: string; src: string; long: boolean; absPath: string };

async function buildAtlas(sources: ResolvedSource[], outPath: string): Promise<AudioManifestAtlasEntry[]> {
    if (sources.length === 0) {
        try {
            fs.unlinkSync(outPath);
        } catch {
            /* */
        }
        return [];
    }

    for (const s of sources) {
        if (!fs.existsSync(s.absPath)) {
            throw new Error(`[bongle] sound "${s.id}" source missing: ${s.absPath}`);
        }
    }

    // build one continuous PCM stream from the sources, then encode it in a
    // single MP3 pass. doing it as ONE encode (rather than per-clip then
    // concat) means there's exactly one block of encoder delay at the file
    // start and one of padding at the end — both described by the LAME
    // gapless header that browsers honor — so the decoded buffer is
    // sample-aligned with this concatenated PCM and every clip's offset +
    // duration (computed below from PCM sample counts) lands correctly. A
    // per-clip-then-concat approach would scatter delay/padding mid-stream
    // and smear the boundaries.
    //
    // forcing mono+s16le per source unifies channel layout so the wav concat
    // demuxer's `-c:a copy` is safe regardless of source mix.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bongle-audio-'));
    try {
        const wavPaths: string[] = [];
        const sampleCounts: number[] = [];

        for (let i = 0; i < sources.length; i++) {
            const wavPath = path.join(tmpDir, `${i}.wav`);
            await runProcess(FFMPEG, [
                '-y',
                '-i',
                sources[i]!.absPath,
                '-ac',
                '1',
                '-ar',
                String(SAMPLE_RATE),
                '-c:a',
                'pcm_s16le',
                wavPath,
            ]);
            wavPaths.push(wavPath);
            sampleCounts.push(await probeSampleCount(wavPath));
        }

        // ffmpeg concat demuxer needs a list file. single-quote each path
        // and escape embedded quotes per ffmpeg's escaping rules.
        const listPath = path.join(tmpDir, 'concat.txt');
        fs.writeFileSync(listPath, wavPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
        const mergedWav = path.join(tmpDir, 'merged.wav');
        await runProcess(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'copy', mergedWav]);

        await runProcess(FFMPEG, [
            '-y',
            '-i',
            mergedWav,
            '-ac',
            '1',
            '-ar',
            String(SAMPLE_RATE),
            '-c:a',
            'libmp3lame',
            '-b:a',
            ATLAS_BITRATE,
            outPath,
        ]);

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
    } finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            /* */
        }
    }
}

async function buildStandalones(sources: ResolvedSource[], outDir: string): Promise<AudioManifestStandaloneEntry[]> {
    const entries: AudioManifestStandaloneEntry[] = [];
    for (const s of sources) {
        if (!fs.existsSync(s.absPath)) {
            throw new Error(`[bongle] sound "${s.id}" source missing: ${s.absPath}`);
        }
        const outPath = path.join(outDir, `${s.id}.mp3`);
        const args = [
            '-y',
            '-i',
            s.absPath,
            '-ar',
            String(SAMPLE_RATE),
            '-c:a',
            'libmp3lame',
            '-b:a',
            STANDALONE_BITRATE,
            outPath,
        ];
        await runProcess(FFMPEG, args);
        const durationSec = await probeDurationSec(outPath);
        entries.push({ id: s.id, url: `audio/${s.id}.mp3`, durationSec });
    }
    return entries;
}

async function probeSampleCount(absPath: string): Promise<number> {
    // sample-accurate vs format=duration (which is float seconds and rounds).
    // for PCM wav the stream's time_base is 1/sample_rate, so duration_ts
    // is the exact sample count (ffprobe doesn't expose nb_samples for raw
    // PCM streams).
    const args = [
        '-v',
        'error',
        '-select_streams',
        'a:0',
        '-show_entries',
        'stream=duration_ts',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        absPath,
    ];
    const out = await runProcess(FFPROBE, args, { captureStdout: true });
    const n = parseInt(out.trim(), 10);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`[bongle] ffprobe could not read duration_ts from ${absPath}`);
    }
    return n;
}

async function probeDurationSec(absPath: string): Promise<number> {
    const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', absPath];
    const out = await runProcess(FFPROBE, args, { captureStdout: true });
    const n = parseFloat(out.trim());
    if (!Number.isFinite(n)) {
        throw new Error(`[bongle] ffprobe could not read duration from ${absPath}`);
    }
    return n;
}

function runProcess(bin: string, args: string[], opts: { captureStdout?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(opts.captureStdout ? stdout : '');
            else reject(new Error(`${path.basename(bin)} exited ${code}\n${stderr}`));
        });
    });
}

/* ── codegen: single-file barrel ── */

function emitBarrel(paths: Paths, entries: CodegenEntry[]): void {
    ensureDir(path.dirname(paths.barrelPath));
    writeFileIfChanged(paths.barrelPath, renderBarrel(entries));
}

function renderBarrel(entries: CodegenEntry[]): string {
    if (entries.length === 0) return EMPTY_BARREL;

    assertNoIdentCollisions(entries.map((e) => e.id));

    const lines: string[] = [];
    lines.push(`// auto-generated by asset pipeline — do not edit`);
    lines.push(``);
    lines.push(`import type { SoundHandle } from 'bongle';`);
    // `__kit` is provided in module scope by the kit Vite plugin's
    // prelude (see kit/src/vite/plugin.ts) — re-importing it here would
    // collide with the prelude's top-level `import { __kit }` and parse
    // as "Identifier '__kit' has already been declared".
    lines.push(``);

    // inline every handle literal — one short block per id. ~7 lines each;
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

function ensureDir(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
}

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
