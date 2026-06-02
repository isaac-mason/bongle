import type { Node } from './nodes';

/**
 * depth-first pre-order traversal of a node and all its descendants.
 *
 * the callback receives each node. return `false` to skip that node's
 * children (prune). return anything else (or nothing) to continue.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: may not return
export function traverse(node: Node, callback: (node: Node) => boolean | void): void {
    const result = callback(node);
    if (result === false) return;

    for (let i = 0; i < node.children.length; i++) {
        traverse(node.children[i], callback);
    }
}
