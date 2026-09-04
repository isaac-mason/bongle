/**
 * public transform api, setters/getters for local and world-space values.
 * operate directly on TransformTrait instances (no ctx needed).
 *
 * use setters (setPosition, setQuaternion, setScale, setTransform) to
 * write local-space values, they propagate dirty flags to descendants.
 *
 * use getters (getWorldPosition, getWorldQuaternion, getWorldScale,
 * getWorldMatrix) to read world-space values, they trigger lazy recompute
 * if the node or any ancestor is dirty.
 *
 * `worldToLocalPosition`/`worldToLocalQuaternion` are the inverse direction,
 * expressing a world-space value in a node's local frame.
 */

export {
    getVisualWorldMatrix,
    getVisualWorldPosition,
    getVisualWorldQuaternion,
    getVisualWorldScale,
    getWorldMatrix,
    getWorldPosition,
    getWorldQuaternion,
    getWorldScale,
    resetInterpolation,
    setInterpolation,
    setPosition,
    setQuaternion,
    setScale,
    setTransform,
    setWorldPosition,
    setWorldQuaternion,
    worldToLocalPosition,
    worldToLocalQuaternion,
} from '../builtins/transform';
