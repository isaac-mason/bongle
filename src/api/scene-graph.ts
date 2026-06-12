import type { Node, TraitHandle, TraitProps } from '../core/scene/nodes';
import * as Nodes from '../core/scene/nodes';
import type { TraitBase } from '../core/scene/traits';
import { ModelTrait } from '../builtins/model';

export type { Node } from '../core/scene/nodes';
export {
    addChild,
    findAncestor,
    findChildByName,
    findChildrenByName,
    getTrait,
    hasTrait,
    removeChild,
    replaceChildren,
} from '../core/scene/nodes';
export { traverse } from '../core/scene/traverse';

/**
 * clone a node and all its descendants. the returned subtree is **detached** —
 * attach with `addChild(parent, clone)` to wake it up.
 */
export function cloneNode(node: Node): Node {
    return Nodes.cloneNode(node);
}

/**
 * Clone a node intended for the **visual scene** — same as `cloneNode`, plus
 * a `ModelTrait` (the shared voxel-light slot for descendant meshes)
 * installed on the clone root. Use this for every cloneNode site that goes
 * into the visible scene; reserve `cloneNode` for non-visual subtree
 * duplication (e.g. detached prefab data).
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
 */
export function cloneModel(node: Node): Node {
    const clone = Nodes.cloneNode(node);
    if (!Nodes.getTrait(clone, ModelTrait)) {
        Nodes.addTrait(clone, ModelTrait);
    }
    return clone;
}

/**
 * create a new **detached** node — no parent, no scripts fired, not in queries.
 * attach with `addChild(parent, node)` to make it live; an id is allocated at
 * attach time (negative on the client, positive on the server).
 */
export function createNode(options?: { name?: string; persist?: boolean }): Node {
    return Nodes.createNode({ name: options?.name, persist: options?.persist });
}

/**
 * add a trait to a node. returns the new trait instance.
 */
export function addTrait<T extends TraitBase>(node: Node, traitHandle: TraitHandle<T>, props?: TraitProps<T>): T {
    return Nodes.addTrait(node, traitHandle, props);
}

/**
 * remove a trait from a node.
 */
export function removeTrait(node: Node, traitHandle: TraitHandle): void {
    Nodes.removeTrait(node, traitHandle);
}

/**
 * destroy a node and detach it from the scene.
 */
export function destroyNode(node: Node): void {
    if (node.nodes) {
        Nodes.destroyNode(node.nodes, node);
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
