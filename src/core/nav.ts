// voxel pathfinding: functional A* over the voxel grid. Integer voxel space; the movement model is pluggable via `actions`.

import type { Vec3 } from 'math';
import { BLOCK_FLAG_COLLISION, BLOCK_FLAG_PATHFINDABLE } from './voxels/block-registry';
import { getBlockState, type Voxels } from './voxels/voxels';

function flagsAt(voxels: Voxels, x: number, y: number, z: number): number {
    return voxels.registry.flags[getBlockState(voxels, x, y, z)]!;
}

/** may a navigating agent occupy this single cell? */
function isPassable(voxels: Voxels, x: number, y: number, z: number): boolean {
    return (flagsAt(voxels, x, y, z) & BLOCK_FLAG_PATHFINDABLE) !== 0;
}

/** is this cell solid enough to stand on / support an agent above it? */
function isSupport(voxels: Voxels, x: number, y: number, z: number): boolean {
    return (flagsAt(voxels, x, y, z) & BLOCK_FLAG_COLLISION) !== 0;
}

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

/** land-standing: the `size` box is clear and every column beneath its footprint is supported; `(x, y, z)` is the feet/min corner. */
function isWalkable(voxels: Voxels, x: number, y: number, z: number, size: Vec3): boolean {
    for (let dx = 0; dx < size[0]; dx++) {
        for (let dz = 0; dz < size[2]; dz++) {
            if (!isSupport(voxels, x + dx, y - 1, z + dz)) return false;
        }
    }
    return isClear(voxels, x, y, z, size);
}

/** strategy: can the agent stand/be at this cell? scalar args so the A* inner loop allocates nothing. */
export type Walkable = (voxels: Voxels, x: number, y: number, z: number) => boolean;

/** ground agent, needs solid support below; default body is 1x2x1 (2 blocks high). */
export function groundWalkable(size: Vec3 = [1, 2, 1]): Walkable {
    return (voxels, x, y, z) => isWalkable(voxels, x, y, z, size);
}

/** one candidate offset for the fixed-move case, input to `gridActions`. */
export type Move = { offset: Vec3; cost: number };

/** the sink a successor calls once per reachable neighbour cell; the search supplies it, so a successor never builds a list. */
export type StepFn = (x: number, y: number, z: number, cost: number) => void;

/** the pluggable successor function `findPath`/`floodFill` search over: expand a cell by calling `step` for each reachable neighbour. */
export type Actions = (voxels: Voxels, x: number, y: number, z: number, step: StepFn) => void;

/** admissible-ish distance estimate between two cells. */
export type Heuristic = (fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number) => number;

/** line-of-sight test used by `smoothPath`: can the agent travel `from` to `to` directly, skipping intermediate waypoints? */
export type Shortcut = (voxels: Voxels, from: Vec3, to: Vec3) => boolean;

/** build an `Actions` from a fixed candidate offset set + a walkability test. */
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

/** euclidean distance; fast, slightly non-admissible with unit-cost diagonals. */
const euclidean: Heuristic = (fromX, fromY, fromZ, toX, toY, toZ) => Math.hypot(fromX - toX, fromY - toY, fromZ - toZ);

// 12 ground moves: 4 cardinals x {flat, step-up +1, step-down -1}, unit cost.
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

/** the default ground move set; spread + extend it and feed `gridActions` for a custom successor. */
export const groundMoves: readonly Move[] = GROUND_OFFSETS.map((offset) => ({ offset, cost: 1 }));

/** the ready-made ground successor (default 1x2x1 agent). */
export const groundActions: Actions = gridActions(groundMoves, groundWalkable());

/** the four directions an agent can step off a ledge into. */
const CARDINAL_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
];

/** ground successor that also lets the agent walk off a ledge and drop to the first landing below, up to `maxDrop` (must be finite). */
export function groundDropActions(opts?: { size?: Vec3; maxDrop?: number; dropCost?: number }): Actions {
    const size = opts?.size ?? [1, 2, 1];
    const maxDrop = opts?.maxDrop ?? 64;
    const dropCost = opts?.dropCost ?? 0.2;
    const base = gridActions(groundMoves, groundWalkable(size));
    return (voxels, x, y, z, step) => {
        base(voxels, x, y, z, step);
        for (const [dx, dz] of CARDINAL_OFFSETS) {
            const nx = x + dx;
            const nz = z + dz;
            if (!isClear(voxels, nx, y, nz, size)) continue;
            for (let ly = y - 1; y - ly <= maxDrop; ly--) {
                if (!isClear(voxels, nx, ly, nz, size)) break;
                if (isSupport(voxels, nx, ly - 1, nz)) {
                    // ly === y-1 is the -1 step the base actions already emit, so only add genuine drops (two or more down).
                    if (ly < y - 1) step(nx, ly, nz, 1 + (y - ly) * dropCost);
                    break;
                }
            }
        }
    };
}

type Node = {
    x: number;
    y: number;
    z: number;
    parent: Node | null;
    g: number;
    f: number;
};

// node pool: a bump allocator, released as a whole batch at the next search start since any node may still sit on the parent chain.
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
function releaseSearchNodes(): void {
    nodePoolIndex = 0;
}

// min-heap of nodes keyed by f.
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

// visited table (gScore + closed), reused across searches. Open-addressing map (x,y,z) -> slot; a generation stamp resets it in O(1).
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
    // on the astronomically rare Int32 wrap, clear the stamps so no stale slot can alias the reused value.
    if (generation === 0x7fffffff) {
        htGen.fill(0);
        generation = 1;
    }
}

// spatial hash; takes the mask so the A* table and a `Flood`'s own map can share it rather than drift apart.
function hashCell(x: number, y: number, z: number, mask: number): number {
    const h = (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
    return (h >>> 0) & mask;
}

function hashCoord(x: number, y: number, z: number): number {
    return hashCell(x, y, z, htMask);
}

// (x,y,z)'s slot, claiming a fresh one (g=Infinity, open) on first touch this search.
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

// double capacity and re-insert this search's live slots; warmed-up searches never hit it since the bigger arrays persist.
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

// A* search state (module scratch, search() is non-re-entrant); hoisting lets `relax` be one shared StepFn with zero allocation.
const sOpen: NodeHeap = [];
let sGoalX = 0;
let sGoalY = 0;
let sGoalZ = 0;
let sGreedy = false;
let sHeuristic: Heuristic = euclidean;
let sCurrent: Node | null = null;

// the successor sink handed to `actions`: relax one neighbour against the open set.
const relax: StepFn = (nx, ny, nz, cost) => {
    const slot = htSlot(nx, ny, nz);
    if (htClosed[slot] === 1) return;
    const g = sCurrent!.g + cost;
    if (g >= htG[slot]!) return; // htG seeds Infinity, so a first touch always wins
    htG[slot] = g;
    const h = sHeuristic(nx, ny, nz, sGoalX, sGoalY, sGoalZ);
    heapPush(sOpen, requestNode(nx, ny, nz, sCurrent, g, sGreedy ? h : g + h));
};

/** how the frontier is scored: 'shortest' = classic A* (g + h); 'greedy' = best-first (h only), faster, not optimal. */
export type SearchType = 'shortest' | 'greedy';

export type FindPathOptions = {
    /** cap on A* iterations; returns null once exceeded, the guard against an unreachable/disconnected goal. */
    maxIterations?: number;
    /** frontier scoring, default 'shortest'. */
    searchType?: SearchType;
    /** distance estimate for A*, default euclidean. */
    heuristic?: Heuristic;
};

/** a route, caller-owned and poolable: cells plus how many are live. Never read or truncate past `count`. */
export type Path = { cells: Vec3[]; count: number };

/** an empty `Path`; grows to its high-water mark, then stops allocating. */
export function createPath(): Path {
    return { cells: [], count: 0 };
}

/** append a cell, rewriting the pooled entry at `count` instead of allocating one. */
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

/** find a path of cells from `start` to `goal` under `actions`, into `out`; returns whether the goal was reached. */
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

    releaseSearchNodes();
    htReset();
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

// walk the parent chain into `out`, goal-first then reversed: `unshift` per cell would be O(n^2).
function reconstruct(out: Path, node: Node): void {
    out.count = 0;
    for (let current: Node | null = node; current; current = current.parent) {
        pathPush(out, current.x, current.y, current.z);
    }
    pathReverse(out);
}

/** drop redundant waypoints: keep a cell only when the agent can't travel directly from the last kept cell to the one after it. */
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

/** swept-box line-of-sight with gravity descent over a precomputed diagonal trace, the standard ground smoother for `smoothPath`. */
export function groundShortcut(walkable: Walkable = groundWalkable()): Shortcut {
    return (voxels, from, to) => {
        if (from[1] < to[1]) return false;

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

// reachability (flood-fill): the dual of pathfinding, "which cells can I reach from A" instead of "is there a path A->B".

/** a `Flood`'s own coord -> cell-index map, the "have I seen this cell" set that also backs `floodIndexOf`. Treat as internal. */
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

/** a completed flood: the cells reached, the BFS tree that reached them, and the map to look a cell up by coordinate. */
export type Flood = {
    /** cells reached, start first, roughly nearest-first. */
    cells: Vec3[];
    /** for each cell, the index it was discovered from; `-1` at the start. */
    parent: number[];
    /** how many entries of `cells`/`parent` this fill wrote. */
    count: number;
    /** coord to cell index; internal, go through `floodIndexOf`. */
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

/** an empty `Flood`, ready to be filled; grows to its high-water mark, then stops allocating. */
export function createFlood(): Flood {
    return { cells: [], parent: [], count: 0, map: createFloodMap(FLOOD_CAP0) };
}

// O(1) between fills: bump the stamp rather than clear the arrays.
function floodMapReset(m: FloodMap): void {
    m.count = 0;
    m.generation++;
    if (m.generation === 0x7fffffff) {
        m.gen.fill(0);
        m.generation = 1;
    }
}

// double capacity and re-insert this fill's live slots; the bigger arrays persist across fills.
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

// the slot for (x,y,z), claiming a fresh one (cell = -1, seen but unassigned) on first touch.
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

// in-flight fill state, shared rather than a per-call closure (no-allocation, same reason as the A* node pool); non-re-entrant.
let fillTarget: Flood | null = null;
let fillFrom = 0;

const fillStep: StepFn = (x, y, z) => {
    const f = fillTarget!;
    const slot = floodMapSlot(f.map, x, y, z);
    if (f.map.cell[slot] === -1) {
        f.map.cell[slot] = f.count;
        floodPush(f, x, y, z, fillFrom);
    }
};

/** breadth-first expansion of every cell reachable from `start` under `actions`, written into `out`; caps at `maxIterations` cells. */
export function floodFill(out: Flood, voxels: Voxels, start: Vec3, actions: Actions, maxIterations: number): Flood {
    out.count = 0;
    floodMapReset(out.map);
    fillTarget = out;
    const slot = floodMapSlot(out.map, start[0], start[1], start[2]);
    out.map.cell[slot] = 0;
    floodPush(out, start[0], start[1], start[2], -1);
    let head = 0;
    while (head < out.count && head < maxIterations) {
        fillFrom = head;
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
        if (m.gen[i] !== m.generation) return -1;
        if (m.keyX[i] === x && m.keyY[i] === y && m.keyZ[i] === z) return m.cell[i]!;
        i = (i + 1) & m.mask;
    }
}

/** did this fill reach `(x,y,z)`? the question `floodIndexOf` answers, when you only want yes/no. */
export function floodReached(flood: Flood, x: number, y: number, z: number): boolean {
    return floodIndexOf(flood, x, y, z) !== -1;
}

/** the route from the fill's start to `cells[index]`, start-first; free, since the flood already found it (just walks the parent chain). */
export function floodPath(out: Path, flood: Flood, index: number): Path {
    out.count = 0;
    if (index < 0 || index >= flood.count) return out;
    for (let i = index; i !== -1; i = flood.parent[i]!) {
        const c = flood.cells[i]!;
        pathPush(out, c[0]!, c[1]!, c[2]!);
    }
    pathReverse(out);
    return out;
}

// swept-box voxel trace: fixed-point sweep of a unit box, precomputing the diagonal cell sequence the shortcut check walks.

const SWEEP_SHIFT = 12;
const SWEEP_RESOLUTION = 1 << SWEEP_SHIFT;
const SWEEP_MASK = SWEEP_RESOLUTION - 1;

// length 4: `best` starts at index 3, the sentinel, before any axis wins it.
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
