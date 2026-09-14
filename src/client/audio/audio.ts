import { AudioListenerTrait } from '../../builtins/audio-listener';
import { getVisualWorldMatrix, getVisualWorldPosition, TransformTrait } from '../../builtins/transform';
import type { ResourceLoader } from '../../core/resource-loader';
import type { Node } from '../../core/scene/scene-tree';
import * as SceneTree from '../../core/scene/scene-tree';
import type { ClientRoom } from '../rooms';

// mirrors asset-pipeline/audio.ts.
type AtlasEntry = { id: string; offset: number; duration: number };
type StandaloneEntry = { id: string; url: string; durationSec: number };
type AudioManifest = {
    hash: string;
    sampleRate: number;
    atlas: AtlasEntry[];
    standalone: StandaloneEntry[];
};

/** shared, background-decoded atlas buffer. every atlas clip references the same holder:
 *  `buffer` is null until the decode lands, `failed` latches if the fetch/decode threw. */
type AtlasState = {
    buffer: AudioBuffer | null;
    failed: boolean;
};

/** either a slice of the shared atlas buffer or a standalone url lazy-decoded on first play. */
type ResolvedClip =
    | { kind: 'atlas'; atlas: AtlasState; offset: number; duration: number }
    | {
          kind: 'standalone';
          /** loader-relative path (e.g. 'sounds/foo.ogg'). */
          url: string;
          loader: ResourceLoader;
          durationSec: number;
          buffer: AudioBuffer | null;
          failed: boolean;
          /** guards against a second fetch while a load is pending. */
          loading: boolean;
      };

export type AudioResources = {
    /** browser-owned audio context, lazy-resumed on first play. */
    context: AudioContext;
    /** engine-global output bus every room's `masterGain` feeds; ramping it to 0 via
     *  `setOutputMuted` silences all rooms at once during platform ads. */
    outputGain: GainNode;
    /** last-applied output mute; lets `setOutputMuted` be called every frame while only
     *  ramping on a real change. */
    muted: boolean;
    clips: Map<string, ResolvedClip>;
    /** manifest hash the clips were built against; `refreshResources` compares against
     *  it to short-circuit a no-op HMR poke. */
    hash: string | null;
};

function makeResources(context: AudioContext, clips: Map<string, ResolvedClip>, hash: string | null): AudioResources {
    const outputGain = context.createGain();
    outputGain.gain.value = 1;
    outputGain.connect(context.destination);
    return { context, outputGain, muted: false, clips, hash };
}

/** ramps to avoid clicks, only on a real change. called every frame, reconciling
 *  against `state.ads.active`; platform-ad muting is built in, no game code involved. */
export function setOutputMuted(resources: AudioResources, muted: boolean): void {
    if (resources.muted === muted) return;
    resources.muted = muted;
    const g = resources.outputGain.gain;
    const now = resources.context.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(muted ? 0 : 1, now + 0.05);
}

/** returns null when there's no manifest (no sounds declared) or it's unreadable. */
async function fetchManifest(loader: ResourceLoader): Promise<AudioManifest | null> {
    try {
        const bytes = await loader.loadBytes('audio-manifest.json');
        return JSON.parse(new TextDecoder().decode(bytes)) as AudioManifest;
    } catch (err) {
        console.log('[audio] fetchManifest FAILED to load/parse audio-manifest.json:', err);
        return null;
    }
}

/** the atlas fetch + decode is kicked off in the background (not awaited), so boot isn't
 *  blocked on it; standalone clips stay lazy on first play. shared by `loadResources`
 *  (boot) and `refreshResources` (HMR). */
function buildClips(context: AudioContext, manifest: AudioManifest, loader: ResourceLoader): Map<string, ResolvedClip> {
    const clips = new Map<string, ResolvedClip>();

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

/** never rejects (caller `void`s it); a failure latches `failed` and silences every
 *  atlas sound, so it's surfaced loudly rather than as a per-play warning. */
async function loadAtlasInto(atlas: AtlasState, context: AudioContext, loader: ResourceLoader, count: number): Promise<void> {
    try {
        const raw = await loader.loadBytes('audio-atlas.webm');
        // decodeAudioData detaches its input ArrayBuffer; hand it a fresh standalone
        // copy since loadBytes may return a subarray view.
        atlas.buffer = await context.decodeAudioData(raw.slice().buffer);
    } catch (err) {
        atlas.failed = true;
        console.error(`[bongle] audio atlas failed to load, all ${count} atlas sounds will be silent:`, err);
    }
}

/** kicked off on first play (guarded by `clip.loading`); never rejects. */
async function loadStandaloneInto(clip: Extract<ResolvedClip, { kind: 'standalone' }>, context: AudioContext): Promise<void> {
    try {
        const bytes = await clip.loader.loadBytes(clip.url);
        clip.buffer = await context.decodeAudioData(bytes.slice().buffer);
    } catch (err) {
        clip.failed = true;
        console.warn('[bongle] failed to load standalone audio:', err);
    }
}

/** always returns a live `AudioResources`; when no manifest is present the clips map is
 *  empty and `play(unknownId, ...)` no-ops cleanly. */
export async function loadResources(loader: ResourceLoader): Promise<AudioResources> {
    const Ctx: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    const manifest = await fetchManifest(loader);
    if (!manifest) {
        return makeResources(new Ctx(), new Map(), null);
    }

    const context = new Ctx({ sampleRate: manifest.sampleRate });
    const clips = buildClips(context, manifest, loader);
    return makeResources(context, clips, manifest.hash);
}

/** wakes the AudioContext on the first user gesture and keeps it awake across iOS
 *  interruptions. `resume()` alone doesn't reliably unlock iOS/Safari; synchronously
 *  starting a one-sample silent BufferSource inside the gesture is the reliable unlock
 *  (the trick howler/tone use), so this does both. iOS also parks the context in a
 *  non-standard `'interrupted'` state on background/call/app-switch, hence the
 *  `!== 'running' && !== 'closed'` checks rather than naming that state.
 *
 *  call once per load; a no-op under SSR / node bake (no `window`). */
export function installGestureUnlock(resources: AudioResources): void {
    if (typeof window === 'undefined') return;
    const { context } = resources;

    // capture phase: a game-canvas/UI handler that stopPropagation()s must not
    // be able to starve the unlock.
    const listenerOpts = { capture: true, passive: true } as const;
    const events = ['pointerdown', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'] as const;
    const detach = () => {
        for (const type of events) window.removeEventListener(type, onGesture, true);
    };
    const onGesture = () => {
        if (context.state === 'running') return detach();
        // detach only once the buffer's `onended` fires, proof the graph really ran,
        // not just that resume()'s promise settled.
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

    // wakes already-playing loops on return to foreground without waiting for the next
    // play() call. lives for the context lifetime (engine-global), so no teardown.
    const onForeground = () => {
        if (document.visibilityState !== 'visible') return;
        if (context.state !== 'running' && context.state !== 'closed') void context.resume();
    };
    document.addEventListener('visibilitychange', onForeground);
    window.addEventListener('pageshow', onForeground);
}

/** rebuilds the clips map in place, so every room (sharing the same `resources` ref)
 *  picks up new buffers without a reboot. returns true when the manifest hash changed,
 *  false on a no-op. the AudioContext is reused; in-flight playbacks keep their
 *  already-started buffers and finish cleanly. */
export async function refreshResources(resources: AudioResources, loader: ResourceLoader): Promise<boolean> {
    const manifest = await fetchManifest(loader);
    if (!manifest) return false;
    if (resources.hash !== null && manifest.hash === resources.hash) return false;

    const clips = buildClips(resources.context, manifest, loader);
    // replaces the map's contents, not the reference: `resources.clips` is read on every
    // play and shared across rooms, so mutating in place propagates.
    resources.clips.clear();
    for (const [id, clip] of clips) resources.clips.set(id, clip);
    resources.hash = manifest.hash;
    return true;
}

export type PlaybackHandle = {
    /** `fade` (seconds) ramps gain to zero before stopping to avoid clicks; default 0
     *  (immediate). idempotent. */
    stop(opts?: { fade?: number }): void;
    /** linear gain in [0,1]. */
    setVolume(v: number): void;
    /** detune in cents, 100 = +1 semitone, -1200 = -1 octave. */
    setDetune(cents: number): void;
    readonly isPlaying: boolean;
};

/** lives in `Audio.active` until `_ended` or until its bound node is removed
 *  (`node.scene === null`), at which point updateForFrame stops + drops it. */
type ActivePlayback = {
    handle: PlaybackHandle;
    /** null until the source actually starts (immediately, or from `updateForFrame`
     *  for a parked play whose buffer wasn't ready). */
    source: AudioBufferSourceNode | null;
    gain: GainNode;
    panner: PannerNode | null;
    /** null for `playMono` / `playAt` calls. */
    node: Node | null;
    /** clip + opts to start once its buffer is ready; set when a play fires before its
     *  buffer is decoded. null once started. */
    _pendingStart: { clip: ResolvedClip; opts: PlayOpts } | null;
    /** stopped via .stop() or source ended naturally. drives reaping. */
    _ended: boolean;
    /** flipped by handle.stop() before the buffer resolves; `startSource` checks this
     *  and bails without creating a source. */
    _cancelled: boolean;
    /** setDetune called before a parked play's source was created; applied by
     *  `startSource` when it finally starts. */
    _pendingDetune?: number;
};

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

export type Audio = {
    resources: AudioResources;
    /** master gain for the room, all per-play gains hang off this. */
    masterGain: GainNode;
    /** in-flight one-shots, reaped per frame. */
    active: Set<ActivePlayback>;
    /** last listener pose written to the AudioContext.listener AudioParams, and the
     *  audio-context time of that write, used to skip redundant writes (per-frame
     *  AudioParam scheduling accumulates automation events the audio thread must walk).
     *  NaN sentinel forces the first write. */
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
    // feeds the engine-global output bus so `setOutputMuted` can silence every room at once.
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

/** positional play that follows a scene node; panner position refreshes every frame
 *  from the node's interpolated world transform. cancels automatically when the node
 *  is removed. */
export function playOnNode(audio: Audio, soundId: string, node: Node, opts: SpatialOpts = {}): PlaybackHandle | null {
    return startPlayback(audio, soundId, node, null, opts);
}

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

    // fire-and-forget resume; if not called from a gesture this no-ops silently and
    // the source plays when the context wakes (see installGestureUnlock). `!== running`
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
        panner.panningModel = 'equalpower'; // skip HRTF, basic stereo pan only
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
            // parked play (no source yet): `startSource` applies this when it starts.
            playback._pendingDetune = cents;
        },
    };
    playback.handle = handle;
    audio.active.add(playback);

    // starts now if the buffer's ready, drops if its load already failed, else parks:
    // kicks off the standalone's lazy load and lets updateForFrame start it when it lands.
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

/** the clip's decoded buffer, or null if not ready yet. */
function clipBuffer(clip: ResolvedClip): AudioBuffer | null {
    return clip.kind === 'atlas' ? clip.atlas.buffer : clip.buffer;
}

function clipFailed(clip: ResolvedClip): boolean {
    return clip.kind === 'atlas' ? clip.atlas.failed : clip.failed;
}

/** atlas clips play a bounded slice of the shared concat buffer (and loop within it);
 *  standalone clips play their whole file. a stop() before this bails via `_cancelled`. */
function startSource(ctx: AudioContext, clip: ResolvedClip, playback: ActivePlayback, opts: PlayOpts): void {
    if (playback._cancelled) return;
    const buffer = clipBuffer(clip);
    if (!buffer) return;

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = opts.loop ?? false;
    source.detune.value = playback._pendingDetune ?? opts.detune ?? 0;

    if (clip.kind === 'atlas') {
        // the atlas is a concat; constrain a loop to this clip's slice.
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
        // non-loop passes duration so the source stops at the slice end instead of
        // playing straight through into the next clip in the concat.
        if (source.loop) {
            source.start(0, clip.offset);
        } else {
            source.start(0, clip.offset, clip.duration);
        }
    } else {
        source.start();
    }
}

/** advances listener pose, starts parked plays whose buffer just landed, refreshes
 *  node-bound panner positions, reaps finished playbacks. called once per active room
 *  per frame from engine-client's update loop (after DomUi.update, before render). */
export function updateForFrame(audio: Audio, room: ClientRoom): void {
    updateListener(audio, room);

    for (const p of audio.active) {
        if (p._ended) {
            cleanup(audio, p);
            continue;
        }
        if (p.node && p.node.scene === null) {
            // node removed (possibly while parked): cancel + reap.
            try {
                p.source?.stop();
            } catch {
                /* */
            }
            cleanup(audio, p);
            continue;
        }
        // parked play: start it the frame its buffer lands, drop it if the load failed.
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

function updateListener(audio: Audio, room: ClientRoom): void {
    const listenerNode = resolveListenerNode(room);
    if (!listenerNode) return;
    const transform = SceneTree.getTrait(listenerNode, TransformTrait);
    if (!transform) return;

    const pos = getVisualWorldPosition(transform);
    const matrix = getVisualWorldMatrix(transform);
    // column-major mat4; forward = -Z basis, up = +Y basis, read straight off the
    // matrix to avoid a redundant quat decompose.
    const upX = matrix[4]!;
    const upY = matrix[5]!;
    const upZ = matrix[6]!;
    const fwdX = -matrix[8]!;
    const fwdY = -matrix[9]!;
    const fwdZ = -matrix[10]!;

    // a transiently-degenerate transform can yield non-finite values; WebAudio throws on
    // a non-finite AudioParam write and would kill the whole frame loop.
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
        // modern AudioParam interface (Chrome, Firefox): linearRampToValueAtTime for
        // smoother panning than setValueAtTime, scheduled to arrive ~one frame ahead.
        // skips unchanged params: each scheduled event queues on the param's automation
        // list, and per-frame writes across 9 params accumulate into 1k+ events/sec.
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
        // Safari legacy setters.
        const legacy = listener as unknown as {
            setPosition(x: number, y: number, z: number): void;
            setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
        };
        legacy.setPosition(pos[0], pos[1], pos[2]);
        legacy.setOrientation(fwdX, fwdY, fwdZ, upX, upY, upZ);
    }
}

function resolveListenerNode(room: ClientRoom): Node | null {
    for (const [trait] of SceneTree.query(room.scene, [AudioListenerTrait])) {
        if (trait.active) return trait._node!;
    }
    return room.client.subject;
}

function readNodePosition(node: Node): [number, number, number] | null {
    const transform = SceneTree.getTrait(node, TransformTrait);
    if (!transform) return null;
    const v = getVisualWorldPosition(transform);
    return [v[0], v[1], v[2]];
}

function setPannerPosition(panner: PannerNode, pos: readonly [number, number, number]): void {
    // guards against a non-finite source position (see updateListener); a bad write
    // throws and kills the frame loop.
    if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1]) || !Number.isFinite(pos[2])) return;
    if (panner.positionX) {
        const now = panner.context.currentTime;
        const endTime = now + 1 / 60;
        if (panner.positionX.value !== pos[0]) panner.positionX.linearRampToValueAtTime(pos[0], endTime);
        if (panner.positionY.value !== pos[1]) panner.positionY.linearRampToValueAtTime(pos[1], endTime);
        if (panner.positionZ.value !== pos[2]) panner.positionZ.linearRampToValueAtTime(pos[2], endTime);
    } else {
        // Safari legacy.
        (panner as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(pos[0], pos[1], pos[2]);
    }
}
