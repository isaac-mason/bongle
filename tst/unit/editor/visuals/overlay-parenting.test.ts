import { Object3D, PerspectiveCamera, Scene } from 'gpucat';
import { describe, expect, it } from 'vitest';
import * as TransformControls from '../../../../src/editor/transform-controls';
import * as ChunkBoundsVisuals from '../../../../src/editor/visuals/chunk-bounds-visuals';
import * as GridVisuals from '../../../../src/editor/visuals/grid-visuals';
import * as PivotPoint from '../../../../src/editor/visuals/pivot-point';
import { createSelectionMeshState, disposeSelectionMeshState } from '../../../../src/editor/visuals/selection-mesh';
import * as Lines from '../../../../src/render/overlay/lines';
import * as Quads from '../../../../src/render/overlay/quads';

function visibilityByName(root: Object3D): Map<string, boolean> {
    const out = new Map<string, boolean>();
    root.traverse((o) => {
        if (o !== root) out.set(`${out.size}:${o.name}`, o.visible);
    });
    return out;
}

describe('editor overlay parenting', () => {
    it('every module attaches to the parent it is handed, and detaches on dispose', () => {
        const scene = new Scene();
        const root = new Object3D();
        scene.add(root);

        const grid = GridVisuals.init(root);
        const chunkBounds = ChunkBoundsVisuals.init(root);
        const pivot = PivotPoint.create(root);
        const selection = createSelectionMeshState(root);
        const lines = Lines.init(root, 16, 5);
        const quads = Quads.init(root, 16);

        expect(root.children.length).toBe(6);
        // nothing reached past the parent it was given.
        expect(scene.children).toEqual([root]);

        GridVisuals.dispose(grid);
        ChunkBoundsVisuals.dispose(chunkBounds);
        PivotPoint.dispose(pivot);
        disposeSelectionMeshState(selection);
        Lines.dispose(lines);
        Quads.dispose(quads);

        expect(root.children.length).toBe(0);
    });

    it('detaching the root hides everything and restores it unchanged', () => {
        const scene = new Scene();
        const root = new Object3D();
        scene.add(root);
        GridVisuals.init(root);
        PivotPoint.create(root);
        Lines.init(root, 16, 5);

        const before = visibilityByName(root);

        root.removeFromParent();
        expect(scene.children.length).toBe(0);

        scene.add(root);
        expect(scene.children).toEqual([root]);
        expect(visibilityByName(root)).toEqual(before);
    });

    it('the view gate leaves gizmo visibility to attach/detach', () => {
        const scene = new Scene();
        const root = new Object3D();
        scene.add(root);
        const gizmo = TransformControls.init(new PerspectiveCamera(50, 1, 0.1, 100));
        root.add(gizmo.root);

        TransformControls.attach(gizmo, new Object3D());
        expect(gizmo.root.visible).toBe(true);

        // attach/detach is the only writer of gizmo.root.visible, so a view swap
        // must not disturb it. the old gate cleared it and nothing set it back.
        root.removeFromParent();
        scene.add(root);
        expect(gizmo.root.visible).toBe(true);
    });
});
