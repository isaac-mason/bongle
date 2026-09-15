import type { JsonValue } from 'bongle/interface';
import type { Vec3 } from 'math';
import { create, type StoreApi, useStore } from 'zustand';
import { getWorldPosition, getWorldQuaternion, TransformTrait } from '../builtins/transform';
import { isStandaloneBuild, startStandaloneRoom } from '../client/client';
import * as Net from '../client/net';
import type { ClientRoom } from '../client/rooms';
import type { PropPath } from '../core/scene/prop/path';
import type { PrefabConfig, Realm } from '../core/scene/scene-tree';
import { getTrait } from '../core/scene/scene-tree';
import { EDITOR_JOIN_KEY, type ScriptContext, send } from '../core/scene/scripts';
import * as Selection from '../core/scene/selection';
import { env } from '../env';
import * as Actions from './actions';
import * as Blueprint from './blueprint';
import { focusNode as focusCamera } from './camera';
import { type ClipboardHandlers, copySelectionToSystemClipboard, writeBlueprintToSystemClipboard } from './clipboard';
import { DeleteSceneCommand, OpenSceneCommand, RenameSceneCommand, SaveBlueprintCommand, SaveSceneCommand } from './commands';
import { useEditor } from './editor-store';
import type { HotbarSlot } from './inventory';
import type { Mask } from './scene/mask';
import type { Pattern } from './scene/pattern';
import type { BrushShape } from './scene/shapes';
import { playBulkEdit, playStructuralEdit } from './sounds';
import type { PivotPreset, PlacementTool } from './tools/placement';
import * as Placement from './tools/placement';
import type { Rgba } from './visuals/editor-colors';
import { commitVoxelOps } from './voxel-edit';

export type ControlMode = 'fly' | 'orbit' | 'character';

export type EditorTool =
    | 'inspect'
    | 'transform'
    | 'box-select'
    | 'magic-select'
    | 'lasso-select'
    | 'brush-select'
    | 'build'
    | 'paint'
    | 'brush'
    | 'smooth'
    | 'elevation';

export type SelectorMode = 'laser' | 'air';

export type TransformMode = 'translate' | 'rotate' | 'scale' | 'place' | 'grab';
export type TransformSpace = 'world' | 'local';

/** where a node origin lands on the block grid: the centre of a block's top face, the centre of a block, or a grid corner. */
export type SnapTo = 'face-top-center' | 'block-center' | 'corner';

export type SelectTarget = 'all' | 'nodes' | 'voxels';

export type SelectionBehavior = 'replace' | 'add';

export type MagicSelectCompare = 'block' | 'blockstate' | 'solid' | 'any';

/** undo/redo stack entry; `do` runs on initial dispatch and on redo, `undo` reverses it. */
export type Action = {
    label: string;
    do: () => void;
    undo: () => void;
};

const MAX_UNDO = 100;

export type MagicSelectOptions = {
    compareType: MagicSelectCompare;
    limit: number;
    range: number;
    surfaceOnly: boolean;
    up: boolean;
    down: boolean;
    horizontal: boolean;
    corners: boolean;
};

export type LassoSelectOptions = {
    /** depth in blocks behind the front-most hit voxel (1 = thin shell). */
    depth: number;
    /** max ray distance in blocks. */
    maxDistance: number;
};

/** raise extends the top block upward, lower clears top blocks to air, flatten drags every column under the disc toward the click y. */
export type ElevationMode = 'raise' | 'lower' | 'flatten';
export type ElevationFalloff = 'linear' | 'cosine' | 'sharp';

/** loaded grayscale heightmap. luminance is row-major, normalised to [0,1]. */
export type ElevationImage = {
    name: string;
    width: number;
    height: number;
    luminance: Float32Array;
};

export type ElevationOptions = {
    /** disc radius in voxels. */
    size: number;
    /** ± band from the stroke's starting y. raise/lower stop at this band edge. */
    yLimit: number;
    mode: ElevationMode;
    /** single-mode: blocks at center per click. continuous: nominal blocks at center. */
    amount: number;
    /** continuous-only. blocks/sec at center under full falloff/image weight. */
    rate: number;
    falloff: ElevationFalloff;
    applyMode: 'single' | 'continuous';
    /** optional grayscale image, luminance scales the per-cell delta. */
    heightmap: ElevationImage | null;
    heightmapError: string | null;
    /** null = extend the column's existing top block. */
    pattern: Pattern | null;
    patternText: string;
    patternError: string | null;
    /** null = no restriction; sampled at the topmost cell in the y band. */
    mask: Mask | null;
    maskText: string;
    maskError: string | null;
};

/** each iteration runs a 5x5 gaussian pass over per-column top-block heights, then raises/lowers columns to match. */
export type SmoothOptions = {
    shape: BrushShape;
    size: number;
    height: number;
    iterations: number;
    /** null = any non-air block counts as surface. */
    heightmapMask: Mask | null;
    heightmapMaskText: string;
    heightmapMaskError: string | null;
};

/** `patternText`/`maskText` are the raw editor strings; on a parse error the parsed field keeps its last good value. */
export type BrushOptions = {
    shape: BrushShape;
    /** voxel radius from the centre cell (0 = single voxel). */
    size: number;
    /** total vertical extent for cylinder; ignored for other shapes. */
    height: number;
    pattern: Pattern;
    patternText: string;
    patternError: string | null;
    /** null = no mask filtering. */
    mask: Mask | null;
    maskText: string;
    maskError: string | null;
};

/** mirrors the brush rasteriser but selects voxels instead of placing them, so no pattern. */
export type BrushSelectOptions = {
    shape: BrushShape;
    /** voxel radius from the centre cell (0 = single voxel). */
    size: number;
    /** total vertical extent for cylinder; ignored for other shapes. */
    height: number;
    /** null = no mask filtering (whole footprint selected). */
    mask: Mask | null;
    maskText: string;
    maskError: string | null;
};

/** shares BrushOptions' shape; kept as its own store field so each tool remembers its own size/shape. */
export type PaintOptions = BrushOptions;

/** in-progress box-select corner state; previewB tracks the cursor until mouseup folds the box into `selection`. */
export type BoxSelectState = {
    cornerA: [number, number, number];
    previewB: [number, number, number] | null;
    locked: boolean;
};

/** in-progress lasso freeform stroke: continuously-unwrapped `[theta, phi]` aim-angle pairs (see
 *  lasso-select.ts) rather than screen or world points, so a stroke traced while turning your
 *  view — even past a full turn — stays one coherent shape instead of breaking at any single
 *  camera's edge. */
export type LassoState = {
    points: ReadonlyArray<readonly [number, number]>;
};

export type InspectedBlock = { wx: number; wy: number; wz: number; key: string };

/** the pose inside a control value the gizmo drives instead of the node. */
export type ActiveFrame = {
    nodeId: number;
    traitId: string;
    controlId: string;
    path: PropPath;
};

export type EditRoomState = {
    activeTool: EditorTool;

    transformMode: TransformMode;
    transformSpace: TransformSpace;
    translationSnap: number | null;
    rotationSnap: number | null;
    scaleSnap: number | null;
    snapTo: SnapTo;
    /** where the gizmo sits on a selection: its origin / centroid, or the min or max corner of its bounds. */
    selectionPivot: PivotPreset;
    transformPivotOffset: Vec3;
    placementActive: boolean;
    placementIsNodeOnly: boolean;
    transformHasVoxels: boolean;

    /** never null (empty = Selection.create()); tools assign a fresh ref on each mutation as the zustand re-render signal. */
    selection: Selection.Selection;
    /** a frame-annotated object inside a control of the active node; the transform gizmo attaches at its pose. */
    activeFrame: ActiveFrame | null;
    /** nodes created from a voxel selection whose shape is fitted once they land; drained every frame. */
    pendingShapeFits: Actions.PendingShapeFit[];
    /** the prefab picker for "create from selection", at the viewport position it was asked from. */
    promotePicker: { x: number; y: number } | null;
    /** sparse bitset visualised as the brush overlay; null when nothing is shown. */
    brush: Selection.Selection | null;
    /** null = default cyan. selection-mesh dirty-checks by reference, so a fresh tuple each frame animates. */
    brushFill: Rgba | null;
    /** brush edge rgba, same semantics as brushFill. */
    brushEdges: Rgba | null;
    /** voxel currently under the cursor, drives brush (idle) + hover outline. */
    hoverVoxel: [number, number, number] | null;
    hoverNormal: [number, number, number] | null;
    hoverPoint: [number, number, number] | null;
    /** [x0,y0,z0,x1,y1,z1]. unit cube for cube blocks; tight union of collider AABBs for non-cube blocks. */
    hoverAabb: [number, number, number, number, number, number] | null;
    /** the node a click would select right now; drives the hover outline. */
    hoverNodeId: number | null;
    /** in-progress box-select (corner A placed, aiming for corner B). */
    boxSelect: BoxSelectState | undefined;
    lasso: LassoState | null;
    /** keyboard cursor for selection tools (arrow keys / [ / ]). */
    cursor: [number, number, number] | null;
    /** last hovered voxel, persists after clear, for paste placement origin. */
    lastHoverVoxel: [number, number, number] | null;
    /** last-clicked voxel info shown in the inspector. two independent writers, deliberately: the
     *  subscription below derives it from `selection` (so a single-voxel selection from any tool
     *  still shows its properties), and the inspect tool's plain click sets it directly, WITHOUT
     *  touching `selection` — inspecting a block is not the same action as selecting one, and
     *  shouldn't disturb whatever's actually selected. */
    inspectedVoxel: { wx: number; wy: number; wz: number } | null;
    /** the inspected voxel's chunk version, mirrored per frame so the panel re-reads after any edit, local or remote. */
    voxelRevision: number;

    selectionBehavior: SelectionBehavior;
    selectTarget: SelectTarget;
    selectorMode: SelectorMode;
    airDistance: number;
    magicSelectOptions: MagicSelectOptions;
    lassoOptions: LassoSelectOptions;
    brushSelectOptions: BrushSelectOptions;

    brushOptions: BrushOptions;

    paintOptions: PaintOptions;

    smoothOptions: SmoothOptions;

    elevationOptions: ElevationOptions;

    /** when non-null, the ViewportContextMenu opens anchored at these canvas-pixel coords. */
    /** `world` is the surface point under the cursor when the menu opened on a block. */
    /** `radial` distinguishes the hold-RMB pointer-locked radial menu (x/y is the viewport centre)
     *  from the click-triggered dropdown (x/y is the cursor); same entries either way. */
    /** `viewportContextMenu.radial` is the single source of truth for whether the radial menu is
     *  open — both the input side (`updateRadialMenu`, tools/inspect.ts) and the render side
     *  (`RadialMenu`, ui/radial-menu.tsx) key off it directly rather than each tracking their own
     *  "is it open" flag, so the two can't drift out of lockstep. */
    viewportContextMenu: { x: number; y: number; world: Vec3 | null; block: InspectedBlock | null; radial: boolean } | null;
    /** the radial menu's virtual stick: `dirX`/`dirY` a unit vector (0,0 at rest), `mag` 0..1 how
     *  far it's been pushed (clamped), `hover` the wedge that resolves to, null in the dead zone. */
    radialPointer: { hover: number | null; dirX: number; dirY: number; mag: number } | null;
    /** the add-trait picker, at client coordinates so it opens at either the viewport or hierarchy menu. */
    traitPicker: { nodeId: number; clientX: number; clientY: number } | null;

    activeBlueprint: Blueprint.Blueprint | null;
    /** last few copies/cuts, most recent first, capped at CLIPBOARD_HISTORY_CAP. paste (Ctrl+V)
     *  doesn't add to this — only capturing something new does. */
    clipboardHistory: readonly Blueprint.Blueprint[];

    // hotbar contents stay global
    activeSlotIndex: number;
    libraryOpen: boolean;
    carriedItem: HotbarSlot;
    hoveredInventoryItem: HotbarSlot;
    placementContinuous: boolean;

    controlMode: ControlMode;
    flySpeed: number | null;
    flySpeedShownAt: number;
    /** copy/cut/paste handlers for this room's editor; the page-level listeners dispatch to the active room's. */
    clipboard: ClipboardHandlers | null;

    undoStack: Action[];
    redoStack: Action[];

    /** mirror of `scene.replication.versionCounter`, projected each frame; subscribed by inspector/hierarchy to re-derive their views. */
    sceneRevision: number;

    play: () => void;
    openScene: (sceneId: string) => void;
    renameScene: (oldSceneId: string, newSceneId: string) => void;
    deleteScene: (sceneId: string) => void;
    /** persists this room now (Ctrl+S, the tab menu). */
    save: () => void;
    undo: () => void;
    redo: () => void;
    /** runs `do()` immediately, pushes onto undoStack, clears redoStack. */
    action: (a: Action) => void;
    /** resets selection.chunks but keeps selection.nodes intact. */
    clearVoxelSelection: () => void;

    createNode: (parentId: number, index: number, name?: string) => void;
    destroyNode: (nodeId: number) => void;
    setName: (nodeId: number, name: string | undefined) => void;
    setRealm: (nodeId: number, realm: Realm) => void;
    reparentNode: (nodeId: number, parentId: number, index: number) => void;
    reorderNode: (nodeId: number, index: number) => void;
    setTrait: (nodeId: number, traitId: string, props: Record<string, unknown>) => void;
    addTrait: (nodeId: number, traitId: string) => void;
    removeTrait: (nodeId: number, traitId: string) => void;
    setPrefab: (nodeId: number, config: PrefabConfig) => void;
    clearPrefab: (nodeId: number) => void;
    bakePrefab: (nodeId: number) => void;

    selectNode: (nodeId: number | null) => void;
    addToSelection: (nodeId: number) => void;
    removeFromSelection: (nodeId: number) => void;
    setSelection: (nodeIds: Iterable<number>) => void;
    /** drops the nodes, keeps the voxels. */
    clearNodeSelection: () => void;
    /** drops everything. */
    clearSelection: () => void;
    /** installs a selection a tool built through `Selection` transitions; the only way in from outside the store. */
    replaceSelection: (selection: Selection.Selection) => void;
    focusNode: (nodeId: number) => void;
    copyToClipboard: () => void;
    /** saves the current selection as a persistent blueprint scene; omitted name allocates `blueprint-NNN`. */
    saveBlueprint: (name?: string) => void;
    destroySelectedNodes: () => void;
    openViewportContextMenu: (x: number, y: number, world?: Vec3 | null, block?: InspectedBlock | null, radial?: boolean) => void;
    setRadialPointer: (pointer: EditRoomState['radialPointer']) => void;
    setTraitPicker: (picker: { nodeId: number; clientX: number; clientY: number } | null) => void;
    /** the inspect tool's own writer; see the field's own doc comment for how this coexists with the selection-derived subscription. */
    setInspectedVoxel: (voxel: EditRoomState['inspectedVoxel']) => void;
    /** a bare transform node at a world position under the scene root. */
    createNodeAt: (position: Vec3, name?: string) => void;
    closeViewportContextMenu: () => void;

    fill: (pattern: Pattern, mask?: Mask) => number;
    delete: () => void;
    replace: (pattern: Pattern, from?: Mask) => number;
    overlay: (pattern: Pattern) => number;
    pick: () => void;
    /** cuts the selection into a placement ghost; returns the blueprint (for the clipboard) or null when nothing is selected. */
    cutMove: (continuous?: boolean) => Blueprint.Blueprint | null;
    /** re-arms a past clipboard-history entry as `activeBlueprint` and starts placing it, exactly
     *  like Ctrl+V does for the current one. no-ops if a placement is already in progress. */
    pasteFromHistory: (id: number) => void;
    /** puts a past clipboard-history entry back on the system clipboard (so Ctrl+V, here or
     *  anywhere else, picks it up) and arms it, without reordering the history itself. */
    copyHistoryToClipboard: (id: number) => void;
    /** positive = CW looking down the positive axis. not undoable, clipboard ops don't touch the world. */
    rotate: (yawTurns: number, pitchTurns: number, rollTurns: number) => boolean;
    /** mirrors the active blueprint (and live placement preview) across the plane perpendicular to `axis`. not undoable. */
    flip: (axis: 'x' | 'y' | 'z') => boolean;
    setBlock: (wx: number, wy: number, wz: number, key: string) => void;
    setPlacementPivotPreset: (preset: PivotPreset) => void;

    setActiveTool: (tool: EditorTool) => void;
    setTransformMode: (mode: TransformMode) => void;
    setTransformSpace: (space: TransformSpace) => void;
    setTranslationSnap: (snap: number | null) => void;
    setRotationSnap: (snap: number | null) => void;
    setScaleSnap: (snap: number | null) => void;
    setSnapTo: (snap: SnapTo) => void;
    setSelectionPivot: (preset: PivotPreset) => void;
    setTransformPivotOffset: (offset: Vec3) => void;
    setControlMode: (mode: ControlMode) => void;
    setSelectionBehavior: (mode: SelectionBehavior) => void;
    setActiveFrame: (frame: ActiveFrame | null) => void;
    setPromotePicker: (at: { x: number; y: number } | null) => void;
    /** a prefab node at the voxel selection's centre, its first shape field sized to the selection. */
    createFromSelection: (prefabId: string) => void;
    /** moves the node to the voxel selection's centre and sizes its first shape field to it. */
    fitToSelection: (nodeId: number) => void;
    /** replaces the voxel selection with the voxels inside the node's first shape field. */
    selectInside: (nodeId: number) => void;
    setSelectTarget: (filter: SelectTarget) => void;
    setSelectorMode: (mode: SelectorMode) => void;
    setAirDistance: (d: number) => void;
    setMagicSelectOptions: (opts: Partial<MagicSelectOptions>) => void;
    setLassoOptions: (opts: Partial<LassoSelectOptions>) => void;
    setBrushSelectOptions: (opts: Partial<BrushSelectOptions>) => void;
    setBrushOptions: (opts: Partial<BrushOptions>) => void;
    setPaintOptions: (opts: Partial<PaintOptions>) => void;
    setSmoothOptions: (opts: Partial<SmoothOptions>) => void;
    setElevationOptions: (opts: Partial<ElevationOptions>) => void;

    setActiveSlot: (index: number) => void;
    cycleActiveSlot: (delta: number) => void;
    toggleLibrary: () => void;
    setLibraryOpen: (open: boolean) => void;
    setCarriedItem: (item: HotbarSlot) => void;
    setHoveredInventoryItem: (item: HotbarSlot) => void;
    setPlacementContinuous: (continuous: boolean) => void;
};

export type EditRoomStoreApi = StoreApi<EditRoomState>;

export type EditRoomStoreRefs = {
    ctx: ScriptContext;
    room: ClientRoom;
    placement: PlacementTool;
};

const HOTBAR_SIZE = 9;

/** how many past copies/cuts the clipboard indicator's history keeps, most recent first. */
export const CLIPBOARD_HISTORY_CAP = 8;

function initialFields() {
    return {
        activeTool: 'inspect' as EditorTool,
        transformMode: 'translate' as TransformMode,
        transformSpace: 'world' as TransformSpace,
        translationSnap: 1 as number | null,
        rotationSnap: 45 as number | null,
        scaleSnap: null as number | null,
        snapTo: 'face-top-center' as SnapTo,
        selectionPivot: 'center' as PivotPreset,
        transformPivotOffset: [0, 0, 0] as Vec3,
        placementActive: false,
        placementIsNodeOnly: false,
        transformHasVoxels: false,

        selection: Selection.create(),
        activeFrame: null as ActiveFrame | null,
        pendingShapeFits: [] as Actions.PendingShapeFit[],
        promotePicker: null as { x: number; y: number } | null,
        brush: null as Selection.Selection | null,
        brushFill: null as Rgba | null,
        brushEdges: null as Rgba | null,
        hoverVoxel: null as [number, number, number] | null,
        hoverNormal: null as [number, number, number] | null,
        hoverPoint: null as [number, number, number] | null,
        hoverAabb: null as [number, number, number, number, number, number] | null,
        hoverNodeId: null as number | null,
        boxSelect: undefined as BoxSelectState | undefined,
        lasso: null as LassoState | null,
        cursor: null as [number, number, number] | null,
        lastHoverVoxel: null as [number, number, number] | null,
        inspectedVoxel: null as EditRoomState['inspectedVoxel'],
        voxelRevision: 0,

        selectionBehavior: 'replace' as SelectionBehavior,
        selectTarget: 'all' as SelectTarget,
        selectorMode: 'laser' as SelectorMode,
        airDistance: 5,
        magicSelectOptions: {
            compareType: 'block' as MagicSelectCompare,
            limit: 1000,
            range: 1,
            surfaceOnly: false,
            up: true,
            down: true,
            horizontal: true,
            corners: false,
        },
        lassoOptions: { depth: 1, maxDistance: 256 } as LassoSelectOptions,
        brushSelectOptions: {
            shape: 'sphere',
            size: 3,
            height: 1,
            mask: null,
            maskText: '',
            maskError: null,
        } as BrushSelectOptions,
        brushOptions: {
            shape: 'sphere',
            size: 3,
            height: 1,
            pattern: { kind: 'active' },
            patternText: '$active',
            patternError: null,
            mask: null,
            maskText: '',
            maskError: null,
        } as BrushOptions,
        paintOptions: {
            shape: 'sphere',
            // size 0 = the classic 1-voxel paint behaviour.
            size: 0,
            height: 1,
            pattern: { kind: 'active' },
            patternText: '$active',
            patternError: null,
            mask: null,
            maskText: '',
            maskError: null,
        } as PaintOptions,
        smoothOptions: {
            shape: 'sphere',
            size: 5,
            height: 1,
            iterations: 1,
            heightmapMask: null,
            heightmapMaskText: '',
            heightmapMaskError: null,
        } as SmoothOptions,
        elevationOptions: {
            size: 10,
            yLimit: 10,
            mode: 'raise',
            amount: 1,
            rate: 10,
            falloff: 'cosine',
            applyMode: 'continuous',
            heightmap: null,
            heightmapError: null,
            pattern: null,
            patternText: '',
            patternError: null,
            mask: null,
            maskText: '',
            maskError: null,
        } as ElevationOptions,

        viewportContextMenu: null as EditRoomState['viewportContextMenu'],
        radialPointer: null as EditRoomState['radialPointer'],
        traitPicker: null as EditRoomState['traitPicker'],

        activeBlueprint: null as EditRoomState['activeBlueprint'],
        clipboardHistory: [] as Blueprint.Blueprint[],

        activeSlotIndex: 0,
        libraryOpen: false,
        carriedItem: null as HotbarSlot,
        hoveredInventoryItem: null as HotbarSlot,
        placementContinuous: false,

        // character is the default: it's the mode a new/keyboard-and-mouse-unfamiliar user
        // already understands (walk with WASD, look with the mouse), and it also just works on
        // touch, unlike fly which is pointer-lock-only and inert there.
        controlMode: 'character' as ControlMode,
        flySpeed: null as number | null,
        flySpeedShownAt: 0,
        clipboard: null,

        undoStack: [] as Action[],
        redoStack: [] as Action[],

        sceneRevision: 0,
    };
}

export function createEditRoomStore(refs: EditRoomStoreRefs): EditRoomStoreApi {
    const { ctx, room, placement } = refs;
    // actions need the StoreApi to read/write fresh state, but create() only provides set/get inside the factory.
    let api: EditRoomStoreApi;

    const store = create<EditRoomState>((set, get) => ({
        ...initialFields(),

        play: () => {
            // play request is pending until `setRoomMode` clears it when the room activates; ignore repeats.
            if (useEditor.getState().playPending) return;
            useEditor.getState().setPlayPending(true);
            const state = ctx.client!.state!;

            // a standalone game has no server to preview against, so spawn a client-only local room instead.
            if (isStandaloneBuild()) {
                startStandaloneRoom(state, room.sceneId);
                return;
            }

            const net = state.net;
            // rides the editor's current viewpoint along as join data so games can opt in to "play from here".
            const joinData: Record<string, JsonValue> = {};
            const cameraTransform = getTrait(room.client.camera, TransformTrait);
            if (cameraTransform) {
                const p = getWorldPosition(cameraTransform);
                const q = getWorldQuaternion(cameraTransform);
                joinData[EDITOR_JOIN_KEY] = {
                    position: [p[0], p[1], p[2]],
                    quaternion: [q[0], q[1], q[2], q[3]],
                };
            }
            // the play room boots from the scene store; save first so it forks from current edits.
            send(ctx, SaveSceneCommand, { sceneId: room.sceneId });
            Net.send(net, {
                type: 'play',
                sceneId: room.sceneId,
                sourceRoomId: room.roomId,
                options: '{}',
                joinData: JSON.stringify(joinData),
            });
        },
        openScene: (sceneId) => send(ctx, OpenSceneCommand, { sceneId }),
        renameScene: (oldSceneId, newSceneId) => send(ctx, RenameSceneCommand, { oldSceneId, newSceneId }),
        deleteScene: (sceneId) => send(ctx, DeleteSceneCommand, { sceneId }),
        save: () => send(ctx, SaveSceneCommand, { sceneId: room.sceneId }),
        undo: () => {
            const stack = get().undoStack;
            const a = stack[stack.length - 1];
            if (!a) return;
            a.undo();
            set((s) => ({
                undoStack: s.undoStack.slice(0, -1),
                redoStack: [...s.redoStack, a],
            }));
        },
        redo: () => {
            const stack = get().redoStack;
            const a = stack[stack.length - 1];
            if (!a) return;
            a.do();
            set((s) => ({
                redoStack: s.redoStack.slice(0, -1),
                undoStack: [...s.undoStack, a],
            }));
        },
        action: (a) => {
            a.do();
            set((s) => {
                const next = [...s.undoStack, a];
                return {
                    undoStack: next.length > MAX_UNDO ? next.slice(next.length - MAX_UNDO) : next,
                    redoStack: [],
                };
            });
        },
        clearVoxelSelection: () => set({ selection: Selection.nodesOnly(get().selection) }),

        createNode: (parentId, index, name) => Actions.createNodeAction(ctx, parentId, index, name),
        destroyNode: (nodeId) => Actions.destroyNodeAction(get(), ctx, nodeId),
        setName: (nodeId, name) => Actions.setNameAction(get(), ctx, nodeId, name),
        setRealm: (nodeId, realm) => Actions.setRealmAction(get(), ctx, nodeId, realm),
        reparentNode: (nodeId, parentId, index) => Actions.reparentAction(get(), ctx, nodeId, parentId, index),
        reorderNode: (nodeId, index) => Actions.reorderAction(get(), ctx, nodeId, index),
        setTrait: (nodeId, traitId, props) => Actions.setTraitAction(get(), ctx, nodeId, traitId, props),
        addTrait: (nodeId, traitId) => Actions.addTraitAction(get(), ctx, nodeId, traitId),
        removeTrait: (nodeId, traitId) => Actions.removeTraitAction(get(), ctx, nodeId, traitId),
        setPrefab: (nodeId, config) => Actions.setPrefabAction(get(), ctx, nodeId, config),
        createFromSelection: (prefabId) => {
            const s = get();
            const bounds = Selection.bounds(s.selection);
            if (!bounds) return;
            Actions.createFromSelectionAction(s, ctx, prefabId, bounds);
            set({ promotePicker: null });
        },
        fitToSelection: (nodeId) => {
            const s = get();
            const bounds = Selection.bounds(s.selection);
            if (bounds) Actions.fitShapeToBoundsAction(s, ctx, nodeId, bounds);
        },
        selectInside: (nodeId) => {
            const selection = Actions.selectInsideShape(ctx, nodeId);
            if (selection) set({ selection });
        },
        clearPrefab: (nodeId) => Actions.clearPrefabAction(get(), ctx, nodeId),
        bakePrefab: (nodeId) => Actions.bakePrefabAction(get(), ctx, nodeId),

        // a plain node click is the whole selection; null only drops the nodes.
        selectNode: (nodeId) => {
            const s = get();
            set({ selection: nodeId === null ? Selection.voxelsOnly(s.selection) : Selection.ofNode(nodeId) });
        },
        addToSelection: (nodeId) => set({ selection: Selection.withNode(get().selection, nodeId) }),
        removeFromSelection: (nodeId) => set({ selection: Selection.withoutNode(get().selection, nodeId) }),
        setSelection: (nodeIds) => set({ selection: Selection.withNodes(get().selection, nodeIds) }),
        clearNodeSelection: () => set({ selection: Selection.voxelsOnly(get().selection) }),
        clearSelection: () => set({ selection: Selection.create() }),
        replaceSelection: (selection) => set({ selection }),
        focusNode: (nodeId) => {
            focusCamera(api, room, ctx.client!.state!.resources, nodeId);
        },
        copyToClipboard: () => copySelectionToSystemClipboard(api, ctx),
        saveBlueprint: (name) => {
            const s = get();
            const payload = Blueprint.selectionToScenePayload(ctx.voxels, ctx.scene, s.selection);
            if (!payload) return;
            send(ctx, SaveBlueprintCommand, { name, payload: JSON.stringify(payload) });
        },
        destroySelectedNodes: () => {
            const s = get();
            const ids = s.selection.nodes;
            if (ids.size === 0) return;
            Actions.destroyNodesAction(s, ctx, ids);
            set({ selection: Selection.voxelsOnly(s.selection) });
        },
        openViewportContextMenu: (x, y, world = null, block = null, radial = false) =>
            set({ viewportContextMenu: { x, y, world, block, radial }, radialPointer: null }),
        setRadialPointer: (pointer) => set({ radialPointer: pointer }),
        setTraitPicker: (traitPicker) => set({ traitPicker }),
        setInspectedVoxel: (inspectedVoxel) => set({ inspectedVoxel }),
        createNodeAt: (position, name) => {
            const id = Actions.createNodeAtAction(ctx, position, name);
            get().selectNode(id);
        },
        closeViewportContextMenu: () => set({ viewportContextMenu: null, radialPointer: null }),

        fill: (pattern, mask) => Actions.fill(get(), ctx, pattern, mask),
        delete: () => Actions.del(get(), ctx),
        replace: (pattern, from) => Actions.replace(get(), ctx, pattern, from),
        overlay: (pattern) => Actions.overlay(get(), ctx, pattern),
        pick: () => {
            Actions.pickBlock(get(), ctx);
        },
        cutMove: (continuous = false) => {
            const s = get();
            const sel = s.selection;
            if (Selection.isEmpty(sel)) return null;
            const blueprint = Blueprint.copySelection(ctx.voxels, ctx.scene, sel);
            set((cur) => ({
                activeBlueprint: blueprint,
                placementContinuous: continuous,
                clipboardHistory: [blueprint, ...cur.clipboardHistory].slice(0, CLIPBOARD_HISTORY_CAP),
            }));

            const { forward: cutSourceOps, reverse: cutReverseOps } = Blueprint.buildPasteOps(
                blueprint,
                blueprint.origin,
                ctx.voxels,
            );
            const airOps = cutSourceOps.map((op) => ({ ...op, key: 'air' }));
            commitVoxelOps(ctx, airOps);
            playBulkEdit(ctx, airOps, cutSourceOps);

            set({ selection: Selection.create() });

            Placement.enterPlacement(placement, blueprint, true, cutReverseOps, room.scene, ctx);
            return blueprint;
        },
        pasteFromHistory: (id) => {
            const entry = get().clipboardHistory.find((bp) => bp.id === id);
            if (!entry) return;
            set({ activeBlueprint: entry });
            Placement.enterPlacement(placement, entry, false, null, room.scene, ctx);
        },
        copyHistoryToClipboard: (id) => {
            const entry = get().clipboardHistory.find((bp) => bp.id === id);
            if (!entry) return;
            set({ activeBlueprint: entry });
            writeBlueprintToSystemClipboard(entry);
            playStructuralEdit(ctx, 'copy');
        },
        rotate: (yawTurns, pitchTurns, rollTurns) => {
            const bp = get().activeBlueprint;
            if (!bp) return false;
            if (yawTurns === 0 && pitchTurns === 0 && rollTurns === 0) return false;
            let next = bp;
            const step = (turns: number, axis: 'x' | 'y' | 'z') => {
                if (turns === 0) return;
                const dir: 1 | -1 = turns > 0 ? 1 : -1;
                for (let i = 0; i < Math.abs(turns); i++) {
                    next = Blueprint.rotateAxis(next, axis, dir);
                    if (placement.current) Placement.rotatePlacement(placement, dir, axis);
                }
            };
            step(yawTurns, 'y');
            step(pitchTurns, 'x');
            step(rollTurns, 'z');
            set({ activeBlueprint: next });
            return true;
        },
        flip: (axis) => {
            const bp = get().activeBlueprint;
            if (!bp) return false;
            const next = Blueprint.flipAxis(bp, axis);
            set({ activeBlueprint: next });
            if (placement.current) Placement.flipPlacement(placement, axis);
            return true;
        },
        setBlock: (wx, wy, wz, key) => {
            commitVoxelOps(ctx, [{ wx, wy, wz, key }]);
        },
        setPlacementPivotPreset: (preset) => {
            Placement.setPlacementPivot(placement, preset);
        },

        setActiveTool: (activeTool) => set({ activeTool, brushFill: null, brushEdges: null }),
        setTransformMode: (transformMode) => set({ transformMode }),
        setTransformSpace: (transformSpace) => set({ transformSpace }),
        setTranslationSnap: (translationSnap) => set({ translationSnap }),
        setRotationSnap: (rotationSnap) => set({ rotationSnap }),
        setScaleSnap: (scaleSnap) => set({ scaleSnap }),
        setSnapTo: (snapTo) => set({ snapTo }),
        setSelectionPivot: (selectionPivot) => set({ selectionPivot }),
        setTransformPivotOffset: (transformPivotOffset) => set({ transformPivotOffset }),
        setControlMode: (controlMode) => set({ controlMode }),
        setSelectionBehavior: (mode) => set({ selectionBehavior: mode }),
        setActiveFrame: (frame) => set({ activeFrame: frame }),
        setPromotePicker: (at) => set({ promotePicker: at }),
        setSelectTarget: (filter) => set({ selectTarget: filter }),
        setSelectorMode: (mode) => set({ selectorMode: mode }),
        setAirDistance: (d) => set({ airDistance: d }),
        setMagicSelectOptions: (opts) => set((s) => ({ magicSelectOptions: { ...s.magicSelectOptions, ...opts } })),
        setLassoOptions: (opts) => set((s) => ({ lassoOptions: { ...s.lassoOptions, ...opts } })),
        setBrushSelectOptions: (opts) => set((s) => ({ brushSelectOptions: { ...s.brushSelectOptions, ...opts } })),
        setBrushOptions: (opts) => set((s) => ({ brushOptions: { ...s.brushOptions, ...opts } })),
        setPaintOptions: (opts) => set((s) => ({ paintOptions: { ...s.paintOptions, ...opts } })),
        setSmoothOptions: (opts) => set((s) => ({ smoothOptions: { ...s.smoothOptions, ...opts } })),
        setElevationOptions: (opts) => set((s) => ({ elevationOptions: { ...s.elevationOptions, ...opts } })),

        setActiveSlot: (index) =>
            set(() => {
                if (index < 0 || index >= HOTBAR_SIZE) return {};
                return { activeSlotIndex: index };
            }),
        cycleActiveSlot: (delta) =>
            set((s) => {
                const next = (((s.activeSlotIndex + delta) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
                return { activeSlotIndex: next };
            }),
        toggleLibrary: () => set((s) => ({ libraryOpen: !s.libraryOpen, carriedItem: s.libraryOpen ? null : s.carriedItem })),
        setLibraryOpen: (libraryOpen) => set({ libraryOpen, ...(libraryOpen ? {} : { carriedItem: null }) }),
        setCarriedItem: (carriedItem) => set({ carriedItem }),
        setHoveredInventoryItem: (hoveredInventoryItem) => set({ hoveredInventoryItem }),
        setPlacementContinuous: (placementContinuous) => set({ placementContinuous }),
    }));
    api = store;
    store.subscribe((state, previous) => {
        // an armed sub-frame lives only while the transform tool holds the selection that armed it
        if (state.activeFrame !== null && (state.activeTool !== 'transform' || state.selection !== previous.selection)) {
            store.setState({ activeFrame: null });
        }
        if (state.selection === previous.selection) return;
        if (env.editor) checkSelectionInvariants(state.selection, placement);
        const inspectedVoxel = inspectedVoxelOf(state.selection);
        if (!sameInspectedVoxel(inspectedVoxel, state.inspectedVoxel)) store.setState({ inspectedVoxel });
    });
    return store;
}

// placement ghosts are previews the transform tool owns; the active id is one of the selected nodes or nothing.
function checkSelectionInvariants(selection: Selection.Selection, placement: PlacementTool): void {
    for (const ghost of placement._ghostNodes) {
        if (selection.nodes.has(ghost.id)) console.error(`[bongle] selection holds placement ghost '${ghost.name}'`);
    }
    if (selection.active !== null && !selection.nodes.has(selection.active)) {
        console.error(`[bongle] selection's active node ${selection.active} is not selected`);
    }
}

function inspectedVoxelOf(selection: Selection.Selection): EditRoomState['inspectedVoxel'] {
    if (selection.nodes.size > 0 || Selection.countVoxels(selection) !== 1) return null;
    let found: EditRoomState['inspectedVoxel'] = null;
    Selection.forEach(selection, (wx, wy, wz) => {
        found = { wx, wy, wz };
    });
    return found;
}

function sameInspectedVoxel(a: EditRoomState['inspectedVoxel'], b: EditRoomState['inspectedVoxel']): boolean {
    if (a === null || b === null) return a === b;
    return a.wx === b.wx && a.wy === b.wy && a.wz === b.wz;
}

/** noop store used as a placeholder until any room registers. */
const FALLBACK_STORE: EditRoomStoreApi = create<EditRoomState>((set) => ({
    ...initialFields(),
    play: () => {},
    openScene: () => {},
    renameScene: () => {},
    save: () => {},
    deleteScene: () => {},
    undo: () => {},
    redo: () => {},
    action: () => {},
    clearVoxelSelection: () => {},
    createNode: () => {},
    destroyNode: () => {},
    setName: () => {},
    setRealm: () => {},
    reparentNode: () => {},
    reorderNode: () => {},
    setTrait: () => {},
    addTrait: () => {},
    removeTrait: () => {},
    setPrefab: () => {},
    createFromSelection: () => {},
    fitToSelection: () => {},
    selectInside: () => {},
    clearPrefab: () => {},
    bakePrefab: () => {},
    selectNode: () => {},
    addToSelection: () => {},
    removeFromSelection: () => {},
    setSelection: () => {},
    clearNodeSelection: () => {},
    clearSelection: () => {},
    replaceSelection: () => {},
    focusNode: () => {},
    copyToClipboard: () => {},
    saveBlueprint: () => {},
    destroySelectedNodes: () => {},
    openViewportContextMenu: () => {},
    setRadialPointer: () => {},
    setTraitPicker: () => {},
    setInspectedVoxel: () => {},
    createNodeAt: () => {},
    closeViewportContextMenu: () => {},
    fill: () => 0,
    delete: () => {},
    replace: () => 0,
    overlay: () => 0,
    pick: () => {},
    cutMove: () => null,
    pasteFromHistory: () => {},
    copyHistoryToClipboard: () => {},
    rotate: () => false,
    flip: () => false,
    setBlock: () => {},
    setPlacementPivotPreset: () => {},
    setActiveTool: (activeTool) => set({ activeTool, brushFill: null, brushEdges: null }),
    setTransformMode: (transformMode) => set({ transformMode }),
    setTransformSpace: (transformSpace) => set({ transformSpace }),
    setTranslationSnap: (translationSnap) => set({ translationSnap }),
    setRotationSnap: (rotationSnap) => set({ rotationSnap }),
    setScaleSnap: (scaleSnap) => set({ scaleSnap }),
    setSnapTo: (snapTo) => set({ snapTo }),
    setSelectionPivot: (selectionPivot) => set({ selectionPivot }),
    setTransformPivotOffset: (transformPivotOffset) => set({ transformPivotOffset }),
    setControlMode: (controlMode) => set({ controlMode }),
    setSelectionBehavior: (mode) => set({ selectionBehavior: mode }),
    setActiveFrame: (frame) => set({ activeFrame: frame }),
    setPromotePicker: (at) => set({ promotePicker: at }),
    setSelectTarget: (filter) => set({ selectTarget: filter }),
    setSelectorMode: (mode) => set({ selectorMode: mode }),
    setAirDistance: (d) => set({ airDistance: d }),
    setMagicSelectOptions: (opts) => set((s) => ({ magicSelectOptions: { ...s.magicSelectOptions, ...opts } })),
    setLassoOptions: (opts) => set((s) => ({ lassoOptions: { ...s.lassoOptions, ...opts } })),
    setBrushSelectOptions: (opts) => set((s) => ({ brushSelectOptions: { ...s.brushSelectOptions, ...opts } })),
    setBrushOptions: (opts) => set((s) => ({ brushOptions: { ...s.brushOptions, ...opts } })),
    setPaintOptions: (opts) => set((s) => ({ paintOptions: { ...s.paintOptions, ...opts } })),
    setSmoothOptions: (opts) => set((s) => ({ smoothOptions: { ...s.smoothOptions, ...opts } })),
    setElevationOptions: (opts) => set((s) => ({ elevationOptions: { ...s.elevationOptions, ...opts } })),
    setActiveSlot: (index) =>
        set(() => {
            if (index < 0 || index >= HOTBAR_SIZE) return {};
            return { activeSlotIndex: index };
        }),
    cycleActiveSlot: (delta) =>
        set((s) => {
            const next = (((s.activeSlotIndex + delta) % HOTBAR_SIZE) + HOTBAR_SIZE) % HOTBAR_SIZE;
            return { activeSlotIndex: next };
        }),
    toggleLibrary: () => set((s) => ({ libraryOpen: !s.libraryOpen })),
    setLibraryOpen: (libraryOpen) => set({ libraryOpen }),
    setCarriedItem: (carriedItem) => set({ carriedItem }),
    setHoveredInventoryItem: (hoveredInventoryItem) => set({ hoveredInventoryItem }),
    setPlacementContinuous: (placementContinuous) => set({ placementContinuous }),
}));

/** returns FALLBACK_STORE when no edit room is active so callers don't have to null-check. */
export function activeEditRoomStore(): EditRoomStoreApi {
    const { room, playerEditStores } = useEditor.getState();
    if (room && playerEditStores[room.playerId]) return playerEditStores[room.playerId];
    return FALLBACK_STORE;
}

export function useEditRoom<T>(selector: (s: EditRoomState) => T): T {
    const api = useEditor((s) => (s.room ? s.playerEditStores[s.room.playerId] : null) ?? FALLBACK_STORE);
    return useStore(api, selector);
}
