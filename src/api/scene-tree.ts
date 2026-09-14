import { TransformTrait } from '../builtins/transform';
import type { Node, Realm, TraitHandle, TraitProps } from '../core/scene/scene-tree';
import * as SceneTree from '../core/scene/scene-tree';
import type { TraitBase } from '../core/scene/traits';

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
 * Clone a node for the visual scene: same as `cloneNode`, plus a `TransformTrait`
 * on the clone root so it can be positioned once attached. Reserve `cloneNode`
 * for non-visual duplication.
 *
 * @example
 * const instance = cloneModel(wizard.scene);
 * const hat = cloneModel(wizard.nodes.HatA);
 */
export function cloneModel(node: Node): Node {
    const clone = SceneTree.cloneNode(node);
    if (!SceneTree.getTrait(clone, TransformTrait)) {
        SceneTree.addTrait(clone, TransformTrait);
    }
    return clone;
}

/**
 * create a detached node (no parent, no scripts fired, not in queries).
 * attach with `addChild(parent, node)` to make it live; an id is allocated at
 * attach time (negative on the client, positive on the server).
 *
 * `realm` controls which side(s) the node lives on (default `'inherit'`,
 * resolving to the nearest ancestor's realm). Use `'server'` for nodes that
 * must never replicate, or `'client'` for purely local nodes.
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
