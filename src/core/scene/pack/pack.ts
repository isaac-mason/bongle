import * as packcat from 'packcat';

export * from 'packcat';

export const position = () => packcat.list(packcat.float32(), 3);
export const quaternion = () => packcat.list(packcat.float32(), 4);
export const scale = () => packcat.list(packcat.float32(), 3);
export const spherical = () => packcat.list(packcat.float32(), 3);

/**
 * Compound MeshId codec: length-prefixed modelId + meshName strings.
 * Nullable to match MeshTrait.meshId's null default.
 */
export const meshId = () =>
    packcat.nullable(
        packcat.object({
            modelId: packcat.string(),
            meshName: packcat.string(),
        }),
    );
