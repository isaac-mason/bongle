/**
 * project-module.test.ts — deterministic wire-index behavior.
 *
 * (a) smoke: traits + commands declared in non-alphabetical order surface
 *     sort-by-id wire indices on the active side. (one side suffices —
 *     both peers project from registry primitives via the same code path,
 *     so identical id sets ⇒ identical indices.)
 *
 * (b) HMR reshuffle: registering a new trait whose id sorts mid-table
 *     shifts the wire indices of existing entries on the next read, but
 *     the runtime slot on each trait — and therefore the `node._traits`
 *     key on any live instance — does not move.
 *
 * (c) stale snapshot decode: a snapshot packed under the pre-reshuffle
 *     wire indices and decoded under the post-reshuffle table silently
 *     mis-routes trait refs to the wrong def. characterizes the HMR
 *     drift race that task #43 (moduleVersion stamp / per-trait sanity
 *     byte) is intended to close.
 */

import { describe, expect, it } from 'vitest';
import { registry } from '../../src/core/registry';
import { CLIENT_TO_SERVER, command } from '../../src/core/rpc';
import { addChild, addTrait, createNode } from '../../src/core/scene/nodes';
import { pack } from '../../src/core/scene/pack';
import { packSceneGraph, unpackSceneGraph } from '../../src/core/scene/scene-pack';
import { trait } from '../../src/core/scene/traits';
import { createTestServer } from './server-integration-test';

/* ── module-scope declarations for test (a) ── */
const TraitAZ = trait('wire-test-a/z-late', { value: 0 });
const TraitAC = trait('wire-test-a/c-mid', { value: 0 });
const TraitAM = trait('wire-test-a/m-middle', { value: 0 });

const CmdAZ = command('wire-test-a/z-late', CLIENT_TO_SERVER, pack.object({ n: pack.varuint() }));
const CmdAC = command('wire-test-a/c-mid', CLIENT_TO_SERVER, pack.object({ n: pack.varuint() }));
const CmdAM = command('wire-test-a/m-middle', CLIENT_TO_SERVER, pack.object({ n: pack.varuint() }));

/* ── module-scope declarations for test (b) ── */
const TraitBC = trait('wire-test-b/c-mid', { value: 0 });
const TraitBM = trait('wire-test-b/m-middle', { value: 0 });

/* ── module-scope declarations for test (c) ── */
const TraitCM = trait('wire-test-c/m-middle', { value: 0 });

function entriesUnderPrefix(indexToId: readonly string[], prefix: string): string[] {
    return indexToId.filter((id) => id.startsWith(prefix));
}

describe('project-module — deterministic wire indices', () => {
    it('(a) trait + command wire indices are sort-by-id regardless of declaration order', () => {
        const server = createTestServer();

        const traits = entriesUnderPrefix(registry.traitWireIndex.indexToId, 'wire-test-a/');
        expect(traits).toEqual(['wire-test-a/c-mid', 'wire-test-a/m-middle', 'wire-test-a/z-late']);

        const commands = entriesUnderPrefix(registry.commandWireIndex.indexToId, 'wire-test-a/');
        expect(commands).toEqual(['wire-test-a/c-mid', 'wire-test-a/m-middle', 'wire-test-a/z-late']);

        for (let i = 0; i < registry.traitWireIndex.indexToId.length; i++) {
            const id = registry.traitWireIndex.indexToId[i];
            expect(registry.traitWireIndex.idToIndex.get(id)).toBe(i);
        }

        expect(TraitAZ._slot).not.toBe(TraitAC._slot);
        expect(TraitAC._slot).not.toBe(TraitAM._slot);

        expect(CmdAZ.id).toBe('wire-test-a/z-late');
        expect(CmdAC.id).toBe('wire-test-a/c-mid');
        expect(CmdAM.id).toBe('wire-test-a/m-middle');

        server.dispose();
    });

    it('(b) mid-session HMR reshuffles wire indices but preserves trait slots on live instances', () => {
        const server = createTestServer();

        const traitsBefore = entriesUnderPrefix(registry.traitWireIndex.indexToId, 'wire-test-b/');
        expect(traitsBefore).toEqual(['wire-test-b/c-mid', 'wire-test-b/m-middle']);
        const indexBefore = registry.traitWireIndex.idToIndex.get('wire-test-b/c-mid')!;

        // build a live node with TraitBC — capture its slot for later comparison
        const node = createNode({ name: 'persistent' });
        addChild(server.nodes.root, node);
        addTrait(node, TraitBC);
        const slotBefore = TraitBC._slot;
        expect(node._traits.has(slotBefore)).toBe(true);

        // simulate HMR re-eval: a new trait whose id sorts FIRST among our
        // b-prefix entries. `trait()` upserts into the registry, bumping the
        // traits store revision and invalidating the cached `traitWireIndex`.
        const TraitBA = trait('wire-test-b/a-earliest', { value: 0 });

        const traitsAfter = entriesUnderPrefix(registry.traitWireIndex.indexToId, 'wire-test-b/');
        expect(traitsAfter).toEqual(['wire-test-b/a-earliest', 'wire-test-b/c-mid', 'wire-test-b/m-middle']);
        expect(registry.traitWireIndex.idToIndex.get('wire-test-b/c-mid')!).toBe(indexBefore + 1);

        // but the runtime slot didn't move — the live node's trait is still
        // accessible at the same Map key.
        expect(TraitBC._slot).toBe(slotBefore);
        expect(TraitBA._slot).not.toBe(slotBefore);
        expect(node._traits.has(slotBefore)).toBe(true);
        expect(registry.traitsBySlot.get(slotBefore)?.id).toBe('wire-test-b/c-mid');

        expect(node._traits.has(TraitBM._slot) === false).toBe(true);
        expect(registry.traitsBySlot.get(TraitBM._slot)?.id).toBe('wire-test-b/m-middle');

        server.dispose();
    });

    it('(c) snapshot packed pre-reshuffle, decoded post-reshuffle mis-routes (motivates #43)', () => {
        const sender = createTestServer();

        const node = createNode({ name: 'snap', id: 7777, persist: false });
        addChild(sender.nodes.root, node);
        addTrait(node, TraitCM);

        const snapshot = packSceneGraph(sender.nodes, 'edit');
        const indexAtPack = registry.traitWireIndex.idToIndex.get('wire-test-c/m-middle');
        expect(indexAtPack).toBeDefined();

        // simulate the HMR drift race: a new trait sorts BEFORE m-middle so
        // m-middle's wire index shifts up by 1 on the next module refresh.
        trait('wire-test-c/b-prepended', { value: 0 });
        expect(registry.traitWireIndex.idToIndex.get('wire-test-c/m-middle')!).toBeGreaterThan(indexAtPack!);

        const receiver = createTestServer();

        unpackSceneGraph(receiver.nodes, receiver.runtime, snapshot);

        const decodedNode = receiver.nodes._idToNode.get(7777);
        expect(decodedNode).toBeDefined();

        const misroutedId = registry.traitWireIndex.indexToId[indexAtPack!];
        // documents the bug: the receiver believes the node has whatever
        // trait occupies the sender's old wire slot — NOT m-middle. When
        // ids happen to overlap (the common HMR case) we get silent
        // mis-routing; when they don't, decode no-ops via missing def.
        const misroutedDef = registry.traits.byId.get(misroutedId)?.payload;
        if (misroutedId !== 'wire-test-c/m-middle' && misroutedDef !== undefined) {
            expect(decodedNode!._traits.has(misroutedDef.slot)).toBe(true);
            expect(decodedNode!._traits.has(TraitCM._slot)).toBe(false);
        }

        sender.dispose();
        receiver.dispose();
    });
});
