// ── debug ───────────────────────────────────────────────────────────
//
// engine debug primitives. owns two data types today:
//   - Profiler: a ring of per-frame span trees + the scalars recorded
//               alongside them (the instrumentation store)
//   - Logs:     ring buffer of structured log entries from scripts and
//               engine-internal console wraps
//
// both are pure collectors. nothing here knows about the dashboard, the
// widgets, or the wire — the client reads the ring to draw it, the server
// slices a room's subtree out of it to ship (see server/telemetry.ts).

// ── profiler ────────────────────────────────────────────────────────
//
// one storage: a ring of recorded frames. three write verbs, all targeting
// the frame in progress:
//   - frameStart()/frameEnd() — frame boundary (seals the frame into the ring)
//   - begin(key)/end(key?)    — a LIFO timing scope → a span
//   - record(key, value)      — a scalar the read side can't re-derive
//
// self-time and inclusive-time are NOT stored, they are reductions over a
// frame's spans, computed once on read and cached on the frame. charts read
// their whole history back out of this ring (no private samplers, so the
// x-axis is real frames) and the flame graph reads a whole retained frame.
//
// gated: while the debug panel is closed `enabled` is false, every write is
// an immediate return and the ring is released — it costs nothing, and holds
// no memory, in normal play.

/** hard caps for the preallocated span columns (overflow dropped, warned once). */
const MAX_SPANS = 8192;
const MAX_DEPTH = 64;
const MAX_COUNTERS = 512;
/** retained recent frames. 120 ≈ 2s at 60Hz, and the ring costs
 *  120 × 8192 × 11B ≈ 11 MB while the panel is open, 0 while it is closed. */
export const RING_FRAMES = 120;

/** one recorded frame: a span tree flattened in enter (preorder) order, plus
 *  the scalars recorded during it. a span's subtree is the contiguous run of
 *  following spans with a greater depth, which is what makes both the
 *  reduction below and the server's per-room slice a single linear pass. */
export type Frame = {
    /** monotonic frame counter, not the ring slot. */
    index: number;
    /** wall duration of the whole frame (ms). */
    duration: number;
    count: number;
    key: Uint16Array;
    depth: Uint8Array;
    /** ms from frame start. */
    start: Float32Array;
    end: Float32Array;
    counterCount: number;
    counterKey: Uint16Array;
    /** span index the counter was recorded inside, -1 for frame-global. lets a
     *  per-room counter ride along with its room's subtree. */
    counterSpan: Int16Array;
    counterValue: Float32Array;
    /** derived once, cached lazily (name → ms / value); cleared when the slot is reused. */
    selfByName: Record<string, number> | null;
    inclByName: Record<string, number> | null;
    countersByName: Record<string, number> | null;
};

export type Profiler = {
    /** when false every write is an immediate return and the ring is released. */
    enabled: boolean;
    /** when true the ring stops advancing, so a frame can be read/scrubbed in peace. */
    frozen: boolean;

    // key interning. per-profiler, NOT module-global: a mirror profiler holds
    // ids minted by the server that names its own table.
    keyToId: Map<string, number>;
    idToKey: string[];
    /** display unit per key id ('' when unset). sticky after the first record. */
    unitById: string[];

    // current-frame recording columns (preallocated, zero-alloc)
    curKey: Uint16Array;
    curDepth: Uint8Array;
    curStart: Float32Array;
    curEnd: Float32Array;
    curCount: number;
    curCounterKey: Uint16Array;
    curCounterSpan: Int16Array;
    curCounterValue: Float32Array;
    curCounterCount: number;
    openIdx: Int32Array;
    openLen: number;
    /** a frame is in progress (frameStart ran while enabled). */
    framing: boolean;
    frameStartMs: number;
    frameIndex: number;
    overflowWarned: boolean;

    // ring of retained frames (allocated on first use, released when disabled)
    ring: Frame[];
    ringHead: number;
    ringCount: number;

    // reduction scratch
    childDur: Float64Array;
    lastAtDepth: Int32Array;
};

const now = (): number => (typeof performance !== 'undefined' ? performance : Date).now();

export function createProfiler(enabled = true): Profiler {
    return {
        enabled,
        frozen: false,
        keyToId: new Map(),
        idToKey: [],
        unitById: [],
        curKey: new Uint16Array(MAX_SPANS),
        curDepth: new Uint8Array(MAX_SPANS),
        curStart: new Float32Array(MAX_SPANS),
        curEnd: new Float32Array(MAX_SPANS),
        curCount: 0,
        curCounterKey: new Uint16Array(MAX_COUNTERS),
        curCounterSpan: new Int16Array(MAX_COUNTERS),
        curCounterValue: new Float32Array(MAX_COUNTERS),
        curCounterCount: 0,
        openIdx: new Int32Array(MAX_DEPTH),
        openLen: 0,
        framing: false,
        frameStartMs: 0,
        frameIndex: 0,
        overflowWarned: false,
        ring: [],
        ringHead: 0,
        ringCount: 0,
        childDur: new Float64Array(MAX_SPANS),
        lastAtDepth: new Int32Array(MAX_DEPTH),
    };
}

function allocFrame(): Frame {
    return {
        index: -1,
        duration: 0,
        count: 0,
        key: new Uint16Array(MAX_SPANS),
        depth: new Uint8Array(MAX_SPANS),
        start: new Float32Array(MAX_SPANS),
        end: new Float32Array(MAX_SPANS),
        counterCount: 0,
        counterKey: new Uint16Array(MAX_COUNTERS),
        counterSpan: new Int16Array(MAX_COUNTERS),
        counterValue: new Float32Array(MAX_COUNTERS),
        selfByName: null,
        inclByName: null,
        countersByName: null,
    };
}

function ensureRing(profiler: Profiler): void {
    if (profiler.ring.length > 0) return;
    for (let i = 0; i < RING_FRAMES; i++) profiler.ring.push(allocFrame());
}

/** enable/disable recording. disabling releases the ring — a closed panel holds
 *  no frames, and reopening starts from an empty history rather than a stale one. */
export function setEnabled(profiler: Profiler, enabled: boolean): void {
    if (profiler.enabled === enabled) return;
    profiler.enabled = enabled;
    if (!enabled) {
        profiler.ring = [];
        profiler.ringHead = 0;
        profiler.ringCount = 0;
        profiler.curCount = 0;
        profiler.curCounterCount = 0;
        profiler.openLen = 0;
        profiler.framing = false;
        profiler.frozen = false;
    }
}

export function intern(profiler: Profiler, key: string): number {
    let id = profiler.keyToId.get(key);
    if (id === undefined) {
        id = profiler.idToKey.length;
        profiler.idToKey.push(key);
        profiler.unitById.push('');
        profiler.keyToId.set(key, id);
    }
    return id;
}

// ── write api ───────────────────────────────────────────────────────

export function frameStart(profiler: Profiler): void {
    if (!profiler.enabled) return;
    profiler.curCount = 0;
    profiler.curCounterCount = 0;
    profiler.openLen = 0;
    profiler.overflowWarned = false;
    profiler.framing = true;
    profiler.frameStartMs = now();
}

/** open a timing scope. scopes are LIFO: the next `end` closes this one. */
export function begin(profiler: Profiler, key: string): void {
    if (!profiler.framing) return;
    const i = profiler.curCount;
    if (i >= MAX_SPANS || profiler.openLen >= MAX_DEPTH) {
        if (!profiler.overflowWarned) {
            console.warn('[bongle] debug: frame span/depth overflow, dropping spans');
            profiler.overflowWarned = true;
        }
        return;
    }
    const t = now() - profiler.frameStartMs;
    profiler.curCount = i + 1;
    profiler.curKey[i] = intern(profiler, key);
    profiler.curDepth[i] = profiler.openLen;
    profiler.curStart[i] = t;
    profiler.curEnd[i] = t; // provisional, a scope left open reads as 0-duration
    profiler.openIdx[profiler.openLen] = i;
    profiler.openLen++;
}

/** close the innermost open scope and return its duration in ms. `key` is
 *  optional, when given it asserts the LIFO top matches (a cheap dev guard). */
export function end(profiler: Profiler, key?: string): number {
    if (!profiler.framing || profiler.openLen === 0) return 0;
    profiler.openLen--;
    const i = profiler.openIdx[profiler.openLen]!;
    const t = now() - profiler.frameStartMs;
    profiler.curEnd[i] = t;
    if (key !== undefined && profiler.curKey[i] !== profiler.keyToId.get(key)) {
        console.warn(`[bongle] debug: end('${key}') did not match the open scope`);
    }
    return t - profiler.curStart[i]!;
}

/** record a scalar into the frame in progress: a counter the read side can't
 *  re-derive (bodies stepped, bytes uploaded, kb/s). it is attributed to the
 *  innermost open scope, so a per-room counter rides with its room's subtree.
 *  `unit` labels it for display and sticks after the first record. */
export function record(profiler: Profiler, key: string, value: number, unit?: string): void {
    if (!profiler.framing) return;
    const id = intern(profiler, key);
    if (unit !== undefined) profiler.unitById[id] = unit;
    const i = profiler.curCounterCount;
    if (i >= MAX_COUNTERS) {
        if (!profiler.overflowWarned) {
            console.warn('[bongle] debug: frame counter overflow, dropping records');
            profiler.overflowWarned = true;
        }
        return;
    }
    profiler.curCounterCount = i + 1;
    profiler.curCounterKey[i] = id;
    profiler.curCounterSpan[i] = profiler.openLen > 0 ? profiler.openIdx[profiler.openLen - 1]! : -1;
    profiler.curCounterValue[i] = value;
}

/** seal the frame in progress into the ring. a frozen profiler keeps recording
 *  (so `end` still measures) but stops advancing, holding the history still. */
export function frameEnd(profiler: Profiler): void {
    if (!profiler.framing) return;
    profiler.framing = false;
    if (profiler.frozen) return;
    ensureRing(profiler);
    const frame = profiler.ring[profiler.ringHead]!;
    const spans = profiler.curCount;
    const counters = profiler.curCounterCount;
    frame.index = profiler.frameIndex++;
    frame.duration = now() - profiler.frameStartMs;
    frame.count = spans;
    frame.key.set(profiler.curKey.subarray(0, spans));
    frame.depth.set(profiler.curDepth.subarray(0, spans));
    frame.start.set(profiler.curStart.subarray(0, spans));
    frame.end.set(profiler.curEnd.subarray(0, spans));
    frame.counterCount = counters;
    frame.counterKey.set(profiler.curCounterKey.subarray(0, counters));
    frame.counterSpan.set(profiler.curCounterSpan.subarray(0, counters));
    frame.counterValue.set(profiler.curCounterValue.subarray(0, counters));
    frame.selfByName = null; // invalidate the reused slot's caches
    frame.inclByName = null;
    frame.countersByName = null;
    profiler.ringHead = (profiler.ringHead + 1) % RING_FRAMES;
    if (profiler.ringCount < RING_FRAMES) profiler.ringCount++;
}

/** push a frame recorded elsewhere (a server frame off the wire) into the ring.
 *  the columns are copied, so the caller keeps ownership of its buffers. */
export function pushFrame(
    profiler: Profiler,
    source: {
        duration: number;
        count: number;
        key: ArrayLike<number>;
        depth: ArrayLike<number>;
        start: ArrayLike<number>;
        end: ArrayLike<number>;
        counterCount: number;
        counterKey: ArrayLike<number>;
        counterValue: ArrayLike<number>;
    },
): void {
    if (!profiler.enabled || profiler.frozen) return;
    ensureRing(profiler);
    const frame = profiler.ring[profiler.ringHead]!;
    const spans = Math.min(source.count, MAX_SPANS);
    const counters = Math.min(source.counterCount, MAX_COUNTERS);
    frame.index = profiler.frameIndex++;
    frame.duration = source.duration;
    frame.count = spans;
    for (let i = 0; i < spans; i++) {
        frame.key[i] = source.key[i]!;
        frame.depth[i] = source.depth[i]!;
        frame.start[i] = source.start[i]!;
        frame.end[i] = source.end[i]!;
    }
    frame.counterCount = counters;
    for (let i = 0; i < counters; i++) {
        frame.counterKey[i] = source.counterKey[i]!;
        frame.counterSpan[i] = -1;
        frame.counterValue[i] = source.counterValue[i]!;
    }
    frame.selfByName = null;
    frame.inclByName = null;
    frame.countersByName = null;
    profiler.ringHead = (profiler.ringHead + 1) % RING_FRAMES;
    if (profiler.ringCount < RING_FRAMES) profiler.ringCount++;
}

// ── read api ────────────────────────────────────────────────────────

const EMPTY: Readonly<Record<string, number>> = Object.freeze({});

export function keyName(profiler: Profiler, id: number): string {
    return profiler.idToKey[id] ?? '?';
}

export function frameCount(profiler: Profiler): number {
    return profiler.ringCount;
}

/** a retained frame by age: 0 = newest. null when out of range. */
export function getFrame(profiler: Profiler, offset = 0): Frame | null {
    if (offset < 0 || offset >= profiler.ringCount) return null;
    const slot = (profiler.ringHead - 1 - offset + RING_FRAMES * 2) % RING_FRAMES;
    return profiler.ring[slot] ?? null;
}

/** total duration of a retained frame (ms). */
export function frameMs(profiler: Profiler, offset = 0): number {
    return getFrame(profiler, offset)?.duration ?? 0;
}

/** self-time per scope name for a frame: nested scopes subtracted. */
export function self(profiler: Profiler, offset = 0): Readonly<Record<string, number>> {
    const frame = getFrame(profiler, offset);
    if (!frame) return EMPTY;
    if (!frame.selfByName) reduce(profiler, frame);
    return frame.selfByName ?? EMPTY;
}

/** inclusive time per scope name for a frame: nested scopes included. repeated
 *  scopes (the same phase entered once per room, or per fixed step) sum. */
export function inclusive(profiler: Profiler, offset = 0): Readonly<Record<string, number>> {
    const frame = getFrame(profiler, offset);
    if (!frame) return EMPTY;
    if (!frame.inclByName) reduce(profiler, frame);
    return frame.inclByName ?? EMPTY;
}

/** the scalars recorded during a frame, by name. last write wins. reduced once
 *  and cached on the frame, so a chart reading a whole ring of history is a map
 *  lookup per frame rather than a scan of the frame's counters per key. */
export function counters(profiler: Profiler, offset = 0): Readonly<Record<string, number>> {
    const frame = getFrame(profiler, offset);
    if (!frame) return EMPTY;
    if (!frame.countersByName) {
        const byName: Record<string, number> = {};
        for (let i = 0; i < frame.counterCount; i++) byName[keyName(profiler, frame.counterKey[i]!)] = frame.counterValue[i]!;
        frame.countersByName = byName;
    }
    return frame.countersByName;
}

/** a scalar recorded during a frame (0 when absent). */
export function counter(profiler: Profiler, key: string, offset = 0): number {
    return counters(profiler, offset)[key] ?? 0;
}

/** names of the scalars recorded during a frame. dynamic sets (per-message-type
 *  net rates) are discovered through this rather than hardcoded. */
export function counterNames(profiler: Profiler, offset = 0): string[] {
    return Object.keys(counters(profiler, offset));
}

/** display unit for a key ('' when never labelled). */
export function unitOf(profiler: Profiler, key: string): string {
    const id = profiler.keyToId.get(key);
    return id === undefined ? '' : (profiler.unitById[id] ?? '');
}

/**
 * names of the scopes directly inside `parent` in a frame, first-seen order.
 * `parent` null reads the frame's top level. this is how the charts discover
 * their phase lists — the stack of a loop's phases follows the loop rather
 * than a hardcoded list going stale next to it.
 */
export function childNames(profiler: Profiler, parent: string | null, offset = 0): string[] {
    const frame = getFrame(profiler, offset);
    if (!frame) return [];
    const parentId = parent === null ? -1 : (profiler.keyToId.get(parent) ?? -2);
    if (parentId === -2) return [];
    const out: string[] = [];
    const seen = new Set<number>();
    // depth of the level we are collecting: top level is 0, otherwise one
    // deeper than each occurrence of the parent (a scope can repeat per room).
    let wanted = parent === null ? 0 : -1;
    for (let i = 0; i < frame.count; i++) {
        const depth = frame.depth[i]!;
        if (parentId >= 0) {
            if (frame.key[i] === parentId) {
                wanted = depth + 1;
                continue;
            }
            if (wanted < 0 || depth < wanted) continue; // outside any parent occurrence
        }
        if (depth !== wanted) continue;
        const id = frame.key[i]!;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(keyName(profiler, id));
    }
    return out;
}

// ── slicing ─────────────────────────────────────────────────────────
//
// a span's subtree is the contiguous run of following spans deeper than it, so
// dropping a whole subtree is one linear pass that leaves preorder and depths
// intact. the server ships a frame this way: other rooms' subtrees dropped (a
// client sees only the room it is in) and sub-`minMs` subtrees dropped (noise
// the flame could not draw anyway, and the bulk of the bytes).

export type FrameSlice = {
    duration: number;
    count: number;
    key: Uint16Array;
    depth: Uint8Array;
    start: Float32Array;
    end: Float32Array;
    counterCount: number;
    counterKey: Uint16Array;
    counterValue: Float32Array;
};

export function createFrameSlice(): FrameSlice {
    return {
        duration: 0,
        count: 0,
        key: new Uint16Array(MAX_SPANS),
        depth: new Uint8Array(MAX_SPANS),
        start: new Float32Array(MAX_SPANS),
        end: new Float32Array(MAX_SPANS),
        counterCount: 0,
        counterKey: new Uint16Array(MAX_COUNTERS),
        counterValue: new Float32Array(MAX_COUNTERS),
    };
}

/** per-span slice marker: 0 = another room's, 1 = kept, 2 = too short to ship.
 *  the two drop reasons differ for counters — a counter recorded inside a
 *  0.01ms scope is still the number the panel wants, another room's is not. */
const SLICE_ALIEN = 0;
const SLICE_KEPT = 1;
const SLICE_TINY = 2;
const sliceMark = new Uint8Array(MAX_SPANS);

/** copy `frame` into `out`, dropping the subtrees rooted at `dropKeys` and any
 *  subtree shorter than `minMs`. */
export function sliceFrame(frame: Frame, dropKeys: ReadonlySet<number>, minMs: number, out: FrameSlice): void {
    out.duration = frame.duration;
    let count = 0;
    let skipDepth = -1;
    let skipMark = SLICE_KEPT;
    for (let i = 0; i < frame.count; i++) {
        const depth = frame.depth[i]!;
        if (skipDepth >= 0) {
            if (depth > skipDepth) {
                sliceMark[i] = skipMark;
                continue;
            }
            skipDepth = -1;
        }
        const alien = dropKeys.has(frame.key[i]!);
        if (alien || frame.end[i]! - frame.start[i]! < minMs) {
            skipDepth = depth;
            skipMark = alien ? SLICE_ALIEN : SLICE_TINY;
            sliceMark[i] = skipMark;
            continue;
        }
        sliceMark[i] = SLICE_KEPT;
        out.key[count] = frame.key[i]!;
        out.depth[count] = depth;
        out.start[count] = frame.start[i]!;
        out.end[count] = frame.end[i]!;
        count++;
    }
    out.count = count;

    let counters = 0;
    for (let i = 0; i < frame.counterCount; i++) {
        const span = frame.counterSpan[i]!;
        if (span >= 0 && sliceMark[span] === SLICE_ALIEN) continue;
        out.counterKey[counters] = frame.counterKey[i]!;
        out.counterValue[counters] = frame.counterValue[i]!;
        counters++;
    }
    out.counterCount = counters;
}

/** compute + cache both self and inclusive per name for a frame, in one pass. */
function reduce(profiler: Profiler, frame: Frame): void {
    const selfByName: Record<string, number> = {};
    const inclByName: Record<string, number> = {};
    const n = frame.count;
    profiler.lastAtDepth.fill(-1);
    for (let i = 0; i < n; i++) profiler.childDur[i] = 0;
    // a span's parent (preorder) is the last span one level shallower.
    for (let i = 0; i < n; i++) {
        const depth = frame.depth[i]!;
        const duration = frame.end[i]! - frame.start[i]!;
        if (depth > 0) {
            const parent = profiler.lastAtDepth[depth - 1]!;
            if (parent >= 0) profiler.childDur[parent] += duration;
        }
        profiler.lastAtDepth[depth] = i;
    }
    for (let i = 0; i < n; i++) {
        const name = keyName(profiler, frame.key[i]!);
        const duration = frame.end[i]! - frame.start[i]!;
        const selfTime = duration - profiler.childDur[i]!;
        inclByName[name] = (inclByName[name] ?? 0) + duration;
        selfByName[name] = (selfByName[name] ?? 0) + (selfTime > 0 ? selfTime : 0);
    }
    frame.selfByName = selfByName;
    frame.inclByName = inclByName;
}

// ── logs ────────────────────────────────────────────────────────────

export type LogLevel = 'log' | 'warn' | 'error';

/**
 * source attribution for logs coming from script code. omitted for
 * engine-internal logs captured via console wraps (those are 'global').
 */
export type LogSource = {
    traitId: string;
    nodeId: number;
    nodeName: string | undefined;
    mode: 'edit' | 'play';
    side: 'client' | 'server';
};

export type LogEntry = {
    ts: number;
    level: LogLevel;
    msg: string;
    source: LogSource | undefined;
};

const LOG_DEFAULT_CAP = 2000;

export type Logs = {
    /** entries in arrival order. capped at `cap`, oldest dropped on overflow. */
    entries: LogEntry[];
    /** monotonic count of entries ever pushed. lets subscribers track a delta cursor across drops. */
    pushed: number;
    cap: number;
};

export function createLogs(cap = LOG_DEFAULT_CAP): Logs {
    return { entries: [], pushed: 0, cap };
}

export function pushLog(logs: Logs, entry: LogEntry): void {
    logs.entries.push(entry);
    logs.pushed++;
    if (logs.entries.length > logs.cap) logs.entries.shift();
}

/**
 * read entries pushed after `cursor`. returns the entries and a fresh
 * cursor to pass next call. if `cursor < pushed - entries.length`,
 * caller missed entries that fell off the buffer, `dropped` indicates
 * how many. caller can show a "… N entries dropped" marker.
 */
export function readDelta(
    logs: Logs,
    cursor: number,
): {
    entries: LogEntry[];
    cursor: number;
    dropped: number;
} {
    const oldest = logs.pushed - logs.entries.length;
    if (cursor >= logs.pushed) return { entries: [], cursor: logs.pushed, dropped: 0 };

    const dropped = Math.max(0, oldest - cursor);
    const startIdx = Math.max(0, cursor - oldest);
    return {
        entries: logs.entries.slice(startIdx),
        cursor: logs.pushed,
        dropped,
    };
}
