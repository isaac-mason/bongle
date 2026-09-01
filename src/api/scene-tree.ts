import { type Box3, box3 } from 'math/shapes';
import { ModelTrait } from '../builtins/model';
import { TransformTrait } from '../builtins/transform';
import { unionSubtreeLocalAabb } from '../core/scene/node-aabb';
import type { Node, Realm, TraitHandle, TraitProps } from '../core/scene/scene-tree';
import * as SceneTree from '../core/scene/scene-tree';
import type { TraitBase } from '../core/scene/traits';

const _cloneBounds: Box3 = box3.create();

export type { Node, Realm } from '../core/scene/scene-tree';
export {
    addChild,
    findAncestor,
    findChildByName,
    findChildrenByName,
    getTrait,
    hasTrait,
    isLocalNode,
    removeChild,
    replaceChildren,
} from '../core/scene/scene-tree';
export { traverse } from '../core/scene/traverse';

/**
 * clone a node and all its descendants. the returned subtree is **detached**,
 * attach with `addChild(parent, clone)` to wake it up.
 */
export function cloneNode(node: Node): Node {
    return SceneTree.cloneNode(node);
}

/**
 * Clone a node intended for the **visual scene**, same as `cloneNode`, plus a
 * `ModelTrait` (a lighting group, one shared voxel-light value for every mesh
 * under the clone) installed on the clone root. Reserve `cloneNode` for
 * non-visual subtree duplication (e.g. detached prefab data), or for meshes you
 * want lit individually — a mesh outside any group renders fine and samples at
 * its own AABB centre.
 *
 * Typical usage:
 * ```ts
 * const instance = cloneModel(wizard.scene);
 * // or for a sub-mesh:
 * const hat = cloneModel(wizard.nodes.HatA);
 * ```
 *
 * Frustum culling is per-mesh and derived automatically by the renderer from
 * each mesh's own geometry, so there's nothing cull-related for the caller to
 * supply or maintain. If the source already has a `ModelTrait`, the existing
 * one is left in place.
 *
 * The new `ModelTrait`'s `lightOffset` is seeded to the centre of the clone's
 * own mesh AABBs, so voxel light samples from inside the model's body rather
 * than at its origin (which for a model authored standing on y=0 is the floor
 * block it sits on). Assign `lightOffset` afterwards to override it.
 *
 * The clone root is also guaranteed a `TransformTrait`: a bake omits it on an
 * identity-TRS, meshless root, but `ModelLighting` samples the `[ModelTrait,
 * TransformTrait]` pair each frame, so without one the group would silently
 * never be lit (stuck full-bright, `lightOffset` dead). An added identity
 * transform is faithful, that's exactly the TRS the bake elided.
 */
export function cloneModel(node: Node): Node {
    const clone = SceneTree.cloneNode(node);
    let model = SceneTree.getTrait(clone, ModelTrait);
    if (!model) {
        model = SceneTree.addTrait(clone, ModelTrait);
        box3.empty(_cloneBounds);
        if (unionSubtreeLocalAabb(clone, _cloneBounds)) box3.center(model.lightOffset, _cloneBounds);
    }
    if (!SceneTree.getTrait(clone, TransformTrait)) {
        SceneTree.addTrait(clone, TransformTrait);
    }
    return clone;
}

/**
 * create a new **detached** node, no parent, no scripts fired, not in queries.
 * attach with `addChild(parent, node)` to make it live; an id is allocated at
 * attach time (negative on the client, positive on the server).
 *
 * `realm` controls which side(s) the node lives on (default `'inherit'`, which
 * resolves to the nearest ancestor's realm, i.e. `'shared'` under the scene
 * root). Use `'server'` for server-only nodes that must never replicate, or
 * `'client'` for purely local client-side nodes.
 */
export function createNode(options?: { name?: string; persist?: boolean; realm?: Realm }): Node {
    return SceneTree.createNode({ name: options?.name, persist: options?.persist, realm: options?.realm });
}

/**
 * add a trait to a node. returns the new trait instance.
 */
export function addTrait<T extends TraitBase>(node: Node, traitHandle: TraitHandle<T>, props?: TraitProps<T>): T {
    return SceneTree.addTrait(node, traitHandle, props);
}

/**
 * remove a trait from a node.
 */
export function removeTrait(node: Node, traitHandle: TraitHandle): void {
    SceneTree.removeTrait(node, traitHandle);
}

/**
 * destroy a node and detach it from the scene.
 */
export function destroyNode(node: Node): void {
    if (node.scene) {
        SceneTree.destroyNode(node.scene, node);
    }
}

/**
 * depth-first search from `from` (inclusive) by node name.
 * returns the first matching node, or null if not found.
 */
export function findByName(from: Node, name: string): Node | null {
    const stack: Node[] = [from];
    while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.name === name) return node;
        for (let i = node.children.length - 1; i >= 0; i--) {
            stack.push(node.children[i]!);
        }
    }
    return null;
}
