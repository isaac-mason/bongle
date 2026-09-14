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
