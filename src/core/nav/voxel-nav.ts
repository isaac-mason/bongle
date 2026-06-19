/**
 * voxel pathfinding — standalone, functional A* over the voxel grid.
 *
 * adapted from the sketch at sketches/voxels/graph-search-pathfinding
 * (A* + swept-box shortcut smoothing), bound to the engine's `Voxels` and
 * block-flag system. pure functions + types — no traits, no systems.
 *
 * everything operates in INTEGER VOXEL SPACE. callers convert world↔voxel at
 * the boundary (floor a world position to its cell; a cell's feet-centre is
 * `[x + 0.5, y, z + 0.5]`). pathfinding produces a list of cells; following
 * those waypoints (steering a character) is a separate concern.
 *
 * the movement model is pluggable via `actions` — a successor function that
 * expands a cell into its reachable neighbours. it owns both the candidate move
 * set and the walkability test, so the same A* drives land / fly / swim (and
 * context-dependent movement like ladders) by swapping the model. `gridActions`
 * builds the common fixed-offset case from a `Move[]` + a `Walkable`.
 */

import type { Vec3 } from 'mathcat';
import { BLOCK_FLAG_COLLISION, BLOCK_FLAG_PATHFINDABLE } from '../voxels/block-registry';
import { getBlockState, type Voxels } from '../voxels/voxels';

// ── voxel reads (block-flag based) ──────────────────────────────────

function flagsAt(voxels: Voxels, x: number, y: number, z: number): number {
    return voxels.registry.flags[getBlockState(voxels, x, y, z)]!;
}

/** may a navigating agent occupy this single cell? (BLOCK_FLAG_PATHFINDABLE) */
export function isPassable(voxels: Voxels, x: number, y: number, z: number): boolean {
    return (flagsAt(voxels, x, y, z) & BLOCK_FLAG_PATHFINDABLE) !== 0;
}

/** is this cell solid enough to stand on / support an agent above it?
 *  (BLOCK_FLAG_COLLISION) */
export function isSupport(voxels: Voxels, x: number, y: number, z: number): boolean {
    return (flagsAt(voxels, x, y, z) & BLOCK_FLAG_COLLISION) !== 0;
}

// ── walkability (footprint = cell + size, all in cells) ─────────────

/** every cell of the `size` box with min corner `(x, y, z)` is passable. */
export function isClear(voxels: Voxels, x: number, y: number, z: number, size: Vec3): boolean {
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
export function isWalkable(voxels: Voxels, x: number, y: number, z: number, size: Vec3): boolean {
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

/** land agent — needs ground support. default body is 1×2×1 (2 blocks high). */
export function landWalkable(size: Vec3 = [1, 2, 1]): Walkable {
    return (voxels, x, y, z) => isWalkable(voxels, x, y, z, size);
}

/** flying/swimming agent — just needs a clear body box, no support. */
export function flyWalkable(size: Vec3 = [1, 2, 1]): Walkable {
    return (voxels, x, y, z) => isClear(voxels, x, y, z, size);
}

// ── movement model (the slot-in "actions") ─────────────────────────

/** one candidate offset for the fixed-move case — input to `gridActions`. */
export type Move = { offset: Vec3; cost: number };

/** a reachable neighbour cell (a resolved move) yielded by `Actions`. */
export type Step = { x: number; y: number; z: number; cost: number };

/** the pluggable move generator: expand a cell into its reachable neighbours.
 *  the candidate move set AND per-cell walkability both live here, so movement
 *  can be context-dependent (ladders, liquids, variable cost). build the common
 *  fixed-offset case with `gridActions`, or write your own. returns a fresh
 *  array per call (matches the source sketch; pathfinding isn't a hot path). */
export type Actions = (voxels: Voxels, x: number, y: number, z: number) => Step[];

/** admissible-ish distance estimate between two cells. */
export type Heuristic = (fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number) => number;

/** line-of-sight test used by the smoother: can the agent travel `from`→`to`
 *  directly (skipping intermediate waypoints)? */
export type Shortcut = (voxels: Voxels, from: Vec3, to: Vec3) => boolean;

export type MovementModel = {
    actions: Actions;
    heuristic: Heuristic;
};

/** build an `Actions` from a fixed candidate offset set + a walkability test —
 *  the common case (land / fly). each offset landing on a walkable cell becomes
 *  a reachable step. */
export function gridActions(moves: readonly Move[], walkable: Walkable): Actions {
    return (voxels, x, y, z) => {
        const steps: Step[] = [];
        for (const move of moves) {
            const nx = x + move.offset[0];
            const ny = y + move.offset[1];
            const nz = z + move.offset[2];
            if (walkable(voxels, nx, ny, nz)) steps.push({ x: nx, y: ny, z: nz, cost: move.cost });
        }
        return steps;
    };
}

/** euclidean distance — fast, slightly non-admissible with unit-cost diagonals
 *  (favours speed over strict optimality, matching the source sketch). */
export const euclidean: Heuristic = (fromX, fromY, fromZ, toX, toY, toZ) =>
    Math.hypot(fromX - toX, fromY - toY, fromZ - toZ);

// 12 land moves: 4 cardinals × {flat, step-up +1, step-down −1}. unit cost.
const LAND_OFFSETS: Vec3[] = [
    [-1, 0, 0], [-1, 1, 0], [-1, -1, 0],
    [1, 0, 0], [1, 1, 0], [1, -1, 0],
    [0, 0, -1], [0, 1, -1], [0, -1, -1],
    [0, 0, 1], [0, 1, 1], [0, -1, 1],
];

const LAND_MOVES: readonly Move[] = LAND_OFFSETS.map((offset) => ({ offset, cost: 1 }));

/** ground-walking model: 12 land moves, land walkability (2-high default),
 *  euclidean heuristic. pass `walkable` to override the standing check
 *  (footprint, hazards, ...). pair with `groundShortcut` + `smoothPath` for
 *  natural paths, or just use `findGroundPath`. */
export function landMovement(options?: { size?: Vec3; walkable?: Walkable }): MovementModel {
    const walkable = options?.walkable ?? landWalkable(options?.size ?? [1, 2, 1]);
    return { actions: gridActions(LAND_MOVES, walkable), heuristic: euclidean };
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

// min-heap over nodes keyed by f. pure push/pop (no external mutation), so the
// heap invariant always holds.
class NodeHeap {
    private nodes: Node[] = [];

    get size(): number {
        return this.nodes.length;
    }

    push(node: Node): void {
        const nodes = this.nodes;
        nodes.push(node);
        let i = nodes.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (nodes[parent]!.f <= nodes[i]!.f) break;
            [nodes[parent], nodes[i]] = [nodes[i]!, nodes[parent]!];
            i = parent;
        }
    }

    pop(): Node {
        const nodes = this.nodes;
        const top = nodes[0]!;
        const last = nodes.pop()!;
        if (nodes.length > 0) {
            nodes[0] = last;
            let i = 0;
            const n = nodes.length;
            for (;;) {
                const left = 2 * i + 1;
                const right = 2 * i + 2;
                let smallest = i;
                if (left < n && nodes[left]!.f < nodes[smallest]!.f) smallest = left;
                if (right < n && nodes[right]!.f < nodes[smallest]!.f) smallest = right;
                if (smallest === i) break;
                [nodes[smallest], nodes[i]] = [nodes[i]!, nodes[smallest]!];
                i = smallest;
            }
        }
        return top;
    }
}

const key = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** how the frontier is scored. 'shortest' = classic A* (g + h); 'greedy' =
 *  best-first (h only) — faster, not optimal. */
export type SearchType = 'shortest' | 'greedy';

export type FindPathOptions = {
    /** cap on A* iterations (nodes expanded); returns null once exceeded. the
     *  guard against an unreachable/disconnected goal blowing up the search. */
    maxIterations?: number;
    /** frontier scoring. default 'shortest'. */
    searchType?: SearchType;
};

/**
 * find a walkable path of voxel cells from `start` to `goal`, or null. raw —
 * no smoothing (apply `smoothPath` after, or use `findGroundPath`).
 *
 * uses lazy deletion: a cheaper route to an open cell pushes a fresh node and
 * stale duplicates are skipped on pop (closed check) — correct without
 * decrease-key bookkeeping.
 */
export function findPath(voxels: Voxels, start: Vec3, goal: Vec3, model: MovementModel, options?: FindPathOptions): Vec3[] | null {
    const goalNode = search(voxels, start, goal, model, options);
    return goalNode ? reconstruct(goalNode) : null;
}

/**
 * batteries-included ground pathfinding for the common case: a default 1×2×1
 * land agent, A*, and swept-box shortcut smoothing. `options` forwards to the
 * underlying `findPath` — pass `maxIterations` to bound the search (essential for
 * AI repathing toward possibly-unreachable goals) or `searchType: 'greedy'`. it's
 * otherwise exactly —
 *
 * ```ts
 * const walkable = landWalkable();
 * const path = findPath(voxels, start, goal, landMovement({ walkable }), options);
 * return path && smoothPath(voxels, path, groundShortcut(walkable));
 * ```
 *
 * so for a different agent size, no smoothing, or fly/swim/ladder movement,
 * compose those inner APIs directly.
 */
export function findGroundPath(voxels: Voxels, start: Vec3, goal: Vec3, options?: FindPathOptions): Vec3[] | null {
    const walkable = landWalkable();
    const path = findPath(voxels, start, goal, landMovement({ walkable }), options);
    return path ? smoothPath(voxels, path, groundShortcut(walkable)) : null;
}

function search(voxels: Voxels, start: Vec3, goal: Vec3, model: MovementModel, options?: FindPathOptions): Node | null {
    const [gx, gy, gz] = goal;
    const maxIterations = options?.maxIterations ?? Infinity;
    const greedy = options?.searchType === 'greedy';
    const { actions, heuristic } = model;

    const open = new NodeHeap();
    const gScore = new Map<string, number>();
    const closed = new Set<string>();

    const h0 = heuristic(start[0], start[1], start[2], gx, gy, gz);
    open.push({ x: start[0], y: start[1], z: start[2], parent: null, g: 0, f: h0 });
    gScore.set(key(start[0], start[1], start[2]), 0);

    let iterations = 0;
    while (open.size > 0) {
        const current = open.pop();
        const ck = key(current.x, current.y, current.z);
        if (closed.has(ck)) continue; // stale duplicate from lazy deletion

        if (current.x === gx && current.y === gy && current.z === gz) return current;

        if (++iterations > maxIterations) return null;
        closed.add(ck);

        for (const step of actions(voxels, current.x, current.y, current.z)) {
            const nk = key(step.x, step.y, step.z);
            if (closed.has(nk)) continue;

            const g = current.g + step.cost;
            const prev = gScore.get(nk);
            if (prev !== undefined && g >= prev) continue;
            gScore.set(nk, g);

            const h = heuristic(step.x, step.y, step.z, gx, gy, gz);
            open.push({ x: step.x, y: step.y, z: step.z, parent: current, g, f: greedy ? h : g + h });
        }
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
 *  never shortcuts across an upward hop — a waypoint whose predecessor is
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

/** swept-box line-of-sight with gravity descent over a precomputed diagonal
 *  trace — the standard ground smoother. won't shortcut uphill. closes over the
 *  walkability test (use the same one the path was found with). */
export function groundShortcut(walkable: Walkable): Shortcut {
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
