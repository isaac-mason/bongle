import { activeEditRoomStore, useEditRoom } from '../edit-room-store';
import { buildViewportMenuEntries } from './viewport-menu-entries';

const RADIUS = 130;
const INNER_RADIUS = 48;
const LABEL_RADIUS = (RADIUS + INNER_RADIUS) / 2;
const GAP_DEG = 1.5;
/** how far out the stick cursor can travel; stays inside the ring even at full deflection. */
const CURSOR_MAX_RADIUS = RADIUS - 18;
const CURSOR_R = 6;

// wedge 0 at top (-90deg), clockwise — matches the angle convention `updateRadialMenu` uses to
// bucket the accumulated look-delta into a wedge index.
function polar(radius: number, deg: number): [number, number] {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [radius * Math.cos(rad), radius * Math.sin(rad)];
}

function wedgePath(startDeg: number, endDeg: number): string {
    const [ox1, oy1] = polar(RADIUS, startDeg);
    const [ox2, oy2] = polar(RADIUS, endDeg);
    const [ix2, iy2] = polar(INNER_RADIUS, endDeg);
    const [ix1, iy1] = polar(INNER_RADIUS, startDeg);
    const large = endDeg - startDeg > 180 ? 1 : 0;
    return [
        `M ${ix1} ${iy1}`,
        `L ${ox1} ${oy1}`,
        `A ${RADIUS} ${RADIUS} 0 ${large} 1 ${ox2} ${oy2}`,
        `L ${ix2} ${iy2}`,
        `A ${INNER_RADIUS} ${INNER_RADIUS} 0 ${large} 0 ${ix1} ${iy1}`,
        'Z',
    ].join(' ');
}

/** the hold-RMB pointer-locked counterpart to `ViewportContextMenu`: same entries
 *  (`buildViewportMenuEntries`), a ring of wedges instead of a dropdown list, and no OS cursor to
 *  click — a wedge is picked by accumulated look-delta (`updateRadialMenu` in tools/inspect.ts)
 *  and confirmed on release, which this only reflects (`radialPointer`), never drives itself.
 *  Open/closed is read straight off `viewportContextMenu.radial`, the same field the input side
 *  keys off — see updateRadialMenu's doc comment for why there's deliberately no second flag. */
export function RadialMenu() {
    const store = activeEditRoomStore();
    const menu = useEditRoom((s) => s.viewportContextMenu);
    const pointer = useEditRoom((s) => s.radialPointer);
    // re-render on the inputs buildViewportMenuEntries reads.
    useEditRoom((s) => s.selection.nodes.size);
    useEditRoom((s) => Math.min(1, s.selection.chunks.size));
    useEditRoom((s) => s.activeSlotIndex);

    if (!menu?.radial) return null;

    const hover = pointer?.hover ?? null;
    const cursorX = pointer ? pointer.dirX * pointer.mag * CURSOR_MAX_RADIUS : 0;
    const cursorY = pointer ? pointer.dirY * pointer.mag * CURSOR_MAX_RADIUS : 0;

    const entries = buildViewportMenuEntries(store).filter((e) => e.kind === 'item');
    if (entries.length === 0) return null;

    const wedgeDeg = 360 / entries.length;

    return (
        <div className="fixed inset-0 z-20 flex items-center justify-center pointer-events-none select-none drop-shadow-md">
            <svg
                width={RADIUS * 2 + 20}
                height={RADIUS * 2 + 20}
                viewBox={`${-RADIUS - 10} ${-RADIUS - 10} ${RADIUS * 2 + 20} ${RADIUS * 2 + 20}`}
                role="img"
                aria-label="Radial context menu"
            >
                {entries.map((entry, i) => {
                    const start = i * wedgeDeg + GAP_DEG / 2;
                    const end = (i + 1) * wedgeDeg - GAP_DEG / 2;
                    const mid = (start + end) / 2;
                    const [lx, ly] = polar(LABEL_RADIUS, mid);
                    const active = hover === i;
                    const danger = entry.variant === 'danger';
                    // mirrors DropdownMenuItem's own palette exactly: a neutral surface at rest,
                    // surface-muted on hover (danger's hover tints red instead), text colored by
                    // variant regardless of hover — same menu, same rules, different shape.
                    const wedgeClass = active ? (danger ? 'fill-danger/15' : 'fill-surface-muted') : 'fill-surface stroke-border';
                    const labelClass = danger ? 'text-danger' : 'text-fg';
                    return (
                        <g key={entry.id}>
                            <path d={wedgePath(start, end)} className={wedgeClass} strokeWidth={active ? 0 : 1} />
                            <foreignObject x={lx - 44} y={ly - 18} width={88} height={36}>
                                <div
                                    className={`flex flex-col items-center gap-0.5 text-[10px] font-mono leading-none ${labelClass}`}
                                >
                                    <entry.Icon size={12} />
                                    <span className="text-center">{entry.label}</span>
                                </div>
                            </foreignObject>
                        </g>
                    );
                })}
                {/* the virtual stick: sits at centre at rest, tracks look-delta direction/magnitude
                    while held — the "where am I pointing" feedback a real OS cursor would give. */}
                <circle cx={0} cy={0} r={3} className="fill-fg-muted/40" />
                <line x1={0} y1={0} x2={cursorX} y2={cursorY} className="stroke-fg-muted/60" strokeWidth={1.5} />
                <circle cx={cursorX} cy={cursorY} r={CURSOR_R} className="fill-fg stroke-surface" strokeWidth={1.5} />
            </svg>
        </div>
    );
}
