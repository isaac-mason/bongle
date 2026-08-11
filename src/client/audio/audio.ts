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
 *   - atlas: background at boot. `loadResources()` awaits only the tiny
 *     `audio-manifest.json` (sample rate + clip ids), then fires off a
 *     single `audio-atlas.flac` fetch + `decodeAudioData` that writes the
 *     decoded buffer into shared `AtlasState` WITHOUT blocking gameplay
 *     start. Once written it plays with zero latency for the session.
 *   - long clips: lazy, fetched + decoded into the clip's own buffer on
 *     first play. The manifest entry is known at boot; the file is not.
 *
 * Loading is data-driven, not callback-driven: the fetch+decode of each
 * buffer lives in a small `load*Into` writer that only mutates clip state
 * (`buffer` / `failed`), nothing subscribes to its promise. A play
 * triggered before its buffer is ready returns its `PlaybackHandle`
 * immediately and parks in `active` with `_pendingStart`; `updateForFrame`
 * starts the source the frame the buffer lands, or drops the play if the
 * load failed. `stop()` before then flips `_ended` and it's reaped, never
 * started.
 *
 * AudioContext gating: browsers refuse to play audio in a suspended
 * context. We construct the context lazily on first `play*` call (so SSR
 * imports don't fail) and `resume()` it inside the handler, the calling
 * script almost always runs from a user gesture (key/click handler), so
 * this is the natural place to satisfy the autoplay policy.
 *
 * Listener pose: read from the room's `AudioListenerTrait` node if one
 * is present and active, else from the client's `pov` node. Pose source is
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
import type { ResourceLoader } from '../../core/resource-loader';
import type { Node } from '../../core/scene/scene-tree';
import * as SceneTree from '../../core/scene/scene-tree';
import type { ClientRoom } from '../rooms';

/* ── manifest types (mirror of asset-pipeline/audio.ts) ────────────── */

type AtlasEntry = { id: string; offset: number; duration: number };
type StandaloneEntry = { id: string; url: string; durationSec: number };
type AudioManifest = {
    hash: string;
    sampleRate: number;
    atlas: AtlasEntry[];
    standalone: StandaloneEntry[];
};

/** shared, background-decoded atlas buffer. Every atlas clip references the
 *  same holder: `buffer` is null until the decode lands, `failed` latches if
 *  the fetch/decode threw. Both are pure state, written once by loadAtlasInto
 *  and read by play + the frame tick. */
type AtlasState = {
    buffer: AudioBuffer | null;
    failed: boolean;
};

/** resolved per-id clip, either a slice of the shared atlas buffer or
 *  a standalone url whose buffer is lazy-decoded on first play. All buffer
 *  state is plain fields, mutated by the load* writers, read by the tick. */
type ResolvedClip =
    | { kind: 'atlas'; atlas: AtlasState; offset: number; duration: number }
    | {
          kind: 'standalone';
          /** loader-relative path (e.g. 'sounds/foo.ogg'); loaded lazily on first
           *  play through `loader`. */
          url: string;
          loader: ResourceLoader;
          durationSec: number;
          /** null until the first play's load lands; latches for the session after. */
          buffer: AudioBuffer | null;
          /** load threw, every play of this clip is silently dropped. */
          failed: boolean;
          /** load has been kicked off (guards against a second fetch while pending). */
          loading: boolean;
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
    /** clips by sound id, atlas share a background-decoded buffer, standalones lazy. */
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
async function fetchManifest(loader: ResourceLoader): Promise<AudioManifest | null> {
    // through the injected loader (prod: fetch(assetUrl); editor: vfs). A missing
    // manifest (no sounds declared / unreadable) → null.
    try {
        const bytes = await loader.loadBytes('audio-manifest.json');
        return JSON.parse(new TextDecoder().decode(bytes)) as AudioManifest;
    } catch (err) {
        console.log('[audio] fetchManifest FAILED to load/parse audio-manifest.json:', err);
        return null;
    }
}

/** Build the clips map for a manifest against an existing context. The atlas
 *  fetch + decode is kicked off in the BACKGROUND (not awaited): every atlas
 *  clip references a shared `AtlasState` holder that fills in when the decode
 *  lands, so boot isn't blocked on the FLAC. Standalone clips stay lazy on
 *  first play. Shared by `loadResources` (boot) and `refreshResources` (HMR). */
function buildClips(context: AudioContext, manifest: AudioManifest, loader: ResourceLoader): Map<string, ResolvedClip> {
    const clips = new Map<string, ResolvedClip>();

    // one shared holder for the whole atlas: a single fetch + one
    // decodeAudioData covers every atlas clip, writing `buffer` when it lands.
    // Fire-and-forget into state, so clips triggered mid-decode park and start
    // from the tick, and everything after boots without waiting on the FLAC.
    if (manifest.atlas.length > 0) {
        const atlas: AtlasState = { buffer: null, failed: false };
        void loadAtlasInto(atlas, context, loader, manifest.atlas.length);
        for (const e of manifest.atlas) {
            clips.set(e.id, { kind: 'atlas', atlas, offset: e.offset, duration: e.duration });
        }
    }

    for (const e of manifest.standalone) {
        clips.set(e.id, {
            kind: 'standalone',
            url: e.url,
            loader,
            durationSec: e.durationSec,
            buffer: null,
            failed: false,
            loading: false,
        });
    }

    return clips;
}

/** The single async writer for the atlas: one fetch + one decode, result
 *  written into shared `AtlasState`. Never rejects (caller `void`s it); a
 *  failure latches `failed` and silences *every* atlas sound, so surface it
 *  loudly rather than as a per-play warning. */
async function loadAtlasInto(atlas: AtlasState, context: AudioContext, loader: ResourceLoader, count: number): Promise<void> {
    try {
        const raw = await loader.loadBytes('audio-atlas.flac');
        // decodeAudioData *detaches* its input ArrayBuffer; hand it a fresh
        // standalone copy (loadBytes may return a subarray view).
        atlas.buffer = await context.decodeAudioData(raw.slice().buffer);
    } catch (err) {
        atlas.failed = true;
        console.error(`[bongle] audio atlas failed to load — all ${count} atlas sounds will be silent:`, err);
    }
}

/** The single async writer for a standalone clip: fetch + decode its file,
 *  result written onto the clip. Kicked off on first play (guarded by
 *  `clip.loading`). Never rejects (caller `void`s it); a failure latches
 *  `failed` so subsequent plays drop cleanly. */
async function loadStandaloneInto(clip: Extract<ResolvedClip, { kind: 'standalone' }>, context: AudioContext): Promise<void> {
    try {
        const bytes = await clip.loader.loadBytes(clip.url);
        clip.buffer = await context.decodeAudioData(bytes.slice().buffer);
    } catch (err) {
        clip.failed = true;
        console.warn('[bongle] failed to load standalone audio:', err);
    }
}

/** load + decode the audio manifest + atlas. Called from
 *  `EngineClient.load()`. Always returns a live `AudioResources`, when
 *  no manifest is present (pipeline emitted nothing) the clips map is
 *  empty and `play(unknownId, ...)` no-ops cleanly. */
export async function loadResources(loader: ResourceLoader): Promise<AudioResources> {
    const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    const manifest = await fetchManifest(loader);
    // no manifest = no sounds declared. fine, return a live but empty resources
    // object so `play(unknownId, ...)` still no-ops cleanly.
    if (!manifest) {
        return makeResources(new Ctx(), new Map(), null);
    }

    const context = new Ctx({ sampleRate: manifest.sampleRate });
    const clips = buildClips(context, manifest, loader);
    return makeResources(context, clips, manifest.hash);
}

/** Wake the AudioContext on the first user gesture, and keep it awake across
 *  iOS interruptions. Browsers construct the context `suspended` and refuse to
 *  start any source until a `resume()` runs in (or after) a user gesture.
 *  `startPlayback` resumes fire-and-forget, but that only lands when the FIRST
 *  sound is triggered directly by a gesture — world-load ambience, scripted
 *  plays, and the editor's programmatic preview boot all fire off-gesture,
 *  leaving the context asleep and the game silent (most visibly inside the
 *  same-origin editor iframe).
 *
 *  iOS/Safari specifics this handles:
 *   - `resume()` alone doesn't always start the context; synchronously starting
 *     a one-sample silent BufferSource *inside* the gesture is the reliable
 *     unlock (the trick howler/tone use). We do both.
 *   - the context drops into a non-standard `'interrupted'` state when the tab
 *     backgrounds / a call arrives / the app is swiped away; we re-resume on
 *     `visibilitychange`/`pageshow`. (`'interrupted'` isn't in the TS
 *     `AudioContextState` union, hence the `!== 'running' && !== 'closed'`
 *     checks rather than naming it.)
 *
 *  Call once per load; a no-op under SSR / node bake (no `window`). */
export function installGestureUnlock(resources: AudioResources): void {
    if (typeof window === 'undefined') return;
    const { context } = resources;

    // capture phase (like howler): a game-canvas / UI handler that
    // stopPropagation()s must not be able to starve the unlock.
    const listenerOpts = { capture: true, passive: true } as const;
    const events = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'] as const;
    const detach = () => {
        for (const type of events) window.removeEventListener(type, onGesture, true);
    };
    const onGesture = () => {
        if (context.state === 'running') return detach();
        // iOS: resume() alone isn't enough; synchronously starting a silent
        // one-sample source inside the gesture is what actually unlocks the
        // graph. resume() covers every other browser. We detach only once the
        // buffer's `onended` fires — proof the graph really ran (howler's
        // signal), not just that resume()'s promise settled.
        try {
            const source = context.createBufferSource();
            source.buffer = context.createBuffer(1, 1, 22050);
            source.connect(context.destination);
            source.onended = () => {
                source.disconnect(0);
                detach();
            };
            source.start(0);
        } catch {
            // silent buffer start can throw on some browsers; resume() below still runs.
        }
        void context.resume();
    };
    for (const type of events) window.addEventListener(type, onGesture, listenerOpts);

    // iOS parks the context in 'interrupted' on background/call/app-switch;
    // wake it when we return to the foreground so already-playing loops resume
    // without waiting for the next play() call. Lives for the context lifetime
    // (engine-global), so no teardown.
    const onForeground = () => {
        if (document.visibilityState !== 'visible') return;
        if (context.state !== 'running' && context.state !== 'closed') void context.resume();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
}

/** Re-fetch the manifest + atlas and rebuild the clips map IN PLACE, so every
 *  room (each holds the same `resources` ref via `Audio.init`) picks up the new
 *  buffers without a reboot. Returns true when the audio actually moved (the
 *  manifest hash changed), false on a no-op. Called from the
 *  `bongle:audio-atlas-updated` HMR listener, the source-file edit has no
 *  registry change to ride, so this is the only path that reaches the live
 *  client. The AudioContext is reused (sample rate is a fixed constant), and
 *  in-flight playbacks keep their already-started buffers and finish cleanly. */
export async function refreshResources(resources: AudioResources, loader: ResourceLoader): Promise<boolean> {
    const manifest = await fetchManifest(loader);
    if (!manifest) return false;
    if (resources.hash !== null && manifest.hash === resources.hash) return false;

    const clips = buildClips(resources.context, manifest, loader);
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
    /** null until the source actually starts, a play whose buffer isn't ready
     *  returns a handle first; the source is created when the buffer lands
     *  (immediately, or from `updateForFrame` for a parked play). */
    source: AudioBufferSourceNode | null;
    gain: GainNode;
    panner: PannerNode | null;
    /** scene node to track for spatial position updates + auto-cancel on
     *  removal. null for `playMono` / `playAt` calls. */
    node: Node | null;
    /** clip + opts to start once its buffer is ready, set when a play fires
     *  before its buffer is decoded (atlas mid-decode / a standalone's first
     *  play). `updateForFrame` reads this: starts the source when the buffer
     *  lands, drops the play if the load failed. null once started. */
    _pendingStart: { clip: ResolvedClip; opts: PlayOpts } | null;
    /** stopped via .stop() OR source ended naturally. drives reaping. */
    _ended: boolean;
    /** flipped by handle.stop() before the buffer resolves; `startSource`
     *  checks this and bails without creating a source. */
    _cancelled: boolean;
    /** setDetune called before a parked play's source was created, stashed
     *  here so `startSource` applies it when it finally starts. */
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
    // called from a gesture this no-ops silently and the source plays when the
    // context wakes (see installGestureUnlock). fire-and-forget. `!== running`
    // (not `=== suspended`) also catches iOS's non-standard 'interrupted'.
    if (resources.context.state !== 'running' && resources.context.state !== 'closed') {
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
        _pendingStart: null,
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
            // parked play (buffer not ready): no source yet, `startSource`
            // applies _pendingDetune when it finally starts.
            playback._pendingDetune = cents;
        },
    };
    playback.handle = handle;
    audio.active.add(playback);

    // start now if the buffer's ready, drop if its load already failed, else
    // park: kick off the standalone's lazy load (the atlas load started at
    // boot) and let updateForFrame start it the frame the buffer lands.
    if (clipBuffer(clip)) {
        startSource(ctx, clip, playback, opts);
    } else if (clipFailed(clip)) {
        playback._ended = true;
    } else {
        if (clip.kind === 'standalone' && !clip.loading) {
            clip.loading = true;
            void loadStandaloneInto(clip, ctx);
        }
        playback._pendingStart = { clip, opts };
    }

    return handle;
}

/** The clip's decoded buffer, or null if not ready yet (atlas mid-decode /
 *  standalone not-yet-loaded). Uniform read over both transports. */
function clipBuffer(clip: ResolvedClip): AudioBuffer | null {
    return clip.kind === 'atlas' ? clip.atlas.buffer : clip.buffer;
}

/** Whether the clip's load permanently failed. */
function clipFailed(clip: ResolvedClip): boolean {
    return clip.kind === 'atlas' ? clip.atlas.failed : clip.failed;
}

/** Create + start the buffer source for a play whose buffer is ready. Atlas
 *  clips play a bounded slice of the shared concat buffer (and loop within it);
 *  standalone clips play their whole file. A stop() before this bails via
 *  `_cancelled` (the play is already `_ended`, reaped next tick). */
function startSource(ctx: AudioContext, clip: ResolvedClip, playback: ActivePlayback, opts: PlayOpts): void {
    if (playback._cancelled) return;
    const buffer = clipBuffer(clip);
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop ?? false;
    source.detune.value = playback._pendingDetune ?? opts.detune ?? 0;

    if (clip.kind === 'atlas') {
        // the atlas is a concat, constrain a loop to this clip's slice.
        if (source.loop) {
            source.loopStart = clip.offset;
            source.loopEnd = clip.offset + clip.duration;
        }
    }

    source.connect(playback.gain);
    source.onended = () => {
        playback._ended = true;
    };
    playback.source = source;

    if (clip.kind === 'atlas') {
        // start(when, offset, duration), for non-loop, pass duration so the
        // source stops at the slice end (without it we'd play straight through
        // into the next clip in the concat).
        if (source.loop) {
            source.start(0, clip.offset);
        } else {
            source.start(0, clip.offset, clip.duration);
        }
    } else {
        source.start();
    }
}

/* ── per-frame tick ────────────────────────────────────────────────── */

/** advance listener pose, start parked plays whose buffer just landed, refresh
 *  node-bound panner positions, reap finished playbacks. called once per active
 *  room per frame from engine-client's update loop (after DomUi.update, before
 *  render). */
export function updateForFrame(audio: Audio, room: ClientRoom): void {
    updateListener(audio, room);

    for (const p of audio.active) {
        if (p._ended) {
            cleanup(audio, p);
            continue;
        }
        if (p.node && p.node.scene === null) {
            // node removed (possibly while parked), cancel + reap.
            try {
                p.source?.stop();
            } catch {
                /* */
            }
            cleanup(audio, p);
            continue;
        }
        // parked play: start it the frame its buffer lands, drop it if the load
        // failed. data-driven, we poll the clip's buffer state, no per-play promise.
        if (p._pendingStart) {
            const { clip, opts } = p._pendingStart;
            if (clipBuffer(clip)) {
                p._pendingStart = null;
                startSource(audio.resources.context, clip, p, opts);
            } else if (clipFailed(clip)) {
                p._pendingStart = null;
                p._ended = true;
                continue; // reaped next frame
            } else {
                continue; // still loading, nothing else to do this frame
            }
        }
        if (p.node && p.panner) {
            const pos = readNodePosition(p.node);
            if (pos) setPannerPosition(p.panner, pos);
        }
    }
}

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

function updateListener(audio: Audio, room: ClientRoom): void {
    const listenerNode = resolveListenerNode(room);
    if (!listenerNode) return;
    const transform = SceneTree.getTrait(listenerNode, TransformTrait);
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

    // a transiently-degenerate transform (e.g. an interpolation chain not yet
    // seeded, or a singular decompose) can yield non-finite basis/position
    // values. WebAudio throws on a non-finite AudioParam write, which would
    // kill the whole frame loop, so skip this frame's listener update instead.
    if (
        !Number.isFinite(pos[0]) ||
        !Number.isFinite(pos[1]) ||
        !Number.isFinite(pos[2]) ||
        !Number.isFinite(fwdX) ||
        !Number.isFinite(fwdY) ||
        !Number.isFinite(fwdZ) ||
        !Number.isFinite(upX) ||
        !Number.isFinite(upY) ||
        !Number.isFinite(upZ)
    ) {
        return;
    }

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

function resolveListenerNode(room: ClientRoom): Node | null {
    for (const [trait] of SceneTree.query(room.nodes, [AudioListenerTrait])) {
        if (trait.active) return trait._node!;
    }
    return room.client.subject;
}

/* ── node position helper ──────────────────────────────────────────── */

function readNodePosition(node: Node): [number, number, number] | null {
    const transform = SceneTree.getTrait(node, TransformTrait);
    if (!transform) return null;
    const v = getVisualWorldPosition(transform);
    return [v[0], v[1], v[2]];
}

function setPannerPosition(panner: PannerNode, pos: readonly [number, number, number]): void {
    // guard against a non-finite source position (see updateListener); a bad
    // write throws and kills the frame loop.
    if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1]) || !Number.isFinite(pos[2])) return;
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
