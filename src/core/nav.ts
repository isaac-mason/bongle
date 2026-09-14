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

import type { Vec3 } from 'math';
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
// (we only need spread + determinism) and it handles negative coords. Takes the mask so the
// A* table and a `Flood`'s own map can share it rather than drift apart.
function hashCell(x: number, y: number, z: number, mask: number): number {
    const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    return (h >>> 0) & mask;
}

function hashCoord(x: number, y: number, z: number): number {
    return hashCell(x, y, z, htMask);
}

// return (x,y,z)'s slot, claiming a fresh one (g=Infinity, open) on first touch this search.
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
            return i;
        }
        if (htKeyX[i] === x && htKeyY[i] === y && htKeyZ[i] === z) return i;
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
 * A route, caller-owned and poolable: cells plus how many of them are live.
 *
 * `count` rather than `cells.length` for the reason `Flood` has one — the cells past it are
 * retained storage from a longer path, and truncating to drop them is what would stop a warmed
 * up `Path` from ever being allocation-free. Never read past `count`; never truncate.
 *
 * This is why every producer takes `out: Path` and not `out: Vec3[]`. An array cannot be
 * genuinely reused: resetting it means `length = 0`, which throws the pooled cells away, so the
 * callee ends up allocating a fresh `[x, y, z]` per cell anyway — an out-param that saves one
 * allocation and churns N. A `Path` owns both halves, so cells are rewritten in place and only
 * a path longer than any before it allocates at all.
 */
export type Path = { cells: Vec3[]; count: number };

/** an empty `Path`. Grows to its high-water mark, then stops allocating. */
export function createPath(): Path {
    return { cells: [], count: 0 };
}

/** append a cell, rewriting the pooled entry at `count` rather than allocating one. */
function pathPush(p: Path, x: number, y: number, z: number): void {
    const cell = p.cells[p.count];
    if (cell === undefined) p.cells[p.count] = [x, y, z];
    else {
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
    }
    p.count++;
}

/** reverse the live prefix in place. swaps references, so it allocates nothing. */
function pathReverse(p: Path): void {
    for (let i = 0, j = p.count - 1; i < j; i++, j--) {
        const t = p.cells[i]!;
        p.cells[i] = p.cells[j]!;
        p.cells[j] = t;
    }
}

/** copy `src`'s live cells into `out`, replacing whatever it held. */
function pathCopy(out: Path, src: Path): void {
    out.count = 0;
    for (let i = 0; i < src.count; i++) {
        const c = src.cells[i]!;
        pathPush(out, c[0]!, c[1]!, c[2]!);
    }
}

/**
 * Find a path of cells from `start` to `goal` under the successor function `actions`, into
 * `out`. Returns whether the goal was reached; `out.count` is 0 when it was not.
 *
 * Every cell, never smoothed — smooth explicitly with `smoothPath` if you want steering
 * waypoints. Pass `actions` directly (e.g. `groundActions`), wrap one, or build via
 * `gridActions`. Heuristic defaults to euclidean (override via `options.heuristic`).
 *
 * Uses lazy deletion: a cheaper route to an open cell pushes a fresh node and stale duplicates
 * are skipped on pop (closed check), correct without decrease-key bookkeeping.
 */
export function findPath(
    out: Path,
    voxels: Voxels,
    start: Vec3,
    goal: Vec3,
    actions: Actions,
    options?: FindPathOptions,
): boolean {
    const goalNode = search(voxels, start, goal, actions, options);
    out.count = 0;
    if (!goalNode) return false;
    reconstruct(out, goalNode);
    return true;
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

// walk the parent chain into `out`. goal-first as we go, then reversed — `unshift` per cell
// would be O(n²), and reversing references is free.
function reconstruct(out: Path, node: Node): void {
    out.count = 0;
    for (let current: Node | null = node; current; current = current.parent) {
        pathPush(out, current.x, current.y, current.z);
    }
    pathReverse(out);
}

// ── shortcut smoothing ──────────────────────────────────────────────

/** drop redundant waypoints: keep a cell only when the agent can't travel
 *  directly (per `shortcut`) from the last kept cell to the one after it.
 *  never shortcuts across an upward hop, a waypoint whose predecessor is
 *  lower (a +Y step) is preserved so the agent still jumps it. */
export function smoothPath(out: Path, voxels: Voxels, path: Path, shortcut: Shortcut): Path {
    if (out === path) throw new Error('nav.smoothPath: `out` must not be the input path');
    if (path.count < 3) {
        pathCopy(out, path);
        return out;
    }
    out.count = 0;
    const first = path.cells[0]!;
    pathPush(out, first[0]!, first[1]!, first[2]!);
    let prevIndex = 0;
    for (let i = 2; i < path.count; i++) {
        const prev = path.cells[prevIndex]!;
        const next = path.cells[i]!;
        const prevHop = prevIndex > 0 && prev[1]! > path.cells[prevIndex - 1]![1]!;
        const nextHop = next[1]! > path.cells[i - 1]![1]!;
        if (!prevHop && !nextHop && shortcut(voxels, prev, next)) continue;
        const keep = path.cells[i - 1]!;
        pathPush(out, keep[0]!, keep[1]!, keep[2]!);
        prevIndex = i - 1;
    }
    const last = path.cells[path.count - 1]!;
    pathPush(out, last[0]!, last[1]!, last[2]!);
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

/**
 * A `Flood`'s own coord → cell-index map: the "have I seen this cell" set, which doubles as the
 * lookup behind `floodIndexOf`.
 *
 * The flood used to borrow the A* table, and that is what made a completed flood unqueryable:
 * one module-level table, reset per search, so it only ever described the MOST RECENT one. Ask
 * a retained flood "did you reach here?" after anything else had run and it answered from
 * somebody else's search.
 *
 * Owning one per flood is also SMALLER, not bigger. A flood needs "first touch?" and nothing
 * else — it never reads a g-score or a closed flag — so this is four Int32Arrays where the A*
 * table carries a Float64 g and a closed byte on top. And because the shapes differ, A* keeps
 * its own table and its own probe loop untouched: nothing hot pays for this.
 *
 * Exported only because `Flood` names it. Treat it as internal.
 */
export type FloodMap = {
    cap: number;
    mask: number;
    keyX: Int32Array;
    keyY: Int32Array;
    keyZ: Int32Array;
    /** generation stamp per slot; a slot is live iff `gen[i] === generation`. */
    gen: Int32Array;
    /** index into `Flood.cells` for the cell in this slot. */
    cell: Int32Array;
    generation: number;
    count: number;
};

/**
 * A completed flood: the cells reached, the BFS tree that reached them, and the map to look a
 * cell up by coordinate.
 *
 * The tree is the point. A breadth-first expansion necessarily discovers HOW it got to every
 * cell, and throwing that away meant a caller who picked a destination out of the result had to
 * run `findPath` to rediscover a route the flood had already proved exists — two searches for
 * one answer, and the A* could still fail on its own budget.
 *
 * CALLER-OWNED, so it is also safe to keep. `floodFill` refills one of these in place, which
 * means two agents can hold their own without clobbering each other, and one agent can flood
 * once and query it across frames.
 *
 * Only `[0, count)` of `cells`/`parent` is live. Entries beyond it are retained pool storage
 * from a previous, larger fill — never read them, and never truncate them either, since keeping
 * them is what makes a warmed-up `Flood` allocation-free.
 */
export type Flood = {
    /** cells reached, start first, roughly nearest-first. */
    cells: Vec3[];
    /** for each cell, the index it was discovered FROM. `-1` at the start. */
    parent: number[];
    /** how many entries of `cells`/`parent` this fill wrote. */
    count: number;
    /** coord → cell index. internal; go through `floodIndexOf`. */
    map: FloodMap;
};

const FLOOD_LOAD = 0.7;
const FLOOD_CAP0 = 1 << 6;

function createFloodMap(cap: number): FloodMap {
    return {
        cap,
        mask: cap - 1,
        keyX: new Int32Array(cap),
        keyY: new Int32Array(cap),
        keyZ: new Int32Array(cap),
        gen: new Int32Array(cap),
        cell: new Int32Array(cap),
        generation: 0,
        count: 0,
    };
}

/** an empty `Flood`, ready to be filled. Grows to its high-water mark, then stops allocating. */
export function createFlood(): Flood {
    return { cells: [], parent: [], count: 0, map: createFloodMap(FLOOD_CAP0) };
}

// O(1) between fills: bump the stamp rather than clear the arrays.
function floodMapReset(m: FloodMap): void {
    m.count = 0;
    m.generation++;
    // the stamp is an Int32; on the (astronomically rare) wrap, clear so no stale slot aliases
    if (m.generation === 0x7fffffff) {
        m.gen.fill(0);
        m.generation = 1;
    }
}

// double capacity and re-insert this fill's live slots. one-off — the bigger arrays persist.
function floodMapGrow(m: FloodMap): void {
    const oldCap = m.cap;
    const oldKeyX = m.keyX;
    const oldKeyY = m.keyY;
    const oldKeyZ = m.keyZ;
    const oldGen = m.gen;
    const oldCell = m.cell;

    m.cap = oldCap << 1;
    m.mask = m.cap - 1;
    m.keyX = new Int32Array(m.cap);
    m.keyY = new Int32Array(m.cap);
    m.keyZ = new Int32Array(m.cap);
    m.gen = new Int32Array(m.cap);
    m.cell = new Int32Array(m.cap);

    for (let i = 0; i < oldCap; i++) {
        if (oldGen[i] !== m.generation) continue;
        const x = oldKeyX[i]!;
        const y = oldKeyY[i]!;
        const z = oldKeyZ[i]!;
        let j = hashCell(x, y, z, m.mask);
        while (m.gen[j] === m.generation) j = (j + 1) & m.mask;
        m.gen[j] = m.generation;
        m.keyX[j] = x;
        m.keyY[j] = y;
        m.keyZ[j] = z;
        m.cell[j] = oldCell[i]!;
    }
}

// the slot for (x,y,z), claiming a fresh one (cell = -1, "seen but unassigned") on first touch.
function floodMapSlot(m: FloodMap, x: number, y: number, z: number): number {
    if (m.count >= m.cap * FLOOD_LOAD) floodMapGrow(m);
    let i = hashCell(x, y, z, m.mask);
    for (;;) {
        if (m.gen[i] !== m.generation) {
            m.gen[i] = m.generation;
            m.keyX[i] = x;
            m.keyY[i] = y;
            m.keyZ[i] = z;
            m.cell[i] = -1;
            m.count++;
            return i;
        }
        if (m.keyX[i] === x && m.keyY[i] === y && m.keyZ[i] === z) return i;
        i = (i + 1) & m.mask;
    }
}

function floodPush(f: Flood, x: number, y: number, z: number, from: number): void {
    const cell = f.cells[f.count];
    if (cell === undefined) f.cells[f.count] = [x, y, z];
    else {
        cell[0] = x;
        cell[1] = y;
        cell[2] = z;
    }
    f.parent[f.count] = from;
    f.count++;
}

// in-flight fill state. the successor sink is shared rather than a per-call closure (the same
// no-allocation reason the A* node pool exists), so the flood being written and the cell being
// expanded live here. non-re-entrant, exactly like `search()`.
let fillTarget: Flood | null = null;
let fillFrom = 0;

const fillStep: StepFn = (x, y, z) => {
    const f = fillTarget!;
    const slot = floodMapSlot(f.map, x, y, z);
    if (f.map.cell[slot] === -1) {
        f.map.cell[slot] = f.count; // the map IS the visited set; -1 means seen-but-unqueued
        floodPush(f, x, y, z, fillFrom);
    }
};

/**
 * Breadth-first expansion of every cell reachable from `start` under the successor `actions`,
 * written into `out`. `start` is included, first; order is roughly nearest-first.
 *
 * Flood-fill is otherwise unbounded, so `maxIterations` caps cells EXPANDED (the same work
 * budget `findPath` takes); the result includes the frontier discovered up to that bound.
 *
 * Touches no shared state — a fill neither disturbs nor is disturbed by A* or another `Flood`.
 * Returns `out`, so a call reads as an assignment.
 */
export function floodFill(out: Flood, voxels: Voxels, start: Vec3, actions: Actions, maxIterations: number): Flood {
    out.count = 0;
    floodMapReset(out.map);
    fillTarget = out;
    const slot = floodMapSlot(out.map, start[0], start[1], start[2]);
    out.map.cell[slot] = 0;
    floodPush(out, start[0], start[1], start[2], -1); // cells[0], the tree's root
    let head = 0;
    while (head < out.count && head < maxIterations) {
        fillFrom = head; // whatever `fillStep` discovers next came from here
        const cell = out.cells[head++]!;
        actions(voxels, cell[0], cell[1], cell[2], fillStep);
    }
    fillTarget = null;
    return out;
}

/** the index of `(x,y,z)` in `flood.cells`, or `-1` if the fill never reached it. */
export function floodIndexOf(flood: Flood, x: number, y: number, z: number): number {
    const m = flood.map;
    let i = hashCell(x, y, z, m.mask);
    for (;;) {
        if (m.gen[i] !== m.generation) return -1; // an unclaimed slot: never seen
        if (m.keyX[i] === x && m.keyY[i] === y && m.keyZ[i] === z) return m.cell[i]!;
        i = (i + 1) & m.mask;
    }
}

/** did this fill reach `(x,y,z)`? the question `floodIndexOf` answers, when you only want yes/no. */
export function floodReached(flood: Flood, x: number, y: number, z: number): boolean {
    return floodIndexOf(flood, x, y, z) !== -1;
}

/**
 * The route from the fill's start to `cells[index]`, start-first — the same cell list
 * `findPath` returns, and smoothable the same way.
 *
 * FREE, in the sense that matters: the flood already found this route, so this only walks the
 * parent chain back. No search, no budget, and no way for it to fail on a cell the flood
 * reached — which is what makes "pick a destination out of a flood" a reachable-by-construction
 * move rather than a hopeful one.
 *
 * `out`'s cells are its own, rewritten in place, so the result survives the next fill — unlike
 * `flood.cells`, which the next fill overwrites.
 */
export function floodPath(out: Path, flood: Flood, index: number): Path {
    out.count = 0;
    if (index < 0 || index >= flood.count) return out;
    for (let i = index; i !== -1; i = flood.parent[i]!) {
        const c = flood.cells[i]!;
        pathPush(out, c[0]!, c[1]!, c[2]!);
    }
    pathReverse(out); // walked goal→start; callers want start→goal
    return out;
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
