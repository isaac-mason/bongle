/**
 * Environment flags for conditional code.
 *
 * All flags are replaced at build time by the blocks-env Vite plugin with
 * true/false literals, enabling dead code elimination.
 *
 * - `env.client`, true in the client bundle, false in the server bundle.
 * - `env.server`, true in the server bundle, false in the client bundle.
 * - `env.editor`, true when the project was started with the editor (dev
 *   mode), false in production deploys. Editor-specific code (inspector UI,
 *   debug overlays, editor scripts) can be gated behind this flag and
 *   stripped in production builds.
 *
 * The asset pipeline does NOT use a flag, it's a separate engine entry
 * (`EngineAssetPipeline`), not a headless variant of the client. Its realm runs
 * NEUTRAL: all three flags stay false. Declarations register ungated, so the bake
 * sees the whole registry either way. The bake runs no behaviour: its icon rooms
 * instantiate no scripts and no systems, so a prefab icon shows only what its
 * apply places up front.
 *
 * Note: there is no `env.edit` or `env.play`. Mode is per-room and
 * available on the script context as `ctx.mode`.
 */
export const env = {
    client: false,
    server: false,
    editor: false,
};
