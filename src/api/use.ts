// module-scope mutation keeps use() impure so bundlers cannot drop the call
let _kept = 0;

/**
 * Keep a handle alive through bundler tree-shaking. If a game never
 * references a `block()`/`model()`/`sound()`/`tile()` handle in code (e.g.
 * blocks listed only in a scene's voxel palette), bundlers may drop the
 * declaration as dead code and its registration never runs.
 *
 * @example
 * import { use } from 'bongle';
 * import { blocks } from 'bongle/kit';
 * use(blocks.stone, blocks.dirt);
 */
export function use(..._handles: unknown[]): void {
    _kept++;
}
