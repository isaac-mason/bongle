import { type Mat4, type Vec3, vec3 } from 'math';
import { type MarkerShape, MarkerTrait } from '../../builtins/marker';
import { getVisualWorldMatrix, getVisualWorldPosition, type TransformTrait } from '../../builtins/transform';
import { registry } from '../../core/registry';
import type { Node } from '../../core/scene/scene-tree';
import { getTrait } from '../../core/scene/scene-tree';
import * as Lines from '../../render/overlay/lines';
import * as Quads from '../../render/overlay/quads';
import * as Text from '../../render/overlay/text';
import type { SpriteResources } from '../../render/sprites/sprite-resources';
import { isOwnershipBoundary } from '../node-bodies';
import { SHAPE_OUTLINE_ACTIVE, SHAPE_OUTLINE_HOVER, SHAPE_OUTLINE_SELECTED } from './editor-colors';
import * as ShapeOutlines from './shape-outlines';

/** what a node shows at its origin; a marker pins it on and may override the parts, every other node gets it while selected. */
export type NodeCard = {
    icon: string | null;
    label: string;
    figure: MarkerShape;
    size: number;
    tint: [number, number, number, number];
    pinned: boolean;
};

export type Emphasis = 'pinned' | 'selected' | 'active' | 'hover';

export type CardToggles = { outlines: boolean; names: boolean };

export type CardBatches = {
    lines: Lines.LineBatch;
    quads: Quads.QuadBatch;
    text: Text.TextBatch;
    sprite: SpriteResources | null;
};

/**
 * glyph multiples in CSS pixels. Whole numbers only: the drawn scale is rounded to whole device pixels to keep
 * the pixel font even, and a whole CSS scale is already whole at every integer display ratio, so the label is
 * the same size on a 1x panel as on a 2x one instead of stepping when a window moves between them.
 */
export const LABEL_SCALE = 2;
export const LABEL_LIFT_PX = 16;
const MARKER_ICON_PX = 20;
const LABEL_GAP_PX = 6;
const LABEL_PAD_PX = 4;
const LABEL_BACKING: [number, number, number, number] = [0.08, 0.08, 0.1, 0.6];
const DEFAULT_MARKER_ICON = 'kit:marker';
const WHITE: [number, number, number, number] = [1, 1, 1, 1];

/** the icon the hierarchy and an auto marker show for a node: its most specific trait's, with transform as the fallback. */
export function nodeIcon(node: Node): string | null {
    let fallback: string | null = null;
    for (let slot = 0; slot < node.traits.length; slot++) {
        if (node.traits[slot] === undefined) continue;
        const def = registry.slotToTrait[slot]?.def;
        if (!def || def.icon === null) continue;
        if (def.id === 'transform') fallback = def.icon;
        else return def.icon;
    }
    return fallback;
}

/** every trait icon the node carries except the transform's, which every node has. */
export function nodeIcons(node: Node): string[] {
    const icons: string[] = [];
    for (let slot = 0; slot < node.traits.length; slot++) {
        if (node.traits[slot] === undefined) continue;
        const def = registry.slotToTrait[slot]?.def;
        if (def && def.icon !== null && def.id !== 'transform') icons.push(def.icon);
    }
    return icons;
}

function nodeName(node: Node): string {
    return node.name ?? `#${node.id}`;
}

/** the marker's own icon, or the node's trait icon for 'auto', or the pin. */
export function markerIcon(node: Node, marker: MarkerTrait): string {
    if (marker.icon !== 'auto') return marker.icon;
    const icon = nodeIcon(node);
    return icon === null || icon === 'kit:icon:transform' ? DEFAULT_MARKER_ICON : icon;
}

/** the node that presents `node` to the user: its nearest prefab anchor or character root, else itself. */
export function ownerOf(node: Node): Node {
    let current = node.parent;
    while (current) {
        if (isOwnershipBoundary(current)) return current;
        current = current.parent;
    }
    return node;
}

// a marker on the node, else the first one in the internals it owns (nested boundaries keep theirs).
function ownedMarker(node: Node): MarkerTrait | null {
    const own = getTrait(node, MarkerTrait);
    if (own) return own.enabled ? own : null;
    if (!isOwnershipBoundary(node)) return null;
    const stack: Node[] = [...node.children];
    while (stack.length > 0) {
        const child = stack.pop()!;
        if (isOwnershipBoundary(child)) continue;
        const marker = getTrait(child, MarkerTrait);
        if (marker?.enabled) return marker;
        for (const grandchild of child.children) stack.push(grandchild);
    }
    return null;
}

export function cardFor(node: Node): NodeCard {
    const marker = ownedMarker(node);
    if (marker) {
        return {
            icon: markerIcon(node, marker),
            label: marker.label === 'auto' ? nodeName(node) : marker.label,
            figure: marker.shape,
            size: marker.size,
            tint: [marker.tint[0], marker.tint[1], marker.tint[2], marker.tint[3]],
            pinned: true,
        };
    }
    return { icon: nodeIcon(node), label: nodeName(node), figure: 'none', size: 0, tint: WHITE, pinned: false };
}

/**
 * everything sits in pixels around the node's projected origin: the marker icon centred on it, the label above
 * on a backing. hover: a faint outline. pinned: icon, figure, label, always. selected and active: label and outline.
 */
export function drawCard(
    batches: CardBatches,
    node: Node,
    transform: TransformTrait,
    card: NodeCard,
    emphasis: Emphasis,
    eye: Vec3,
    toggles: CardToggles,
): void {
    const origin = getVisualWorldPosition(transform);
    if (emphasis === 'hover') {
        if (toggles.outlines) ShapeOutlines.drawNode(batches.lines, node, SHAPE_OUTLINE_HOVER, eye);
        return;
    }
    const [x, y, z] = origin;
    const [r, g, b, a] = card.tint;
    let lift = 0;

    if (card.pinned) {
        if (card.figure !== 'none') drawFigure(batches.lines, getVisualWorldMatrix(transform), card);
        const frame = card.icon !== null ? batches.sprite?.frames.get(card.icon)?.frames[0] : undefined;
        if (frame) {
            const half = MARKER_ICON_PX / 2;
            lift = half;
            Quads.quad(
                batches.quads,
                x,
                y,
                z,
                0,
                0,
                half,
                half,
                frame.u,
                frame.v,
                frame.u + frame.w,
                frame.v + frame.h,
                r,
                g,
                b,
                a,
            );
        }
    }
    if (toggles.names && card.label !== '') {
        const hw = Text.measure(batches.text, card.label, LABEL_SCALE) / 2;
        const hh = Text.height(batches.text, LABEL_SCALE) / 2;
        const dy = lift + LABEL_GAP_PX + hh + LABEL_PAD_PX;
        Quads.rect(batches.quads, x, y, z, 0, dy, hw + LABEL_PAD_PX, hh + LABEL_PAD_PX, ...LABEL_BACKING);
        Text.label(batches.text, x, y, z, card.label, LABEL_SCALE, dy, r, g, b, a);
        lift = dy + hh + LABEL_PAD_PX;
    }
    if (emphasis === 'pinned') return;

    if (toggles.outlines) {
        ShapeOutlines.drawNode(batches.lines, node, emphasis === 'active' ? SHAPE_OUTLINE_ACTIVE : SHAPE_OUTLINE_SELECTED, eye);
    }
}

const AXIS_COLORS: [number, number, number][] = [
    [1, 0.3, 0.3],
    [0.3, 1, 0.3],
    [0.3, 0.5, 1],
];
const _from: Vec3 = [0, 0, 0];
const _to: Vec3 = [0, 0, 0];

function figureLine(
    lines: Lines.LineBatch,
    m: Mat4,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    g: number,
    b: number,
    a: number,
): void {
    vec3.transformMat4(_from, vec3.set(_from, ax, ay, az), m);
    vec3.transformMat4(_to, vec3.set(_to, bx, by, bz), m);
    Lines.line(lines, _from[0], _from[1], _from[2], _to[0], _to[1], _to[2], r, g, b, a);
}

// a world-size figure at the node so orientation reads; the arrow points down -Z.
function drawFigure(lines: Lines.LineBatch, m: Mat4, card: NodeCard): void {
    const size = card.size;
    const [r, g, b, a] = card.tint;
    if (card.figure === 'axes') {
        for (let axis = 0; axis < 3; axis++) {
            const [cr, cg, cb] = AXIS_COLORS[axis]!;
            figureLine(lines, m, 0, 0, 0, axis === 0 ? size : 0, axis === 1 ? size : 0, axis === 2 ? size : 0, cr, cg, cb, a);
        }
    } else if (card.figure === 'cross') {
        const h = size / 2;
        figureLine(lines, m, -h, 0, 0, h, 0, 0, r, g, b, a);
        figureLine(lines, m, 0, -h, 0, 0, h, 0, r, g, b, a);
        figureLine(lines, m, 0, 0, -h, 0, 0, h, r, g, b, a);
    } else if (card.figure === 'arrow') {
        figureLine(lines, m, 0, 0, 0, 0, 0, -size, r, g, b, a);
        figureLine(lines, m, 0, 0, -size, size * 0.25, 0, -size * 0.75, r, g, b, a);
        figureLine(lines, m, 0, 0, -size, -size * 0.25, 0, -size * 0.75, r, g, b, a);
    }
}
