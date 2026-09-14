/** on-disk scene schema version. bump when adding a migration branch below. */
export const SCENE_LATEST = 1;

export function migrateScene(raw: unknown): Record<string, unknown> {
    let scene = (raw ?? {}) as Record<string, unknown>;
    const start = typeof scene.version === 'number' ? scene.version : 0;

    if (start > SCENE_LATEST) {
        throw new Error(`scene file at version ${start} is newer than SCENE_LATEST (${SCENE_LATEST}) — engine is out of date`);
    }

    // 0 -> 1: no-op, no schema change yet.
    if (start < 1) {
        scene = { ...scene, version: 1 };
    }

    return scene;
}
