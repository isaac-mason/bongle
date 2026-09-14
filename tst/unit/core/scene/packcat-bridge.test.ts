import * as p from 'packcat';
import { describe, expect, it } from 'vitest';
import { registry } from '../../../../src/core/registry';
import { getControlCodecs, getSyncCodecs } from '../../../../src/core/scene/packcat-bridge';
import { prop } from '../../../../src/core/scene/prop';
import { createNode } from '../../../../src/core/scene/scene-tree';
import { buildTraitInstance, type TraitType } from '../../../../src/core/scene/traits';
import { trait } from '../../../../src/core/registry';
import { control, sync } from '../../../../src/core/registry';

const TEST_NODE = createNode({ name: 'test' });

/* ── test traits ── */

const Position = trait('bridge-test/position', {
    x: 0,
    y: 0,
    z: 0,
});
type Position = TraitType<typeof Position>;
for (const k of ['x', 'y', 'z'] as const) {
    control(Position, k, {
        schema: prop.number(),
        get: (t) => t[k],
        set: (t, v) => {
            t[k] = v;
        },
    });
    sync(Position, k, {
        schema: p.float32(),
        pack: (t) => t[k],
        unpack: (v, t) => {
            t[k] = v;
        },
    });
}

const Health = trait('bridge-test/health', {
    current: 100,
    max: 100,
});
type Health = TraitType<typeof Health>;
control(Health, 'current', {
    schema: prop.number(),
    get: (t) => t.current,
    set: (t, v) => {
        t.current = v;
    },
});
control(Health, 'max', {
    schema: prop.number(),
    get: (t) => t.max,
    set: (t, v) => {
        t.max = v;
    },
});
sync(Health, 'current', {
    schema: p.uint16(),
    pack: (t) => t.current,
    unpack: (v, t) => {
        t.current = v;
    },
});

const Tag = trait('bridge-test/tag');
void Tag;

const VecFields = trait('bridge-test/vec-fields', {
    position: [0, 0, 0] as [number, number, number],
    active: true,
    label: 'default',
});
type VecFields = TraitType<typeof VecFields>;
control(VecFields, 'position', {
    schema: prop.vec3(),
    get: (t) => t.position,
    set: (t, v) => {
        t.position = v;
    },
});
control(VecFields, 'active', {
    schema: prop.boolean(),
    get: (t) => t.active,
    set: (t, v) => {
        t.active = v;
    },
});
control(VecFields, 'label', {
    schema: prop.string(),
    get: (t) => t.label,
    set: (t, v) => {
        t.label = v;
    },
});

const SyncOnly = trait('bridge-test/sync-only', {
    linearVelocity: () => [0, 0, 0] as [number, number, number],
});
type SyncOnly = TraitType<typeof SyncOnly>;
sync(SyncOnly, 'linearVelocity', {
    schema: p.list(p.float32(), 3),
    pack: (t) => t.linearVelocity,
    unpack: (v, t) => {
        t.linearVelocity = v as [number, number, number];
    },
});

/* ── getSyncCodecs ── */

describe('getSyncCodecs', () => {
    it('builds per-sync codecs', () => {
        const handle = registry.traits.handles.get('bridge-test/position')!;
        const codecs = getSyncCodecs(handle);
        expect(codecs).not.toBeNull();
        expect(codecs!.length).toBe(3);

        const instance = buildTraitInstance(handle) as Position;
        instance.x = 1.5;

        const packed = codecs![0].pack(instance, TEST_NODE);
        expect(packed).toBeInstanceOf(Uint8Array);
        expect(packed.byteLength).toBeGreaterThan(0);

        const target = buildTraitInstance(handle) as Position;
        codecs![0].apply(packed, target);
        expect(target.x).toBeCloseTo(1.5, 2);
    });

    it('returns null for tag traits (no syncs)', () => {
        const handle = registry.traits.handles.get('bridge-test/tag')!;
        expect(getSyncCodecs(handle)).toBeNull();
    });

    it('handles sync-only fields (no control)', () => {
        const handle = registry.traits.handles.get('bridge-test/sync-only')!;
        const codecs = getSyncCodecs(handle);
        expect(codecs).not.toBeNull();
        expect(codecs!.length).toBe(1);

        const instance = buildTraitInstance(handle) as SyncOnly;
        instance.linearVelocity = [1.0, 2.0, 3.0];

        const packed = codecs![0].pack(instance, TEST_NODE);
        const target = buildTraitInstance(handle) as SyncOnly;
        codecs![0].apply(packed, target);
        expect(target.linearVelocity[0]).toBeCloseTo(1.0, 5);
        expect(target.linearVelocity[1]).toBeCloseTo(2.0, 5);
        expect(target.linearVelocity[2]).toBeCloseTo(3.0, 5);
    });

    it('uses the explicit sync schema (uint16) not control schema', () => {
        const handle = registry.traits.handles.get('bridge-test/health')!;
        const codecs = getSyncCodecs(handle)!;
        const instance = buildTraitInstance(handle) as Health;
        instance.current = 42;

        const packed = codecs[0].pack(instance, TEST_NODE);
        expect(packed.byteLength).toBe(2); // uint16
    });

    it('caches codecs across calls', () => {
        const handle = registry.traits.handles.get('bridge-test/position')!;
        const a = getSyncCodecs(handle);
        const b = getSyncCodecs(handle);
        expect(a).toBe(b);
    });

    it('binary comparison detects changes', () => {
        const handle = registry.traits.handles.get('bridge-test/position')!;
        const codecs = getSyncCodecs(handle)!;
        const instance = buildTraitInstance(handle) as Position;
        instance.x = 5;

        const snap1 = codecs[0].pack(instance, TEST_NODE);
        const snap2 = codecs[0].pack(instance, TEST_NODE);
        expect(buffersEqual(snap1, snap2)).toBe(true);

        instance.x = 99;
        const snap3 = codecs[0].pack(instance, TEST_NODE);
        expect(buffersEqual(snap1, snap3)).toBe(false);
    });
});

/* ── getControlCodecs ── */

describe('getControlCodecs', () => {
    it('builds per-control codecs', () => {
        const handle = registry.traits.handles.get('bridge-test/position')!;
        const codecs = getControlCodecs(handle);
        expect(codecs).not.toBeNull();
        expect(codecs!.length).toBe(3);
    });

    it('returns null for tag traits (no controls)', () => {
        const handle = registry.traits.handles.get('bridge-test/tag')!;
        expect(getControlCodecs(handle)).toBeNull();
    });

    it('handles vec3, boolean, string control schemas', () => {
        const handle = registry.traits.handles.get('bridge-test/vec-fields')!;
        const codecs = getControlCodecs(handle);
        expect(codecs).not.toBeNull();

        const instance = buildTraitInstance(handle) as VecFields;
        instance.position = [1, 2, 3];
        instance.active = false;
        instance.label = 'test';

        const target = buildTraitInstance(handle) as VecFields;
        codecs![0].apply(codecs![0].pack(instance, TEST_NODE), target);
        codecs![1].apply(codecs![1].pack(instance, TEST_NODE), target);
        codecs![2].apply(codecs![2].pack(instance, TEST_NODE), target);

        expect(target.position).toEqual([1, 2, 3]);
        expect(target.active).toBe(false);
        expect(target.label).toBe('test');
    });

    it('caches codecs across calls', () => {
        const handle = registry.traits.handles.get('bridge-test/position')!;
        const a = getControlCodecs(handle);
        const b = getControlCodecs(handle);
        expect(a).toBe(b);
    });
});

/* ── helpers ── */

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.byteLength !== b.byteLength) return false;
    for (let i = 0; i < a.byteLength; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}
