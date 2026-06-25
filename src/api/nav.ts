/**
 * public navigation api — grid A* pathfinding + flood-fill reachability over the
 * voxel cells (see core/nav/voxel-nav).
 *
 * `findPath`/`floodFill` take a successor function (`Actions`) and return raw cells.
 * compose movement by passing `nav.groundActions` directly, wrapping it, or building
 * one with `gridActions`/`groundMoves`/`groundWalkable`. smoothing is explicit + opt-in.
 *
 * usage: `import { nav } from 'bongle'`
 *   nav.findPath(voxels, start, goal, nav.groundActions)              // every cell
 *   nav.smoothPath(voxels, path, nav.groundShortcut())               // opt-in steering
 *   nav.floodFill(voxels, start, nav.groundActions, maxIterations)   // reachability
 */

export * as nav from '../core/nav/voxel-nav';
