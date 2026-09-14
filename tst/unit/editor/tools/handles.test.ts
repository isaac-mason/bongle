import { PerspectiveCamera, Scene } from 'gpucat';
import { type Vec3, vec3 } from 'math';
import { describe, expect, it } from 'vitest';
import { RigidBodyTrait } from '../../../../src/builtins/rigid-body';
import { computeWorldTransforms, TransformTrait } from '../../../../src/builtins/transform';
import { createMouseKeyboardInput } from '../../../../src/client/input';
import { control, registry, reindexRegistry, trait } from '../../../../src/core/registry';
import { prop } from '../../../../src/core/scene/prop';
import { addChild, addTrait, createNode, createSceneTree } from '../../../../src/core/scene/scene-tree';
import * as Selection from '../../../../src/core/scene/selection';
import type { EditRoomStoreApi } from '../../../../src/editor/edit-room-store';
import * as Handles from '../../../../src/editor/tools/handles';
import * as Quads from '../../../../src/render/overlay/quads';
import * as Text from '../../../../src/render/overlay/text';

const WIDTH = 800;
const HEIGHT = 600;

function project(camera: PerspectiveCamera, world: Vec3): { ndcX: number; ndcY: number } {
    const view = vec3.transformMat4([0, 0, 0], world, camera.matrixWorldInverse);
    const clip = vec3.transformMat4([0, 0, 0], view, camera.projectionMatrix);
    return { ndcX: clip[0], ndcY: clip[1] };
}

describe('shape handles', () => {
    it('clicking the frame dot of a transformed shape arms that frame and opens the transform tool', () => {
        reindexRegistry(registry);
        const sceneTree = createSceneTree();
        const node = createNode({ name: 'body' });
        addChild(sceneTree.root, node);
        addTrait(node, TransformTrait);
        const body = addTrait(node, RigidBodyTrait);
        body.def = {
            shape: { type: 'transformed', shape: { type: 'sphere', radius: 1 }, position: [2, 0, 0], quaternion: [0, 0, 0, 1] },
        };
        computeWorldTransforms(sceneTree);

        const camera = new PerspectiveCamera(Math.PI / 3, WIDTH / HEIGHT, 0.1, 100);
        camera.position[2] = 10;
        camera.lookAt([0, 0, 0]);
        camera.updateWorldMatrix();
        camera.updateViewMatrix();
        camera.updateProjectionMatrix();

        const writes: Record<string, unknown>[] = [];
        const state = {
            selection: Selection.ofNode(node.id),
            activeTool: 'inspect',
            transformMode: 'translate',
            translationSnap: 1,
            activeFrame: null,
        };
        const store = {
            getState: () => state,
            setState: (patch: Record<string, unknown>) => {
                writes.push(patch);
                Object.assign(state, patch);
            },
        } as unknown as EditRoomStoreApi;

        const scene = new Scene();
        const quads = Quads.init(scene, 64);
        const text = Text.init(quads);
        const handles = Handles.init();
        const mk = createMouseKeyboardInput();

        // frame 1: hover the frame dot at the item's origin, no press
        const { ndcX, ndcY } = project(camera, [2, 0, 0]);
        mk._cursor.ndcX = ndcX;
        mk._cursor.ndcY = ndcY;
        Handles.update(handles, true, mk, camera, WIDTH, HEIGHT, sceneTree, {} as never, store, quads, text);
        const kinds = handles.handles.map((h) => h.kind);
        expect(kinds).toContain('frame');
        expect(kinds).toContain('radius');
        expect(handles.hovered).not.toBe(-1);
        expect(handles.handles[handles.hovered]!.kind).toBe('frame');

        // frame 2: press
        mk._gestures.left.pressed = true;
        Handles.update(handles, true, mk, camera, WIDTH, HEIGHT, sceneTree, {} as never, store, quads, text);
        expect(state.activeFrame).toMatchObject({
            nodeId: node.id,
            traitId: 'rigidbody',
            controlId: 'def',
            position: 'position',
        });
        expect(state.activeTool).toBe('transform');
    });
});

describe('shape handles on a list of centred spheres', () => {
    it('a sphere with a center gets a frame dot that arms `center` for the gizmo', () => {
        const Sphere = prop.object(
            { center: prop.point(), radius: prop.radius() },
            { shape: { kind: 'sphere', radius: 'radius', center: 'center' } },
        );
        const ZonesTrait = trait('test-zones', { zones: [] as { center: [number, number, number]; radius: number }[] });
        control(ZonesTrait, 'zones', {
            label: 'Zones',
            schema: prop.list(Sphere),
            get: (t) => t.zones,
            set: (t, v) => {
                t.zones = v;
            },
        });
        reindexRegistry(registry);

        const sceneTree = createSceneTree();
        const node = createNode({ name: 'zones' });
        addChild(sceneTree.root, node);
        addTrait(node, TransformTrait);
        const zones = addTrait(node, ZonesTrait);
        zones.zones = [
            { center: [3, 0, 0], radius: 1 },
            { center: [-3, 0, 0], radius: 0.5 },
        ];
        computeWorldTransforms(sceneTree);

        const camera = new PerspectiveCamera(Math.PI / 3, WIDTH / HEIGHT, 0.1, 100);
        camera.position[2] = 12;
        camera.lookAt([0, 0, 0]);
        camera.updateWorldMatrix();
        camera.updateViewMatrix();
        camera.updateProjectionMatrix();

        const state = {
            selection: Selection.ofNode(node.id),
            activeTool: 'inspect',
            transformMode: 'translate',
            translationSnap: 1,
            activeFrame: null,
        };
        const store = {
            getState: () => state,
            setState: (patch: Record<string, unknown>) => Object.assign(state, patch),
        } as unknown as EditRoomStoreApi;
        const scene = new Scene();
        const quads = Quads.init(scene, 64);
        const text = Text.init(quads);
        const handles = Handles.init();
        const mk = createMouseKeyboardInput();

        const { ndcX, ndcY } = project(camera, [-3, 0, 0]);
        mk._cursor.ndcX = ndcX;
        mk._cursor.ndcY = ndcY;
        Handles.update(handles, true, mk, camera, WIDTH, HEIGHT, sceneTree, {} as never, store, quads, text);
        expect(handles.handles.filter((h) => h.kind === 'frame')).toHaveLength(2);
        expect(handles.handles.filter((h) => h.kind === 'radius')).toHaveLength(2);
        expect(handles.hovered).not.toBe(-1);
        expect(handles.handles[handles.hovered]!.kind).toBe('frame');

        mk._gestures.left.pressed = true;
        Handles.update(handles, true, mk, camera, WIDTH, HEIGHT, sceneTree, {} as never, store, quads, text);
        expect(state.activeFrame).toMatchObject({ traitId: 'test-zones', controlId: 'zones', path: [1], position: 'center' });
        expect(state.activeTool).toBe('transform');
    });
});
