/**
 * client-side audio runtime, per-room coordinator + Web Audio plumbing.
 *
 * sibling of `environment.ts` / `physics.ts`: top-level `Audio` namespace
 * with `init` / `dispose` / `updateForFrame` / `play*`, stored as
 * `room.audio` on each `ClientRoom`. server has no playback runtime, the
 * script-facing `playMono`/`playAt`/`playOnNode` (api/audio.ts) bail to
 * `null` on the server side, so this file is only reached on the client.
 *
 * Resource model (the contract):
 *   - atlas: eager at boot. `loadResources()` fetches `audio-atlas.mp3` +
 *     `audio-manifest.json` and runs one `decodeAudioData`. Every atlas
 *     clip is playable with zero latency from the first frame onward.
 *   - long clips: lazy at first play. The manifest entry is known at
 *     boot, but the file is not fetched until a script calls play*. First
 *     play kicks off `fetch(url)` + `decodeAudioData`; the
 *     `PlaybackHandle` is returned immediately and the source `start()`s
 *     when the buffer resolves. Decoded buffers are cached, so subsequent
 *     plays are instant. `stop()` called before resolution flips a
 *     cancellation flag.
 *
 * AudioContext gating: browsers refuse to play audio in a suspended
 * context. We construct the context lazily on first `play*` call (so SSR
 * imports don't fail) and `resume()` it inside the handler, the calling
 * script almost always runs from a user gesture (key/click handler), so
 * this is the natural place to satisfy the autoplay policy.
 *
 * Listener pose: read from the room's `AudioListenerTrait` node if one
 * is present and active, else from `room.pov.node`. Pose source is
 * the TransformTrait via `getVisualWorldPosition` /
 * `getVisualWorldMatrix` so interpolation is folded in for free. We
 * write to the listener's modern AudioParam interface where available
 * (Chrome, Firefox) and fall back to `setPosition`/`setOrientation` for
 * Safari, which still ships the legacy setters.
 *
 * Spatial sources use `PannerNode` with HRTF disabled (`panningModel:
 * 'equalpower'`), the v1 falloff opts (`ref`/`max`/`rolloff`/`model`)
 * map 1:1 to PannerNode props, so 'inverse' / 'linear' / 'exponential'
 * are direct passthroughs. Mono play skips the panner entirely (gain
 * straight to destination).
 *
 * Cleanup: every frame `updateForFrame` reaps active playbacks whose
 * source ended naturally (via onended → `_ended = true`) or whose bound
 * node has been removed from the scene (`node.scene === null`).
 */

import { AudioListenerTrait } from '../../builtins/audio-listener';
import { getVisualWorldMatrix, getVisualWorldPosition, TransformTrait } from '../../builtins/transform';
import type { Node, Nodes as NodesType } from '../../core/scene/nodes';
import * as Nodes from '../../core/scene/nodes';
import { assetUrl } from '../../render/asset-url';

/* ── manifest types (mirror of asset-pipeline/audio.ts) ────────────── */

type AtlasEntry = { id: string; offset: number; duration: number };
type StandaloneEntry = { id: string; url: string; durationSec: number };
type AudioManifest = {
    hash: string;
    sampleRate: number;
    atlas: AtlasEntry[];
    standalone: StandaloneEntry[];
};

/** resolved per-id clip, either a slice of the decoded atlas buffer or
 *  a standalone url whose buffer is lazy-decoded on first play. */
type ResolvedClip =
    | { kind: 'atlas'; buffer: AudioBuffer; offset: number; duration: number }
    | {
          kind: 'standalone';
          url: string;
          durationSec: number;
          buffer: AudioBuffer | null;
          pending: Promise<AudioBuffer> | null;
      };

/* ── resources (engine-global, loaded once at EngineClient.load) ───── */

export type AudioResources = {
    /** browser-owned audio context, lazy-resumed on first play. */
    context: AudioContext;
    /** engine-global output bus, every room's `masterGain` feeds this, and
     *  this feeds the context destination. Ramping it to 0 (`setOutputMuted`)
     *  silences all rooms at once; used to auto-mute the game during portal
     *  ads without games having to do anything. */
    outputGain: GainNode;
    /** last-applied output mute, lets `setOutputMuted` be called every frame
     *  (it reconciles from engine state) while only ramping on a real change. */
    muted: boolean;
    /** clips by sound id, atlas entries ready, standalones lazy. */
    clips: Map<string, ResolvedClip>;
    /** manifest combined `hash` the clips were built against (`null` when no
     *  manifest loaded). `refreshResources` compares against it to short-circuit
     *  a no-op HMR poke. */
    hash: string | null;
};

/** Build the resources object + the engine-global output bus for a context. */
function makeResources(context: AudioContext, clips: Map<string, ResolvedClip>, hash: string | null): AudioResources {
    const outputGain = context.createGain();
    outputGain.gain.value = 1;
    outputGain.connect(context.destination);
    return { context, outputGain, muted: false, clips, hash };
}

/** Mute/unmute all engine audio at the output bus, ramping (to avoid clicks)
 *  only on a real change. Called every frame from the client update loop,
 *  reconciling against `state.adActive`, muting during a portal ad is built-in,
 *  no game code involved. */
export function setOutputMuted(resources: AudioResources, muted: boolean): void {
    if (resources.muted === muted) return;
    resources.muted = muted;
    const g = resources.outputGain.gain;
    const now = resources.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(muted ? 0 : 1, now + 0.05);
}

/** Fetch + parse the audio manifest. `no-store` so a dev rebuild's bytes
 *  aren't served stale from the HTTP cache on an HMR refresh. Returns null
 *  when there's no manifest (no sounds declared) or it's unreadable. */
async function fetchManifest(): Promise<AudioManifest | null> {
    try {
        const res = await fetch(assetUrl('audio-manifest.json'), { cache: 'no-store' });
        if (!res.ok) return null;
        return (await res.json()) as AudioManifest;
    } catch {
        return null;
    }
}

/** Build the clips map for a manifest against an existing context: one eager
 *  atlas decode covering every atlas-bucket clip, plus lazy standalone stubs.
 *  Shared by `loadResources` (boot) and `refreshResources` (HMR). */
async function buildClips(context: AudioContext, manifest: AudioManifest): Promise<Map<string, ResolvedClip>> {
    const clips = new Map<string, ResolvedClip>();

    // eager atlas decode, one fetch + one decodeAudioData covers every
    // atlas-bucket clip. each id resolves to a (buffer, offset, duration)
    // view into the same shared buffer.
    if (manifest.atlas.length > 0) {
        try {
            const atlasRes = await fetch(assetUrl('audio-atlas.mp3'), { cache: 'no-store' });
            if (!atlasRes.ok) throw new Error(`atlas HTTP ${atlasRes.status}`);
            const bytes = await atlasRes.arrayBuffer();
            // decodeAudioData *detaches* its input ArrayBuffer; pass a fresh
            // copy so a re-invocation can't be handed a detached buffer.
            const buffer = await context.decodeAudioData(bytes.slice(0));
            for (const e of manifest.atlas) {
                clips.set(e.id, {
                    kind: 'atlas',
                    buffer,
                    offset: e.offset,
                    duration: e.duration,
                });
            }
        } catch (err) {
            // a failed atlas decode silences *every* atlas sound, not one,
            // surface it loudly rather than as a per-play warning.
            console.error(`[bongle] audio atlas failed to load — all ${manifest.atlas.length} atlas sounds will be silent:`, err);
        }
    }

    for (const e of manifest.standalone) {
        clips.set(e.id, {
            kind: 'standalone',
            url: assetUrl(e.url),
            durationSec: e.durationSec,
            buffer: null,
            pending: null,
        });
    }

    return clips;
}

/** load + decode the audio manifest + atlas. Called from
 *  `EngineClient.load()`. Always returns a live `AudioResources`, when
 *  no manifest is present (pipeline emitted nothing) the clips map is
 *  empty and `play(unknownId, ...)` no-ops cleanly. */
export async function loadResources(): Promise<AudioResources> {
    const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    const manifest = await fetchManifest();
    // no manifest = no sounds declared. fine, return a live but empty resources
    // object so `play(unknownId, ...)` still no-ops cleanly.
    if (!manifest) return makeResources(new Ctx(), new Map(), null);

    const context = new Ctx({ sampleRate: manifest.sampleRate });
    const clips = await buildClips(context, manifest);
    return makeResources(context, clips, manifest.hash);
}

/** Re-fetch the manifest + atlas and rebuild the clips map IN PLACE, so every
 *  room (each holds the same `resources` ref via `Audio.init`) picks up the new
 *  buffers without a reboot. Returns true when the audio actually moved (the
 *  manifest hash changed), false on a no-op. Called from the
 *  `bongle:audio-atlas-updated` HMR listener, the source-file edit has no
 *  registry change to ride, so this is the only path that reaches the live
 *  client. The AudioContext is reused (sample rate is a fixed constant), and
 *  in-flight playbacks keep their already-started buffers and finish cleanly. */
export async function refreshResources(resources: AudioResources): Promise<boolean> {
    const manifest = await fetchManifest();
    if (!manifest) return false;
    if (resources.hash !== null && manifest.hash === resources.hash) return false;

    const clips = await buildClips(resources.context, manifest);
    // replace the map's CONTENTS, not the reference, `resources.clips` is read
    // on every play and shared across rooms, so mutating in place propagates.
    resources.clips.clear();
    for (const [id, clip] of clips) resources.clips.set(id, clip);
    resources.hash = manifest.hash;
    return true;
}

/* ── PlaybackHandle ────────────────────────────────────────────────── */

export type PlaybackHandle = {
    /** stop playback. `fade` (seconds) ramps gain to zero before stopping
     *  to avoid clicks; default 0 (immediate). idempotent. */
    stop(opts?: { fade?: number }): void;
    /** linear gain in [0,1]. */
    setVolume(v: number): void;
    /** detune in cents, 100 = +1 semitone, -1200 = -1 octave. */
    setDetune(cents: number): void;
    readonly isPlaying: boolean;
};

/* ── active playback (internal) ────────────────────────────────────── */

/** internal record for an in-flight one-shot. lives in `Audio.active`
 *  until `_ended` (source.onended fired) or until its bound node is
 *  removed (`node.scene === null`), at which point updateForFrame stops
 *  + drops it. */
type ActivePlayback = {
    handle: PlaybackHandle;
    /** null until the source actually starts, long-clip plays return a
     *  handle before the buffer is decoded; the source is created inside
     *  the .then() and assigned here. */
    source: AudioBufferSourceNode | null;
    gain: GainNode;
    panner: PannerNode | null;
    /** scene node to track for spatial position updates + auto-cancel on
     *  removal. null for `playMono` / `playAt` calls. */
    node: Node | null;
    /** stopped via .stop() OR source ended naturally. drives reaping. */
    _ended: boolean;
    /** flipped by handle.stop() before buffer resolves, the .then()
     *  callback checks this and bails on start() if true. */
    _cancelled: boolean;
    /** setDetune called before the long-clip buffer resolved, stashed
     *  here so the .then() that creates the source can apply it. */
    _pendingDetune?: number;
};

/* ── play opts ─────────────────────────────────────────────────────── */

export type PlayOpts = {
    volume?: number;
    detune?: number;
    loop?: boolean;
};

export type Falloff = {
    ref?: number;
    max?: number;
    rolloff?: number;
    model?: 'inverse' | 'linear' | 'exponential';
};

export type SpatialOpts = PlayOpts & { falloff?: Falloff };

/* ── per-room coordinator ──────────────────────────────────────────── */

export type Audio = {
    resources: AudioResources;
    /** master gain for the room, all per-play gains hang off this. */
    masterGain: GainNode;
    /** in-flight one-shots, reaped per frame. */
    active: Set<ActivePlayback>;
    /** last listener pose written to the AudioContext.listener AudioParams,
     *  and the audio-context time of that write. used to skip redundant
     *  writes (per-frame AudioParam scheduling accumulates automation
     *  events and walks them, death by 1k cuts; even at idle we'd burn
     *  ms/frame). NaN sentinel forces the first write. */
    _listenerLast: {
        time: number;
        px: number;
        py: number;
        pz: number;
        fx: number;
        fy: number;
        fz: number;
        ux: number;
        uy: number;
        uz: number;
    };
};

export function init(resources: AudioResources): Audio {
    const masterGain = resources.context.createGain();
    masterGain.gain.value = 1;
    // feed the engine-global output bus (not the context destination directly)
    // so `setOutputMuted` can silence every room at once during ads.
    masterGain.connect(resources.outputGain);
    return {
        resources,
        masterGain,
        active: new Set(),
        _listenerLast: {
            time: 0,
            px: NaN,
            py: NaN,
            pz: NaN,
            fx: NaN,
            fy: NaN,
            fz: NaN,
            ux: NaN,
            uy: NaN,
            uz: NaN,
        },
    };
}

export function dispose(audio: Audio): void {
    for (const p of audio.active) {
        try {
            p.source?.stop();
        } catch {
            /* may not have started yet */
        }
        p._cancelled = true;
    }
    audio.active.clear();
    try {
        audio.masterGain.disconnect();
    } catch {
        /* */
    }
}

/* ── play APIs ─────────────────────────────────────────────────────── */

/** non-positional play, gain straight to master, no PannerNode. */
export function playMono(audio: Audio, soundId: string, opts: PlayOpts = {}): PlaybackHandle | null {
    return startPlayback(audio, soundId, null, null, opts);
}

/** positional play at a fixed world-space position. */
export function playAt(
    audio: Audio,
    soundId: string,
    pos: readonly [number, number, number],
    opts: SpatialOpts = {},
): PlaybackHandle | null {
    return startPlayback(audio, soundId, null, [pos[0], pos[1], pos[2]], opts);
}

/** positional play that follows a scene node, panner position is
 *  refreshed every frame from the node's interpolated world transform.
 *  cancels automatically when the node is removed. */
export function playOnNode(audio: Audio, soundId: string, node: Node, opts: SpatialOpts = {}): PlaybackHandle | null {
    return startPlayback(audio, soundId, node, null, opts);
}

/* ── playback core ─────────────────────────────────────────────────── */

function startPlayback(
    audio: Audio,
    soundId: string,
    node: Node | null,
    fixedPos: [number, number, number] | null,
    opts: SpatialOpts,
): PlaybackHandle | null {
    const { resources } = audio;

    const clip = resources.clips.get(soundId);
    if (!clip) return null;

    // browsers gate playback on user gesture, resume here. If we're not
    // called from a gesture this no-ops silently and the source plays
    // when the context auto-resumes later. fire-and-forget.
    if (resources.context.state === 'suspended') {
        void resources.context.resume();
    }

    const ctx = resources.context;
    const gain = ctx.createGain();
    gain.gain.value = opts.volume ?? 1;

    const spatial = node !== null || fixedPos !== null;
    let panner: PannerNode | null = null;
    if (spatial) {
        panner = ctx.createPanner();
        panner.panningModel = 'equalpower'; // skip HRTF, v1 only does basic stereo pan
        const f = (opts as SpatialOpts).falloff;
        panner.distanceModel = f?.model ?? 'inverse';
        panner.refDistance = f?.ref ?? 1;
        panner.maxDistance = f?.max ?? 100;
        panner.rolloffFactor = f?.rolloff ?? 1;
        const initial = fixedPos ?? readNodePosition(node!);
        if (initial) setPannerPosition(panner, initial);
        gain.connect(panner);
        panner.connect(audio.masterGain);
    } else {
        gain.connect(audio.masterGain);
    }

    const playback: ActivePlayback = {
        handle: null as unknown as PlaybackHandle,
        source: null,
        gain,
        panner,
        node,
        _ended: false,
        _cancelled: false,
    };

    const handle: PlaybackHandle = {
        get isPlaying() {
            return !playback._ended && !playback._cancelled;
        },
        stop(stopOpts) {
            if (playback._ended) return;
            playback._cancelled = true;
            const fade = stopOpts?.fade ?? 0;
            const now = ctx.currentTime;
            if (fade > 0) {
                gain.gain.cancelScheduledValues(now);
                gain.gain.setValueAtTime(gain.gain.value, now);
                gain.gain.linearRampToValueAtTime(0, now + fade);
                try {
                    playback.source?.stop(now + fade);
                } catch {
                    /* may not have started yet */
                }
            } else {
                try {
                    playback.source?.stop();
                } catch {
                    /* */
                }
            }
            playback._ended = true;
        },
        setVolume(v) {
            gain.gain.setValueAtTime(v, ctx.currentTime);
        },
        setDetune(cents) {
            if (playback.source) playback.source.detune.value = cents;
            // for long clips whose source isn't created yet, the value will
            // be applied inside the .then() callback below.
            playback._pendingDetune = cents;
        },
    };
    playback.handle = handle;
    audio.active.add(playback);

    // route to the right starter based on transport.
    if (clip.kind === 'atlas') {
        startAtlasSource(ctx, clip, playback, opts);
    } else {
        startStandaloneSource(ctx, clip, playback, opts);
    }

    return handle;
}

function startAtlasSource(
    ctx: AudioContext,
    clip: Extract<ResolvedClip, { kind: 'atlas' }>,
    playback: ActivePlayback,
    opts: PlayOpts,
): void {
    const source = ctx.createBufferSource();
    source.buffer = clip.buffer;
    source.loop = opts.loop ?? false;
    source.detune.value = opts.detune ?? 0;
    if (source.loop) {
        source.loopStart = clip.offset;
        source.loopEnd = clip.offset + clip.duration;
    }
    source.connect(playback.gain);
    source.onended = () => {
        playback._ended = true;
    };
    playback.source = source;
    // start(when, offset, duration), for non-loop, pass duration so the
    // source stops at the slice end (atlas is a concat, without this we'd
    // play straight through into the next clip).
    if (source.loop) {
        source.start(0, clip.offset);
    } else {
        source.start(0, clip.offset, clip.duration);
    }
}

function startStandaloneSource(
    ctx: AudioContext,
    clip: Extract<ResolvedClip, { kind: 'standalone' }>,
    playback: ActivePlayback,
    opts: PlayOpts,
): void {
    const startFromBuffer = (buffer: AudioBuffer) => {
        if (playback._cancelled) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = opts.loop ?? false;
        source.detune.value = playback._pendingDetune ?? opts.detune ?? 0;
        source.connect(playback.gain);
        source.onended = () => {
            playback._ended = true;
        };
        playback.source = source;
        source.start();
    };

    if (clip.buffer) {
        startFromBuffer(clip.buffer);
        return;
    }
    if (!clip.pending) {
        clip.pending = fetch(clip.url)
            .then((r) => r.arrayBuffer())
            .then((bytes) => ctx.decodeAudioData(bytes))
            .then((buf) => {
                clip.buffer = buf;
                return buf;
            });
    }
    clip.pending
        .then((buf) => startFromBuffer(buf))
        .catch((err) => {
            console.warn('[bongle] failed to load standalone audio:', err);
            playback._ended = true;
        });
}

/* ── per-frame tick ────────────────────────────────────────────────── */

/** advance listener pose, refresh node-bound panner positions, reap
 *  finished playbacks. called once per active room per frame from
 *  engine-client's update loop (after DomUi.update, before render). */
export function updateForFrame(audio: Audio, room: AudioRoomLike): void {
    updateListener(audio, room);

    for (const p of audio.active) {
        if (p._ended) {
            cleanup(audio, p);
            continue;
        }
        if (p.node) {
            if (p.node.scene === null) {
                // node removed, cancel + reap.
                try {
                    p.source?.stop();
                } catch {
                    /* */
                }
                cleanup(audio, p);
                continue;
            }
            if (p.panner) {
                const pos = readNodePosition(p.node);
                if (pos) setPannerPosition(p.panner, pos);
            }
        }
    }
}

/** subset of ClientRoom that updateForFrame actually reads. typed
 *  structurally so this file doesn't need to import the full ClientRoom
 *  type (which would pull in the entire client module graph). */
export type AudioRoomLike = {
    nodes: NodesType;
    pov: { node: Node | null };
};

function cleanup(audio: Audio, p: ActivePlayback): void {
    try {
        p.gain.disconnect();
    } catch {
        /* */
    }
    if (p.panner) {
        try {
            p.panner.disconnect();
        } catch {
            /* */
        }
    }
    audio.active.delete(p);
}

/* ── listener pose ─────────────────────────────────────────────────── */

function updateListener(audio: Audio, room: AudioRoomLike): void {
    const listenerNode = resolveListenerNode(room);
    if (!listenerNode) return;
    const transform = Nodes.getTrait(listenerNode, TransformTrait);
    if (!transform) return;

    const pos = getVisualWorldPosition(transform);
    const matrix = getVisualWorldMatrix(transform);
    // column-major mat4. forward = -Z basis (camera looks down -Z in our
    // convention), up = +Y basis. read straight off the matrix to avoid
    // a redundant quat decompose.
    const upX = matrix[4]!;
    const upY = matrix[5]!;
    const upZ = matrix[6]!;
    const fwdX = -matrix[8]!;
    const fwdY = -matrix[9]!;
    const fwdZ = -matrix[10]!;

    const listener = audio.resources.context.listener;
    if (listener.positionX) {
        // modern AudioParam interface, Chrome, Firefox. matches three.js:
        // use linearRampToValueAtTime over `setValueAtTime` for smoother
        // panning during motion (three.js#14393). schedule the ramp to
        // arrive ~one frame ahead.
        //
        // critical: skip unchanged params. each scheduled event is queued
        // on the param's automation list, and per-frame writes (9 params
        // × 60fps) accumulate into 1k+ events/sec the audio thread walks.
        // at idle the cost dwarfs everything else in updateListener.
        const last = audio._listenerLast;
        const now = audio.resources.context.currentTime;
        const dt = Math.max(now - last.time, 1 / 120);
        const endTime = now + dt;
        last.time = now;
        if (pos[0] !== last.px) {
            listener.positionX.linearRampToValueAtTime(pos[0], endTime);
            last.px = pos[0];
        }
        if (pos[1] !== last.py) {
            listener.positionY.linearRampToValueAtTime(pos[1], endTime);
            last.py = pos[1];
        }
        if (pos[2] !== last.pz) {
            listener.positionZ.linearRampToValueAtTime(pos[2], endTime);
            last.pz = pos[2];
        }
        if (fwdX !== last.fx) {
            listener.forwardX.linearRampToValueAtTime(fwdX, endTime);
            last.fx = fwdX;
        }
        if (fwdY !== last.fy) {
            listener.forwardY.linearRampToValueAtTime(fwdY, endTime);
            last.fy = fwdY;
        }
        if (fwdZ !== last.fz) {
            listener.forwardZ.linearRampToValueAtTime(fwdZ, endTime);
            last.fz = fwdZ;
        }
        if (upX !== last.ux) {
            listener.upX.linearRampToValueAtTime(upX, endTime);
            last.ux = upX;
        }
        if (upY !== last.uy) {
            listener.upY.linearRampToValueAtTime(upY, endTime);
            last.uy = upY;
        }
        if (upZ !== last.uz) {
            listener.upZ.linearRampToValueAtTime(upZ, endTime);
            last.uz = upZ;
        }
    } else {
        // safari legacy setters.
        const legacy = listener as unknown as {
            setPosition(x: number, y: number, z: number): void;
            setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        legacy.setPosition(pos[0], pos[1], pos[2]);
        legacy.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
    }
}

function resolveListenerNode(room: AudioRoomLike): Node | null {
    for (const [trait] of Nodes.query(room.nodes, [AudioListenerTrait])) {
        if (trait.active) return trait._node!;
    }
    return room.pov.node;
}

/* ── node position helper ──────────────────────────────────────────── */

function readNodePosition(node: Node): [number, number, number] | null {
    const transform = Nodes.getTrait(node, TransformTrait);
    if (!transform) return null;
    const v = getVisualWorldPosition(transform);
    return [v[0], v[1], v[2]];
}

function setPannerPosition(panner: PannerNode, pos: readonly [number, number, number]): void {
    if (panner.positionX) {
        // matches three.js + updateListener: linearRampToValueAtTime,
        // skip when unchanged to avoid automation-event accumulation.
        const now = panner.context.currentTime;
        const endTime = now + 1 / 60;
        if (panner.positionX.value !== pos[0]) panner.positionX.linearRampToValueAtTime(pos[0], endTime);
        if (panner.positionY.value !== pos[1]) panner.positionY.linearRampToValueAtTime(pos[1], endTime);
        if (panner.positionZ.value !== pos[2]) panner.positionZ.linearRampToValueAtTime(pos[2], endTime);
    } else {
        // safari legacy.
        (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos[0], pos[1], pos[2]);
    }
}
