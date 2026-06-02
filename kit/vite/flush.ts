/**
 * kit/src/vite/flush.ts — public re-export of the engine's microtask-debounced
 * flush helpers, surfaced as `__kit.flush` / `__kit.registerFlush`.
 *
 * The runtime helpers live in `engine/src/core/capture/flush.ts` because the
 * bongle() plugin's transform injects calls into user code, which can only
 * import from `bongle/internal` (kit is a tooling package, not user-facing).
 * Re-exporting here keeps the file structure spec'd by the PLAN — kit/src/vite
 * holds both the plugin and its companion runtime helpers — without forking
 * the actual scheduler.
 *
 * Future: a Vite plugin-side hook (handleHotUpdate / hotUpdate) could send a
 * `vite:custom` event to fan-out a flush across envs. Not needed yet — each
 * env registers its own handler at boot and the per-module hot.accept already
 * triggers `__kit.flush()` in that env.
 */

export { __kit } from 'bongle/internal';
