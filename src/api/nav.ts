/**
 * public voxel navigation api.
 *
 * each navigation approach is its own flat namespace so they coexist without
 * name clashes (both expose `findPath`, etc.):
 *   - `voxelNav` — grid A* over the voxel cells (see core/nav/voxel-nav).
 *   - `meshNav` — mesh-based navigation (future, separate top-level namespace).
 *
 * usage: `import { voxelNav } from 'bongle'` → `voxelNav.findGroundPath(voxels,
 * start, goal)` for ground agents, or `voxelNav.findPath(voxels, start, goal,
 * actions)` with a custom successor function for other movement.
 */

export * as voxelNav from '../core/nav/voxel-nav';
