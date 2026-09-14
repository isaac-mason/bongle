/**
 * public navigation api, grid A* pathfinding + flood-fill reachability over the
 * voxel cells (see core/nav).
 *
 * `findPath`/`floodFill` take a successor function (`Actions`) and return raw cells.
 * compose movement by passing `nav.groundActions` directly, wrapping it, or building
 * one with `gridActions`/`groundMoves`/`groundWalkable`. smoothing is explicit + opt-in.
 *
 * every result is CALLER-OWNED and passed as a required first `out` argument — a `Path` for
 * routes, a `Flood` for reachability. both hold `cells` + `count` and pool their storage, so a
 * warmed-up caller allocates nothing per query and every allocation is visible at the call site.
 *
 * a flood is self-contained: it carries the BFS tree that found it AND a coord map over it, so
 * a destination picked out of one comes with its route already known — no second search, and no
 * way for it to fail on a cell the flood reached. two agents can hold their own, and neither
 * disturbs the other or A*.
 *
 * usage: `import { nav } from 'bongle'`
 *   const path = nav.createPath();                                    // once, then reused
 *   nav.findPath(path, voxels, start, goal, nav.groundActions)        // → boolean
 *   nav.smoothPath(smoothed, voxels, path, nav.groundShortcut())      // opt-in steering
 *
 *   const flood = nav.createFlood();                                  // once, then reused
 *   nav.floodFill(flood, voxels, start, nav.groundActions, 128)       // reachability
 *   nav.floodReached(flood, x, y, z)                                  // can I get there?
 *   nav.floodPath(path, flood, i)                                     // free: no search
 */

export * as nav from '../core/nav';
