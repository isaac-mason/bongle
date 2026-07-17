// core/content/index.ts, runtime layer for authored content.
//
// "content" = data the user authors on disk (today: scenes; future: more
// authored types). pairs with `server/content-manager.ts`, which owns the
// disk I/O on the server side. cross-side: both server and client mutate
// scene handles as authored payloads arrive, at boot via the codegen
// `src/generated/scenes.ts` barrel, and live via the `bongle:scenes`
// vite plugin's HMR events routed through `applyScenePayload`.
//
// scene handles live on `module.scenes` (declared via `scene()` in user
// code), that's where the *deserialized* live form lives (Node tree, Voxels
// canvas). `Content` here caches the *serialized* form, the parsed
// `ScenePayload` last applied per scene id, kept as the authored-form-of-record.

import type { ScenePayload } from './scene-store';

export type Content = {
    /** last-applied parsed payload per declared scene id. */
    payloads: Map<string, ScenePayload>;
};

export function init(): Content {
    return { payloads: new Map() };
}

export type { ScenePayload } from './scene-store';
export { clearScene, populateScene } from './scene-store';
