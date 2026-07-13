/**
 * voxel pathfinding, standalone, functional A* over the voxel grid.
 *
 * adapted from the sketch at sketches/voxels/graph-search-pathfinding
 * (A* + swept-box shortcut smoothing), bound to the engine's `Voxels` and
 * block-flag system. pure functions + types, no traits, no systems.
 *
 * everything operates in INTEGER VOXEL SPACE. callers convert world↔voxel at
 * the boundary (floor a world position to its cell; a cell's feet-centre is
 * `[x + 0.5, y, z + 0.5]`). pathfinding produces a list of cells; following
 * those waypoints (steering a character) is a separate concern.
 *
 * the movement model is pluggable via `actions`, a successor function that
 * expands a cell into its reachable neighbours. it owns both the candidate move
 * set and the walkability test, so the same A* drives land / fly / swim (and
 * context-dependent movement like ladders) by swapping the model. `gridActions`
 * builds the common fixed-offset case from a `Move[]` + a `Walkable`.
 */

import type { Vec3 } from 'mathcat';
import { BLOCK_FLAG_COLLISION, BLOCK_FLAG_PATHFINDABLE } from './voxels/block-registry';
import { getBlockState, type Voxels } from './voxels/voxels';

// ── voxel reads (block-flag based) ──────────────────────────────────

function flagsAt(voxels: Voxels, x: number, y: number, z: number): number {
    return voxels.registry.flags[getBlockState(voxels, x, y, z)]!;
}

/** may a navigating agent occupy this single cell? (BLOCK_FLAG_PATHFINDABLE) */
function isPassable(voxels: Voxels, x: number, y: number, z: number): boolean {
    return (flagsAt(voxels, x, y, z) & BLOCK_FLAG_PATHFINDABLE) !== 0;
}

/** is this cell solid enough to stand on / support an agent above it?
 *  (BLOCK_FLAG_COLLISION) */
function isSupport(voxels: Voxels, x: number, y: number, z: number): boolean {
    return (flagsAt(voxels, x, y, z) & BLOCK_FLAG_COLLISION) !== 0;
}

// ── walkability (footprint = cell + size, all in cells) ─────────────

/** every cell of the `size` box with min corner `(x, y, z)` is passable. */
function isClear(voxels: Voxels, x: number, y: number, z: number, size: Vec3): boolean {
    for (let dy = 0; dy < size[1]; dy++) {
        for (let dx = 0; dx < size[0]; dx++) {
            for (let dz = 0; dz < size[2]; dz++) {
                if (!isPassable(voxels, x + dx, y + dy, z + dz)) return false;
            }
        }
    }
    return true;
}

/** land-standing: the `size` box is clear AND every column beneath its
 *  footprint is supported (solid directly below the feet). `(x, y, z)` is the
 *  feet/min corner; the default caller passes a 2-high box. */
function isWalkable(voxels: Voxels, x: number, y: number, z: number, size: Vec3): boolean {
    for (let dx = 0; dx < size[0]; dx++) {
        for (let dz = 0; dz < size[2]; dz++) {
            if (!isSupport(voxels, x + dx, y - 1, z + dz)) return false;
        }
    }
    return isClear(voxels, x, y, z, size);
}

/** strategy: can the agent stand/be at this cell? scalar args so the A* inner
 *  loop allocates nothing. slot a different impl in for fly / swim / wall. */
export type Walkable = (voxels: Voxels, x: number, y: number, z: number) => boolean;

/** ground agent, needs solid support below. default body is 1×2×1 (2 blocks high).
 *  feed it to `gridActions`/`groundShortcut`, or wrap it, for "only walk on X" rules. */
export function groundWalkable(size: Vec3 = [1, 2, 1]): Walkable {
    return (voxels, x, y, z) => isWalkable(voxels, x, y, z, size);
}

// ── movement model (the slot-in "actions") ─────────────────────────

/** one candidate offset for the fixed-move case, input to `gridActions`. */
export type Move = { offset: Vec3; cost: number };

/** the sink a successor calls once per reachable neighbour cell, its coords plus
 *  the move cost. the search supplies it, so a successor never builds a list. */
export type StepFn = (x: number, y: number, z: number, cost: number) => void;

/** the pluggable successor function `findPath`/`floodFill` search over: expand a
 *  cell by calling `step(nx, ny, nz, cost)` for each reachable neighbour. the
 *  candidate moves AND per-cell walkability both live here, so movement can be
 *  context-dependent (ladders, liquids, variable cost). emitting rather than
 *  returning a list means a hot search allocates nothing per expansion. */
export type Actions = (voxels: Voxels, x: number, y: number, z: number, step: StepFn) => void;

/** admissible-ish distance estimate between two cells. */
export type Heuristic = (fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number) => number;

/** line-of-sight test used by `smoothPath`: can the agent travel `from`→`to`
 *  directly (skipping intermediate waypoints)? */
export type Shortcut = (voxels: Voxels, from: Vec3, to: Vec3) => boolean;

/** build an `Actions` from a fixed candidate offset set + a walkability test, the
 *  composer for the common (fixed-offset) case. each offset landing on a walkable
 *  cell becomes a reachable step. compose `groundMoves`/`groundWalkable` here, or
 *  swap in your own moves/walkability, for custom movement. */
export function gridActions(moves: readonly Move[], walkable: Walkable): Actions {
    return (voxels, x, y, z, step) => {
        for (const move of moves) {
            const nx = x + move.offset[0];
            const ny = y + move.offset[1];
            const nz = z + move.offset[2];
            if (walkable(voxels, nx, ny, nz)) step(nx, ny, nz, move.cost);
        }
    };
}

/** euclidean distance, fast, slightly non-admissible with unit-cost diagonals
 *  (favours speed over strict optimality, matching the source sketch). */
const euclidean: Heuristic = (fromX, fromY, fromZ, toX, toY, toZ) => Math.hypot(fromX - toX, fromY - toY, fromZ - toZ);

// 12 ground moves: 4 cardinals × {flat, step-up +1, step-down −1}. unit cost.
const GROUND_OFFSETS: Vec3[] = [
    [-1, 0, 0],
    [-1, 1, 0],
    [-1, -1, 0],
    [1, 0, 0],
    [1, 1, 0],
    [1, -1, 0],
    [0, 0, -1],
    [0, 1, -1],
    [0, -1, -1],
    [0, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
];

/** the default ground move set, spread + extend it (e.g. add gap-jumps) and feed
 *  `gridActions` for a custom successor. */
export const groundMoves: readonly Move[] = GROUND_OFFSETS.map((offset) => ({ offset, cost: 1 }));

/** the ready-made ground successor (default 1×2×1 agent). pass it straight to
 *  `findPath`/`floodFill`; wrap it `(v,x,y,z) => groundActions(v,x,y,z).filter(...)`
 *  to add/restrict steps, or rebuild via `gridActions(groundMoves, groundWalkable(...))`
 *  for a different agent. */
export const groundActions: Actions = gridActions(groundMoves, groundWalkable());

/** the four directions an agent can step off a ledge into. */
const CARDINAL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
];

/** ground successor that ALSO lets the agent walk off a ledge and drop straight down to
 *  the first landing below, to any depth up to `maxDrop`. the fixed ground moves (flat,
 *  ±1 step) come from the standard ground actions; this adds, per cardinal, the one cell
 *  the agent falls to after stepping off the edge. the fall column must stay clear the
 *  whole way (no overhang clips the 2-high body) and the landing needs solid support
 *  below. `maxDrop` MUST be finite: out-of-world reads are air, so a void column has no
 *  floor and the scan would never terminate, the cap doubles as the "don't path off into
 *  the abyss" guard. `dropCost` is the extra cost per block fallen on top of the unit move
 *  (keep it small so drops are taken when they shortcut, but stairs win when costs tie). */
export function groundDropActions(opts?: { size?: Vec3; maxDrop?: number; dropCost?: number }): Actions {
    const size = opts?.size ?? [1, 2, 1];
    const maxDrop = opts?.maxDrop ?? 64;
    const dropCost = opts?.dropCost ?? 0.2;
    const base = gridActions(groundMoves, groundWalkable(size));
    return (voxels, x, y, z, step) => {
        base(voxels, x, y, z, step); // flat + ±1-step neighbours
        for (const [dx, dz] of CARDINAL_OFFSETS) {
            const nx = x + dx;
            const nz = z + dz;
            // step off the edge only if the body fits in the neighbour column at our level.
            if (!isClear(voxels, nx, y, nz, size)) continue;
            // descend the column for the first floor below; the body must stay clear the whole way.
            for (let ly = y - 1; y - ly <= maxDrop; ly--) {
                if (!isClear(voxels, nx, ly, nz, size)) break; // overhang / wall → can't fall through
                if (isSupport(voxels, nx, ly - 1, nz)) {
                    // floor beneath this clear cell → a landing. ly === y-1 is the −1 step the
                    // base actions already emit, so only add genuine drops (two or more down).
                    if (ly < y - 1) step(nx, ly, nz, 1 + (y - ly) * dropCost);
                    break;
                }
            }
        }
    };
}

// ── A* ──────────────────────────────────────────────────────────────

type Node = {
    x: number;
    y: number;
    z: number;
    parent: Node | null;
    g: number;
    f: number;
};

// node pool, search() would otherwise allocate one Node per heap push (up to
// ~maxIterations expansions plus their neighbours), the dominant per-search garbage.
// a bump allocator: requestNode hands out the next pool slot (reused in place, grown on
// demand) and releaseSearchNodes returns the whole batch with a single index reset, no
// per-node bookkeeping or array churn. none can be released mid-search, since any may
// still sit on the final parent chain reconstruct() walks, so release is batch-only at
// the next search start. steady-state searches allocate zero Node objects. NOT
// re-entrancy safe, search() never calls search().
const nodePool: Node[] = [];
let nodePoolIndex = 0; // count of slots handed out to the current search
function requestNode(x: number, y: number, z: number, parent: Node | null, g: number, f: number): Node {
    let node = nodePool[nodePoolIndex];
    if (node === undefined) {
        node = { x, y, z, parent, g, f };
        nodePool[nodePoolIndex] = node;
    } else {
        node.x = x;
        node.y = y;
        node.z = z;
        node.parent = parent;
        node.g = g;
        node.f = f;
    }
    nodePoolIndex++;
    return node;
}
// release the whole batch the just-finished search requested, an O(1) reset; slots stay
// in nodePool and are reused in place by the next search's requestNode calls.
function releaseSearchNodes(): void {
    nodePoolIndex = 0;
}

// min-heap of nodes keyed by f, as a plain array mutated only through `heapPush` /
// `heapPop`, so the heap invariant always holds. read `.length` for the size.
type NodeHeap = Node[];

function heapPush(heap: NodeHeap, node: Node): void {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
        const parent = (i - 1) >> 1;
        if (heap[parent]!.f <= heap[i]!.f) break;
        [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
        i = parent;
    }
}

function heapPop(heap: NodeHeap): Node {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
        heap[0] = last;
        let i = 0;
        const n = heap.length;
        for (;;) {
            const left = 2 * i + 1;
            const right = 2 * i + 2;
            let smallest = i;
            if (left < n && heap[left]!.f < heap[smallest]!.f) smallest = left;
            if (right < n && heap[right]!.f < heap[smallest]!.f) smallest = right;
            if (smallest === i) break;
            [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
            i = smallest;
        }
    }
    return top;
}

// ── visited table (gScore + closed), reused across searches ─────────
// open-addressing map (x,y,z) → a slot holding the cell's best gScore and closed
// flag. replaces the string-keyed Map/Set: no per-cell string, and a generation
// stamp resets it in O(1) between searches (no array clearing). it grows +
// rehashes when one search's live set passes the load factor, so there's NO
// world-size, search-extent, or cell-count cap, only available memory bounds it.
// NOT re-entrancy safe; like the node pool, search()/floodFill() never nest.
let htCap = 1 << 12;
let htMask = htCap - 1;
let htKeyX = new Int32Array(htCap);
let htKeyY = new Int32Array(htCap);
let htKeyZ = new Int32Array(htCap);
let htG = new Float64Array(htCap);
let htClosed = new Uint8Array(htCap);
let htGen = new Int32Array(htCap); // 0 = never claimed; a slot is live iff === generation
let generation = 0; // bumped per search
let htCount = 0; // live slots this generation (drives the grow decision)
/** set by htSlot: true when the returned slot was freshly claimed this search. */
let htInserted = false;
const HT_MAX_LOAD = 0.7;

function htReset(): void {
    htCount = 0;
    generation++;
    // generation is an Int32 stamp; on the (astronomically rare) wrap, clear the
    // stamps so no stale slot can alias the reused value.
    if (generation === 0x7fffffff) {
        htGen.fill(0);
        generation = 1;
    }
}

// Teschner et al. spatial hash. `^`/`*` coerce through int32, fine for a hash
// (we only need spread + determinism) and it handles negative coords.
function hashCoord(x: number, y: number, z: number): number {
    const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    return (h >>> 0) & htMask;
}

// return (x,y,z)'s slot, claiming a fresh one (g=Infinity, open) on first touch
// this search. sets `htInserted` so callers can tell new from existing.
function htSlot(x: number, y: number, z: number): number {
    if (htCount >= htCap * HT_MAX_LOAD) htGrow();
    let i = hashCoord(x, y, z);
    for (;;) {
        if (htGen[i] !== generation) {
            htGen[i] = generation;
            htKeyX[i] = x;
            htKeyY[i] = y;
            htKeyZ[i] = z;
            htG[i] = Infinity;
            htClosed[i] = 0;
            htCount++;
            htInserted = true;
            return i;
        }
        if (htKeyX[i] === x && htKeyY[i] === y && htKeyZ[i] === z) {
            htInserted = false;
            return i;
        }
        i = (i + 1) & htMask;
    }
}

// double capacity and re-insert this search's live slots. one-off (the bigger
// arrays persist), so warmed-up searches never hit it.
function htGrow(): void {
    const oldCap = htCap;
    const oldKeyX = htKeyX;
    const oldKeyY = htKeyY;
    const oldKeyZ = htKeyZ;
    const oldG = htG;
    const oldClosed = htClosed;
    const oldGen = htGen;

    htCap = oldCap << 1;
    htMask = htCap - 1;
    htKeyX = new Int32Array(htCap);
    htKeyY = new Int32Array(htCap);
    htKeyZ = new Int32Array(htCap);
    htG = new Float64Array(htCap);
    htClosed = new Uint8Array(htCap);
    htGen = new Int32Array(htCap);

    for (let s = 0; s < oldCap; s++) {
        if (oldGen[s] !== generation) continue;
        let i = hashCoord(oldKeyX[s]!, oldKeyY[s]!, oldKeyZ[s]!);
        while (htGen[i] === generation) i = (i + 1) & htMask;
        htGen[i] = generation;
        htKeyX[i] = oldKeyX[s]!;
        htKeyY[i] = oldKeyY[s]!;
        htKeyZ[i] = oldKeyZ[s]!;
        htG[i] = oldG[s]!;
        htClosed[i] = oldClosed[s]!;
    }
}

// ── A* search state (module scratch; search() is non-re-entrant) ────
// hoisting these lets `relax` be one shared StepFn, zero closure/array
// allocation per expansion. all set fresh at the top of each search().
const sOpen: NodeHeap = [];
let sGoalX = 0;
let sGoalY = 0;
let sGoalZ = 0;
let sGreedy = false;
let sHeuristic: Heuristic = euclidean;
let sCurrent: Node | null = null;

// the successor sink handed to `actions`: relax one neighbour against the open
// set, reading the cell being expanded + goal/heuristic from the search state.
const relax: StepFn = (nx, ny, nz, cost) => {
    const slot = htSlot(nx, ny, nz);
    if (htClosed[slot] === 1) return;
    const g = sCurrent!.g + cost;
    if (g >= htG[slot]!) return; // htG seeds Infinity, so a first touch always wins
    htG[slot] = g;
    const h = sHeuristic(nx, ny, nz, sGoalX, sGoalY, sGoalZ);
    heapPush(sOpen, requestNode(nx, ny, nz, sCurrent, g, sGreedy ? h : g + h));
};

/** how the frontier is scored. 'shortest' = classic A* (g + h); 'greedy' =
 *  best-first (h only), faster, not optimal. */
export type SearchType = 'shortest' | 'greedy';

export type FindPathOptions = {
    /** cap on A* iterations (nodes expanded); returns null once exceeded. the
     *  guard against an unreachable/disconnected goal blowing up the search. */
    maxIterations?: number;
    /** frontier scoring. default 'shortest'. */
    searchType?: SearchType;
    /** distance estimate for A* (default euclidean). */
    heuristic?: Heuristic;
};

/**
 * find a path of cells from `start` to `goal` under the successor function
 * `actions`, or null. returns every cell, never smoothed (smooth explicitly with
 * `smoothPath` if you want steering waypoints). pass `actions` directly (e.g.
 * `groundActions`), wrap one, or build via `gridActions`. heuristic defaults to
 * euclidean (override via `options.heuristic`).
 *
 * uses lazy deletion: a cheaper route to an open cell pushes a fresh node and
 * stale duplicates are skipped on pop (closed check), correct without
 * decrease-key bookkeeping.
 */
export function findPath(voxels: Voxels, start: Vec3, goal: Vec3, actions: Actions, options?: FindPathOptions): Vec3[] | null {
    const goalNode = search(voxels, start, goal, actions, options);
    return goalNode ? reconstruct(goalNode) : null;
}

function search(voxels: Voxels, start: Vec3, goal: Vec3, actions: Actions, options?: FindPathOptions): Node | null {
    const [gx, gy, gz] = goal;
    const maxIterations = options?.maxIterations ?? Infinity;
    const greedy = options?.searchType === 'greedy';
    const heuristic = options?.heuristic ?? euclidean;

    releaseSearchNodes(); // return the previous search's nodes to the pool
    htReset(); // O(1) reset of the visited table
    sOpen.length = 0;
    sGoalX = gx;
    sGoalY = gy;
    sGoalZ = gz;
    sGreedy = greedy;
    sHeuristic = heuristic;

    const startSlot = htSlot(start[0], start[1], start[2]);
    htG[startSlot] = 0;
    const h0 = heuristic(start[0], start[1], start[2], gx, gy, gz);
    heapPush(sOpen, requestNode(start[0], start[1], start[2], null, 0, h0));

    let iterations = 0;
    while (sOpen.length > 0) {
        const current = heapPop(sOpen);
        const slot = htSlot(current.x, current.y, current.z);
        if (htClosed[slot] === 1) continue; // stale duplicate from lazy deletion

        if (current.x === gx && current.y === gy && current.z === gz) return current;

        if (++iterations > maxIterations) return null;
        htClosed[slot] = 1;

        sCurrent = current;
        actions(voxels, current.x, current.y, current.z, relax);
    }

    return null;
}

function reconstruct(node: Node): Vec3[] {
    const path: Vec3[] = [];
    let current: Node | null = node;
    while (current) {
        path.unshift([current.x, current.y, current.z]);
        current = current.parent;
    }
    return path;
}

// ── shortcut smoothing ──────────────────────────────────────────────

/** drop redundant waypoints: keep a cell only when the agent can't travel
 *  directly (per `shortcut`) from the last kept cell to the one after it.
 *  never shortcuts across an upward hop, a waypoint whose predecessor is
 *  lower (a +Y step) is preserved so the agent still jumps it. */
export function smoothPath(voxels: Voxels, path: Vec3[], shortcut: Shortcut): Vec3[] {
    if (path.length < 3) return path;
    const out: Vec3[] = [path[0]!];
    let prevIndex = 0;
    for (let i = 2; i < path.length; i++) {
        const prev = path[prevIndex]!;
        const next = path[i]!;
        const prevHop = prevIndex > 0 && prev[1] > path[prevIndex - 1]![1];
        const nextHop = next[1] > path[i - 1]![1];
        if (!prevHop && !nextHop && shortcut(voxels, prev, next)) continue;
        out.push(path[i - 1]!);
        prevIndex = i - 1;
    }
    out.push(path[path.length - 1]!);
    return out;
}

/** swept-box line-of-sight with gravity descent over a precomputed diagonal trace,
 *  the standard ground smoother for `smoothPath`. won't shortcut uphill. defaults to
 *  the standard ground agent; pass the same `walkable` the path was found with if you
 *  customized it. */
export function groundShortcut(walkable: Walkable = groundWalkable()): Shortcut {
    return (voxels, from, to) => {
        if (from[1] < to[1]) return false; // no uphill shortcut

        const sx = from[0];
        const sz = from[2];
        const dx = to[0] - sx;
        const dz = to[2] - sz;
        const ax = Math.abs(dx);
        const az = Math.abs(dz);
        if (ax >= SWEEP_DISTANCE || az >= SWEEP_DISTANCE) return false;

        const trace = SWEEPS[ax + az * SWEEP_DISTANCE]!;
        const limit = trace.length - 1;

        let y = from[1];
        for (let i = 1; i < limit; i++) {
            const p = trace[i]!;
            const x = dx > 0 ? sx + p[0] : sx - p[0];
            const z = dz > 0 ? sz + p[2] : sz - p[2];

            if (!walkable(voxels, x, y, z)) return false;
            while (y >= to[1] && walkable(voxels, x, y - 1, z)) y--;
            if (y < to[1]) return false;
        }
        return true;
    };
}

// ── reachability (flood-fill) ───────────────────────────────────────
// the dual of pathfinding: instead of "is there a path A→B", "which cells can I
// reach from A". shares the movement models, so every returned cell is genuinely
// path-reachable, handy for picking a provably-reachable target (e.g. NPC wander)
// without a path query that can fail.

// ── flood-fill scratch (module; floodFill is non-re-entrant like search()) ──
// the BFS frontier IS the result, so pooling its Vec3 cells makes a warmed-up flood
// allocate nothing per call (mirrors the A* node pool): cells are rewritten in place
// and the pool only ever grows. the old impl churned one `[x,y,z]` per discovered cell
// plus a queue array + a closure every call — the dominant per-flood garbage.
const fillPool: Vec3[] = [];
const fillView: Vec3[] = []; // right-sized alias handed back (slots reference fillPool cells)
let fillTail = 0; // cells discovered this flood == write cursor into fillPool

function fillPush(x: number, y: number, z: number): void {
    const cell = fillPool[fillTail];
    if (cell === undefined) fillPool[fillTail] = [x, y, z];
    else {
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
    }
    fillTail++;
}

// the successor sink handed to `actions`: append each first-touch neighbour to the
// pooled frontier. shared across calls, so there's no per-flood closure allocation.
const fillStep: StepFn = (x, y, z) => {
    htSlot(x, y, z);
    if (htInserted) fillPush(x, y, z);
};

/** breadth-first expansion of every cell reachable from `start` under the successor
 *  `actions`. `start` is included; order is roughly nearest-first. flood-fill is
 *  otherwise unbounded, so `maxIterations` caps cells expanded (the same work budget
 *  `findPath` takes); the result includes the frontier discovered up to that bound.
 *
 *  the returned array ALIASES a reused pool — it (and its cells) are valid only until
 *  the next `floodFill` call. read or copy what you need out before then; clone any
 *  cell you intend to retain (`[c[0], c[1], c[2]]`). */
export function floodFill(voxels: Voxels, start: Vec3, actions: Actions, maxIterations: number): Vec3[] {
    htReset(); // the visited table doubles as the "seen" set (htInserted = first touch)
    fillTail = 0;
    htSlot(start[0], start[1], start[2]); // mark the start visited...
    fillPush(start[0], start[1], start[2]); // ...and make it result[0] (start first)
    let head = 0;
    while (head < fillTail && head < maxIterations) {
        const cell = fillPool[head++]!;
        actions(voxels, cell[0], cell[1], cell[2], fillStep);
    }
    // hand back a right-sized view WITHOUT truncating fillPool itself, so its cells
    // survive to be reused next call. copying references allocates no Vec3s.
    fillView.length = fillTail;
    for (let i = 0; i < fillTail; i++) fillView[i] = fillPool[i]!;
    return fillView;
}

// ── swept-box voxel trace (skishore/wave) ───────────────────────────
// fixed-point sweep of a unit box; used only to precompute the diagonal cell
// sequence the shortcut check walks. self-contained, voxel-data-free.

const SWEEP_SHIFT = 12;
const SWEEP_RESOLUTION = 1 << SWEEP_SHIFT;
const SWEEP_MASK = SWEEP_RESOLUTION - 1;

// length 4: `best` starts at index 3 (the sentinel) before any axis wins it.
const sweepSpeeds = [0, 0, 0, 0];
const sweepDistances = [0, 0, 0, SWEEP_RESOLUTION];
const sweepVoxel = [0, 0, 0];

type SweepCheck = (x: number, y: number, z: number) => boolean;

function sweep(min: number[], max: number[], delta: number[], impacts: number[], check: SweepCheck): void {
    for (let i = 0; i < 3; i++) {
        min[i] = (min[i]! * SWEEP_RESOLUTION) | 0;
        max[i] = (max[i]! * SWEEP_RESOLUTION) | 0;
        delta[i] = (delta[i]! * SWEEP_RESOLUTION) | 0;
        impacts[i] = 0;
    }

    while (delta[0] || delta[1] || delta[2]) {
        let best = 3;
        let bounded = true;

        for (let i = 0; i < 3; i++) {
            const step = delta[i]!;
            const speed = Math.abs(step);
            const place = step > 0 ? max[i]! : -min[i]!;
            const distance = SWEEP_RESOLUTION - ((place - 1) & SWEEP_MASK);
            sweepSpeeds[i] = speed;
            sweepDistances[i] = distance;

            bounded = bounded && speed < distance;
            const better = speed * sweepDistances[best]! > sweepSpeeds[best]! * distance;
            if (better) best = i;
        }

        if (bounded) {
            for (let i = 0; i < 3; i++) {
                min[i]! += delta[i]!;
                max[i]! += delta[i]!;
                delta[i] = 0;
            }
            break;
        }

        const direction = delta[best]! > 0 ? 1 : -1;
        const factor = sweepDistances[best]! / sweepSpeeds[best]!;
        for (let i = 0; i < 3; i++) {
            const speed = sweepSpeeds[i]!;
            const distance = sweepDistances[i]!;
            const move = i !== best ? Math.min(distance - 1, (speed * factor) | 0) : distance;
            const stepAmount = move * Math.sign(delta[i]!);
            min[i]! += stepAmount;
            max[i]! += stepAmount;
            delta[i]! -= stepAmount;
        }

        const i = best;
        sweepVoxel[i] = (direction > 0 ? max[i]! - 1 : min[i]!) >> SWEEP_SHIFT;

        const j = i < 2 ? i + 1 : i - 2;
        const k = i < 1 ? i + 2 : i - 1;
        const jlo = min[j]! >> SWEEP_SHIFT;
        const jhi = (max[j]! - 1) >> SWEEP_SHIFT;
        const klo = min[k]! >> SWEEP_SHIFT;
        const khi = (max[k]! - 1) >> SWEEP_SHIFT;

        let done = false;
        for (let vj = jlo; !done && vj <= jhi; vj++) {
            sweepVoxel[j] = vj;
            for (let vk = klo; !done && vk <= khi; vk++) {
                sweepVoxel[k] = vk;
                const x = sweepVoxel[0]!;
                const y = sweepVoxel[1]!;
                const z = sweepVoxel[2]!;
                if (check(x, y, z)) continue;
                impacts[i] = direction;
                min[i] = min[i]! - direction;
                max[i] = max[i]! - direction;
                delta[i] = 0;
                done = true;
            }
        }
    }

    for (let i = 0; i < 3; i++) {
        min[i] = min[i]! / SWEEP_RESOLUTION;
        max[i] = max[i]! / SWEEP_RESOLUTION;
    }
}

// the diagonal trace from (0,0) to (x,z): every cell a unit box passes through.
function precomputeDiagonal(x: number, z: number): Vec3[] {
    const result: Vec3[] = [[0, 0, 0]];
    sweep([0, 0, 0], [1, 1, 1], [x, 0, z], [0, 0, 0], (px, py, pz) => {
        result.push([px, py, pz]);
        return true;
    });
    return result;
}

const SWEEP_DISTANCE = 16;
const SWEEPS: Vec3[][] = [];
for (let z = 0; z < SWEEP_DISTANCE; z++) {
    for (let x = 0; x < SWEEP_DISTANCE; x++) {
        SWEEPS.push(precomputeDiagonal(x, z));
    }
}
