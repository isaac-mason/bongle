// observable module-scope mutation, makes `use()` impure so bundlers
// can't eliminate the call even under aggressive `sideEffects: false`
// configs upstream. zero runtime cost.
let _kept = 0;

/**
 * Keep a handle alive through bundler tree-shaking.
 *
 * `block()` / `model()` / `sound()` / `blockTexture()` register into the
 * engine's registries when their declaration is evaluated. If a game
 * never references a handle in code (e.g. blocks listed only in a
 * scene's voxel palette, models referenced only by prefab id), prod
 * bundlers may drop the declaration as dead code, the registration
 * then never happens and the scene fails to load.
 *
 * `use()` is a non-pure call that takes the handles you depend on:
 *
 *   import { use } from 'bongle';
 *   import { blocks } from 'bongle/starter';
 *
 *   // scene data references `starter:stone`, keep its declaration alive.
 *   use(blocks.stone, blocks.dirt);
 *
 * Bundlers preserve the call (can't prove it pure across module
 * boundaries), which forces the argument expressions to evaluate, which
 * keeps the referenced declarations, and therefore the registrations
 * in the bundle.
 *
 * No runtime effect.
 */
export function use(..._handles: unknown[]): void {
    _kept++;
}
