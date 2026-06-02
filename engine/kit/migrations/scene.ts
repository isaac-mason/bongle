// Latest on-disk scene schema version. Bump when you add a new branch
// below. The runtime in lib/engine/src/* assumes scenes are at this
// version — migrateScene guarantees that.
export const SCENE_LATEST = 1;

export function migrateScene(raw: unknown): Record<string, unknown> {
    let scene = (raw ?? {}) as Record<string, unknown>;
    const start = typeof scene.version === 'number' ? scene.version : 0;

    if (start > SCENE_LATEST) {
        throw new Error(
            `scene file at version ${start} is newer than SCENE_LATEST (${SCENE_LATEST}) — engine is out of date`,
        );
    }

    // 0 → 1: no-op placeholder. Proves the chain runs end to end.
    // Replace this branch's body with the real transform the first
    // time the scene schema actually changes.
    if (start < 1) {
        scene = { ...scene, version: 1 };
    }

    return scene;
}
