import { type Box3, box3 } from 'mathcat';
import type { Node, TraitHandle, TraitProps } from '../core/scene/nodes';
import * as Nodes from '../core/scene/nodes';
import type { TraitBase } from '../core/scene/traits';
import { BoundsTrait } from '../builtins/bounds';
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

/**
 * clone a node and all its descendants. the returned subtree is **detached** —
 * attach with `addChild(parent, clone)` to wake it up.
 */
export function cloneNode(node: Node): Node {
    return Nodes.cloneNode(node);
}

/**
 * Clone a node intended for the **visual scene** — same as `cloneNode`, plus
 * a `BoundsTrait` (for Visibility cull) and a `ModelTrait` (shared light
 * slot for descendant meshes) installed on the clone root. Use this
 * for every cloneNode site that goes into the visible scene; reserve
 * `cloneNode` for non-visual subtree duplication (e.g. detached prefab data).
 *
 * Typical usage:
 * ```ts
 * const instance = cloneModel(wizard.scene, { aabb: wizard.aabb });
 * // or for a sub-mesh:
 * const hat = cloneModel(wizard.nodes.HatA, { aabb: wizard.meshes.HatA.aabb });
 * ```
 *
 * If the source already has a `BoundsTrait` (or `ModelTrait`), the existing
 * one is left in place — only missing traits are installed. BoundsTrait
 * `aabbLocal` (and `_seedAabb`) is set from `opts.aabb`, or left empty
 * when absent — Visibility treats empty AABBs as "not yet registered" and
 * any downstream producer (animator, script) can fill them in later.
 */
export function cloneModel(node: Node, opts?: { aabb?: Box3 }): Node {
    const clone = Nodes.cloneNode(node);

    if (!Nodes.getTrait(clone, BoundsTrait)) {
        const seed = opts?.aabb ?? box3.create();
        Nodes.addTrait(clone, BoundsTrait, {
            aabbLocal: box3.copy(box3.create(), seed),
            _seedAabb: box3.copy(box3.create(), seed),
            _version: 1,
        });
    }
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
