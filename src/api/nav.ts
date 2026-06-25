/**
 * public navigation api — grid A* pathfinding + flood-fill reachability over the
 * voxel cells (see core/nav/voxel-nav).
 *
 * usage: `import { nav } from 'bongle'` → `nav.findGroundPath(voxels, start, goal)`
 * for ground agents, or `nav.findPath(voxels, start, goal, actions)` with a custom
 * successor function for other movement.
 */

export * as nav from '../core/nav/voxel-nav';
