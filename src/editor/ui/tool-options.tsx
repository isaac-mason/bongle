import { useMemo, useRef, useState } from 'react';
import * as Selection from '../../core/scene/selection';
import type {
    ElevationFalloff,
    ElevationMode,
    MagicSelectCompare,
    SelectionBehavior,
    SelectorMode,
    SelectTarget,
    TransformMode,
    TransformSpace,
} from '../edit-room-store';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';
import { activeBlockKeyOf } from '../inventory';
import { parseMask, suggestMask } from '../scene/mask';
import { parsePattern, suggestPattern } from '../scene/pattern';
import type { BrushShape } from '../scene/shapes';
import { loadElevationImage } from '../tools/elevation';
import type { PivotPreset } from '../tools/transform';
import { NumberInput } from './components/number-input';
import { Range } from './components/range';
import { ExprInput } from './expr-input';

// ── shared helpers ─────────────────────────────────────────────────

function ToggleBtn({
    active,
    onClick,
    children,
    disabled = false,
}: {
    active: boolean;
    onClick: () => void;
    children: React.ReactNode;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                disabled
                    ? 'text-neutral-600 cursor-not-allowed'
                    : active
                      ? 'bg-neutral-700 text-white'
                      : 'text-neutral-400 hover:text-neutral-200'
            }`}
        >
            {children}
        </button>
    );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono text-neutral-500 w-16 shrink-0">{label}</span>
            {children}
        </div>
    );
}

// ── select target row ──────────────────────────────────────────────

function SelectTargetRow() {
    const selectTarget = useEditRoom((s) => s.selectTarget);
    const setSelectTarget = useEditRoom((s) => s.setSelectTarget);

    function filterBtn(f: SelectTarget, label: string) {
        return (
            <ToggleBtn active={selectTarget === f} onClick={() => setSelectTarget(f)}>
                {label}
            </ToggleBtn>
        );
    }

    return (
        <Row label="target">
            {filterBtn('all', 'all')}
            {filterBtn('nodes', 'nodes')}
            {filterBtn('voxels', 'voxels')}
        </Row>
    );
}

// ── selector mode row ──────────────────────────────────────────────

function SelectorModeRow() {
    const selectorMode = useEditRoom((s) => s.selectorMode);
    const setSelectorMode = useEditRoom((s) => s.setSelectorMode);
    const airDistance = useEditRoom((s) => s.airDistance);
    const setAirDistance = useEditRoom((s) => s.setAirDistance);

    function modeBtn(mode: SelectorMode, label: string) {
        return (
            <ToggleBtn active={selectorMode === mode} onClick={() => setSelectorMode(mode)}>
                {label}
            </ToggleBtn>
        );
    }

    return (
        <>
            <Row label="cursor">
                {modeBtn('laser', 'laser')}
                {modeBtn('air', 'air')}
            </Row>
            {selectorMode === 'air' && (
                <Row label="distance">
                    <NumberInput value={airDistance} onChange={setAirDistance} min={1} max={100} />
                </Row>
            )}
        </>
    );
}

// ── selection summary ──────────────────────────────────────────────
// shows in-progress selection info (corners, dimensions, count),
// committed selection info (bounds, dimensions, count), or an idle hint.
// used by all selection-related tool panels.

function SelectionSummary({ idle }: { idle?: string } = {}) {
    const selection = useEditRoom((s) => s.selection);
    const boxSelect = useEditRoom((s) => s.boxSelect);
    const hasSelection = useMemo(() => !Selection.isEmpty(selection), [selection]);
    const voxelCount = useMemo(() => Selection.countVoxels(selection), [selection]);
    const nodeCount = selection.nodes.size;
    const progress = useMemo(() => {
        if (!boxSelect?.previewB) return null;
        const [ax, ay, az] = boxSelect.cornerA;
        const [bx, by, bz] = boxSelect.previewB;
        const dx = Math.abs(bx - ax) + 1;
        const dy = Math.abs(by - ay) + 1;
        const dz = Math.abs(bz - az) + 1;
        return {
            cornerA: boxSelect.cornerA,
            cornerB: boxSelect.previewB,
            dimensions: [dx, dy, dz] as [number, number, number],
            voxelCount: dx * dy * dz,
        };
    }, [boxSelect]);
    const bounds = useMemo(() => Selection.bounds(selection), [selection]);

    // in-progress selection (box-select dragging etc)
    if (progress) {
        const [ax, ay, az] = progress.cornerA;
        const [bx, by, bz] = progress.cornerB;
        const [dx, dy, dz] = progress.dimensions;
        return (
            <div className="text-[10px] font-mono text-neutral-400 flex flex-col gap-0.5">
                <div>
                    (A: {ax}, {ay}, {az}) → (B: {bx}, {by}, {bz})
                </div>
                <div>
                    {progress.voxelCount.toLocaleString()} voxel{progress.voxelCount !== 1 ? 's' : ''} · {dx}×{dy}×{dz}
                </div>
            </div>
        );
    }

    // committed selection
    if (hasSelection) {
        const parts: string[] = [];
        if (nodeCount > 0) parts.push(`${nodeCount.toLocaleString()} node${nodeCount !== 1 ? 's' : ''}`);
        if (voxelCount > 0) parts.push(`${voxelCount.toLocaleString()} voxel${voxelCount !== 1 ? 's' : ''}`);

        return (
            <div className="text-[10px] font-mono text-neutral-400 flex flex-col gap-0.5">
                {bounds && (
                    <div>
                        (min: {bounds.min[0]}, {bounds.min[1]}, {bounds.min[2]}) → (max: {bounds.max[0]}, {bounds.max[1]},{' '}
                        {bounds.max[2]})
                    </div>
                )}
                <div>
                    {parts.join(' + ')}
                    {bounds && (
                        <>
                            {' '}
                            · {bounds.dimensions[0]}×{bounds.dimensions[1]}×{bounds.dimensions[2]}
                        </>
                    )}
                </div>
            </div>
        );
    }

    if (idle) {
        return <div className="text-[10px] font-mono text-neutral-500 italic">{idle}</div>;
    }

    return null;
}

// ── box select ─────────────────────────────────────────────────────

export function BoxSelectOptions() {
    const selectionBehavior = useEditRoom((s) => s.selectionBehavior);
    const setSelectionBehavior = useEditRoom((s) => s.setSelectionBehavior);

    function modeBtn(mode: SelectionBehavior, label: string) {
        return (
            <ToggleBtn active={selectionBehavior === mode} onClick={() => setSelectionBehavior(mode)}>
                {label}
            </ToggleBtn>
        );
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <SelectionSummary idle="click once to set corner a, again to set corner b" />
            <SelectTargetRow />
            <SelectorModeRow />
            <Row label="behavior">
                {modeBtn('replace', 'replace')}
                {modeBtn('add', 'add')}
            </Row>
        </div>
    );
}

// ── magic select ───────────────────────────────────────────────────

export function MagicSelectOptions() {
    const selectionBehavior = useEditRoom((s) => s.selectionBehavior);
    const setSelectionBehavior = useEditRoom((s) => s.setSelectionBehavior);
    const opts = useEditRoom((s) => s.magicSelectOptions);
    const set = useEditRoom((s) => s.setMagicSelectOptions);

    function compareBtn(c: MagicSelectCompare, label: string) {
        return (
            <ToggleBtn active={opts.compareType === c} onClick={() => set({ compareType: c })}>
                {label}
            </ToggleBtn>
        );
    }

    function modeBtn(mode: SelectionBehavior, label: string) {
        return (
            <ToggleBtn active={selectionBehavior === mode} onClick={() => setSelectionBehavior(mode)}>
                {label}
            </ToggleBtn>
        );
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <SelectionSummary idle="click a voxel to flood-fill select" />
            <SelectTargetRow />
            <Row label="behavior">
                {modeBtn('replace', 'replace')}
                {modeBtn('add', 'add')}
            </Row>
            <Row label="compare">
                {compareBtn('block', 'block')}
                {compareBtn('blockstate', 'state')}
                {compareBtn('solid', 'solid')}
                {compareBtn('any', 'any')}
            </Row>
            <Row label="surface">
                <ToggleBtn active={!opts.surfaceOnly} onClick={() => set({ surfaceOnly: false })}>
                    off
                </ToggleBtn>
                <ToggleBtn active={opts.surfaceOnly} onClick={() => set({ surfaceOnly: true })}>
                    on
                </ToggleBtn>
            </Row>
            <Row label="dirs">
                <ToggleBtn active={opts.up} onClick={() => set({ up: !opts.up })}>
                    up
                </ToggleBtn>
                <ToggleBtn active={opts.down} onClick={() => set({ down: !opts.down })}>
                    down
                </ToggleBtn>
                <ToggleBtn active={opts.horizontal} onClick={() => set({ horizontal: !opts.horizontal })}>
                    horiz
                </ToggleBtn>
            </Row>
            <Row label="corners">
                <ToggleBtn active={!opts.corners} onClick={() => set({ corners: false })}>
                    off
                </ToggleBtn>
                <ToggleBtn active={opts.corners} onClick={() => set({ corners: true })}>
                    on
                </ToggleBtn>
            </Row>
            <Row label="range">
                <NumberInput value={opts.range} onChange={(range) => set({ range })} min={1} max={10} />
                <Range value={opts.range} onChange={(range) => set({ range })} min={1} max={10} />
            </Row>
            <Row label="limit">
                <NumberInput value={opts.limit} onChange={(limit) => set({ limit })} min={1} step={1000} width="md" />
                <Range value={opts.limit} onChange={(limit) => set({ limit })} min={1} max={100000} step={1000} />
            </Row>
        </div>
    );
}

// ── lasso select ───────────────────────────────────────────────────

export function LassoSelectOptions() {
    const selectionBehavior = useEditRoom((s) => s.selectionBehavior);
    const setSelectionBehavior = useEditRoom((s) => s.setSelectionBehavior);
    const opts = useEditRoom((s) => s.lassoOptions);
    const set = useEditRoom((s) => s.setLassoOptions);

    function modeBtn(mode: SelectionBehavior, label: string) {
        return (
            <ToggleBtn active={selectionBehavior === mode} onClick={() => setSelectionBehavior(mode)}>
                {label}
            </ToggleBtn>
        );
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <SelectionSummary idle="click & drag to draw a freeform region" />
            <SelectTargetRow />
            <Row label="behavior">
                {modeBtn('replace', 'replace')}
                {modeBtn('add', 'add')}
            </Row>
            <Row label="depth">
                <NumberInput value={opts.depth} onChange={(depth) => set({ depth })} min={1} />
                <Range value={opts.depth} onChange={(depth) => set({ depth })} min={1} max={32} />
            </Row>
            <Row label="distance">
                <NumberInput value={opts.maxDistance} onChange={(maxDistance) => set({ maxDistance })} min={1} step={16} />
                <Range value={opts.maxDistance} onChange={(maxDistance) => set({ maxDistance })} min={16} max={1024} step={16} />
            </Row>
        </div>
    );
}

// ── painter ────────────────────────────────────────────────────────

export function PaintOptions() {
    const paintOptions = useEditRoom((s) => s.paintOptions);
    const setPaintOptions = useEditRoom((s) => s.setPaintOptions);
    const { shape, size, height, patternText, patternError, maskText, maskError } = paintOptions;

    function commitPattern(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            setPaintOptions({ patternText: text, pattern: { kind: 'active' }, patternError: null });
            return;
        }
        try {
            setPaintOptions({ patternText: text, pattern: parsePattern(trimmed), patternError: null });
        } catch (e) {
            setPaintOptions({ patternText: text, patternError: e instanceof Error ? e.message : String(e) });
        }
    }

    function commitMask(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            setPaintOptions({ maskText: text, mask: null, maskError: null });
            return;
        }
        try {
            setPaintOptions({ maskText: text, mask: parseMask(trimmed), maskError: null });
        } catch (e) {
            setPaintOptions({ maskText: text, maskError: e instanceof Error ? e.message : String(e) });
        }
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <Row label="shape">
                {BRUSH_SHAPES.map((s) => (
                    <ToggleBtn key={s.id} active={shape === s.id} onClick={() => setPaintOptions({ shape: s.id })}>
                        {s.label}
                    </ToggleBtn>
                ))}
            </Row>
            <Row label="size">
                <NumberInput value={size} onChange={(size) => setPaintOptions({ size })} min={0} />
                <Range value={size} onChange={(size) => setPaintOptions({ size })} min={0} max={32} />
            </Row>
            {shape === 'cylinder' && (
                <Row label="height">
                    <NumberInput value={height} onChange={(height) => setPaintOptions({ height })} min={1} max={64} />
                </Row>
            )}
            <Row label="pattern">
                <ExprInput
                    value={patternText}
                    placeholder="$active"
                    suggest={suggestPattern}
                    onChange={commitPattern}
                    error={patternError}
                />
            </Row>
            <Row label="mask">
                <ExprInput value={maskText} placeholder="(none)" suggest={suggestMask} onChange={commitMask} error={maskError} />
            </Row>
            <SelectorModeRow />
        </div>
    );
}

// ── build ──────────────────────────────────────────────────────────

export function BuildOptions() {
    const hotbar = useEditor((s) => s.hotbar);
    const activeSlotIndex = useEditRoom((s) => s.activeSlotIndex);
    const activeBlockKey = activeBlockKeyOf(hotbar, activeSlotIndex);

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <div className="text-[10px] font-mono text-neutral-400">left click to break</div>
            {activeBlockKey ? (
                <div className="text-[10px] font-mono text-neutral-400">right click to place</div>
            ) : (
                <div className="text-[10px] font-mono text-neutral-500 italic">select a block from the palette to place</div>
            )}
            <SelectorModeRow />
        </div>
    );
}

// ── brush ──────────────────────────────────────────────────────────

const BRUSH_SHAPES: ReadonlyArray<{ id: BrushShape; label: string }> = [
    { id: 'sphere', label: 'sphere' },
    { id: 'cube', label: 'cube' },
    { id: 'cylinder', label: 'cyl' },
    { id: 'disc', label: 'disc' },
];

export function BrushOptions() {
    const brushOptions = useEditRoom((s) => s.brushOptions);
    const setBrushOptions = useEditRoom((s) => s.setBrushOptions);
    const { shape, size, height, patternText, patternError, maskText, maskError } = brushOptions;

    function commitPattern(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            // empty falls back to $active so the brush always has *something*
            // to sample; mirrors the visible default in the placeholder.
            setBrushOptions({ patternText: text, pattern: { kind: 'active' }, patternError: null });
            return;
        }
        try {
            setBrushOptions({ patternText: text, pattern: parsePattern(trimmed), patternError: null });
        } catch (e) {
            setBrushOptions({ patternText: text, patternError: e instanceof Error ? e.message : String(e) });
        }
    }

    function commitMask(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            setBrushOptions({ maskText: text, mask: null, maskError: null });
            return;
        }
        try {
            setBrushOptions({ maskText: text, mask: parseMask(trimmed), maskError: null });
        } catch (e) {
            setBrushOptions({ maskText: text, maskError: e instanceof Error ? e.message : String(e) });
        }
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <Row label="shape">
                {BRUSH_SHAPES.map((s) => (
                    <ToggleBtn key={s.id} active={shape === s.id} onClick={() => setBrushOptions({ shape: s.id })}>
                        {s.label}
                    </ToggleBtn>
                ))}
            </Row>
            <Row label="size">
                <NumberInput value={size} onChange={(size) => setBrushOptions({ size })} min={0} />
                <Range value={size} onChange={(size) => setBrushOptions({ size })} min={0} max={32} />
            </Row>
            {shape === 'cylinder' && (
                <Row label="height">
                    <NumberInput value={height} onChange={(height) => setBrushOptions({ height })} min={1} max={64} />
                </Row>
            )}
            <Row label="pattern">
                <ExprInput
                    value={patternText}
                    placeholder="$active"
                    suggest={suggestPattern}
                    onChange={commitPattern}
                    error={patternError}
                />
            </Row>
            <Row label="mask">
                <ExprInput value={maskText} placeholder="(none)" suggest={suggestMask} onChange={commitMask} error={maskError} />
            </Row>
        </div>
    );
}

// ── brush select ───────────────────────────────────────────────────

export function BrushSelectOptions() {
    const brushSelectOptions = useEditRoom((s) => s.brushSelectOptions);
    const setBrushSelectOptions = useEditRoom((s) => s.setBrushSelectOptions);
    const selectionBehavior = useEditRoom((s) => s.selectionBehavior);
    const setSelectionBehavior = useEditRoom((s) => s.setSelectionBehavior);
    const { shape, size, height, maskText, maskError } = brushSelectOptions;

    function commitMask(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            setBrushSelectOptions({ maskText: text, mask: null, maskError: null });
            return;
        }
        try {
            setBrushSelectOptions({ maskText: text, mask: parseMask(trimmed), maskError: null });
        } catch (e) {
            setBrushSelectOptions({ maskText: text, maskError: e instanceof Error ? e.message : String(e) });
        }
    }

    function behaviorBtn(mode: SelectionBehavior, label: string) {
        return (
            <ToggleBtn active={selectionBehavior === mode} onClick={() => setSelectionBehavior(mode)}>
                {label}
            </ToggleBtn>
        );
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <SelectionSummary idle="drag to stamp a shape and select voxels" />
            <Row label="behavior">
                {behaviorBtn('replace', 'replace')}
                {behaviorBtn('add', 'add')}
            </Row>
            <Row label="shape">
                {BRUSH_SHAPES.map((s) => (
                    <ToggleBtn key={s.id} active={shape === s.id} onClick={() => setBrushSelectOptions({ shape: s.id })}>
                        {s.label}
                    </ToggleBtn>
                ))}
            </Row>
            <Row label="size">
                <NumberInput value={size} onChange={(size) => setBrushSelectOptions({ size })} min={0} />
                <Range value={size} onChange={(size) => setBrushSelectOptions({ size })} min={0} max={32} />
            </Row>
            {shape === 'cylinder' && (
                <Row label="height">
                    <NumberInput value={height} onChange={(height) => setBrushSelectOptions({ height })} min={1} max={64} />
                </Row>
            )}
            <Row label="mask">
                <ExprInput value={maskText} placeholder="(none)" suggest={suggestMask} onChange={commitMask} error={maskError} />
            </Row>
        </div>
    );
}

// ── smooth ─────────────────────────────────────────────────────────

export function SmoothOptions() {
    const smoothOptions = useEditRoom((s) => s.smoothOptions);
    const setSmoothOptions = useEditRoom((s) => s.setSmoothOptions);
    const { shape, size, height, iterations, heightmapMaskText, heightmapMaskError } = smoothOptions;

    function commitMask(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            setSmoothOptions({ heightmapMaskText: text, heightmapMask: null, heightmapMaskError: null });
            return;
        }
        try {
            setSmoothOptions({
                heightmapMaskText: text,
                heightmapMask: parseMask(trimmed),
                heightmapMaskError: null,
            });
        } catch (e) {
            setSmoothOptions({
                heightmapMaskText: text,
                heightmapMaskError: e instanceof Error ? e.message : String(e),
            });
        }
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <Row label="shape">
                {BRUSH_SHAPES.map((s) => (
                    <ToggleBtn key={s.id} active={shape === s.id} onClick={() => setSmoothOptions({ shape: s.id })}>
                        {s.label}
                    </ToggleBtn>
                ))}
            </Row>
            <Row label="size">
                <NumberInput value={size} onChange={(size) => setSmoothOptions({ size })} min={1} />
                <Range value={size} onChange={(size) => setSmoothOptions({ size })} min={1} max={32} />
            </Row>
            {shape === 'cylinder' && (
                <Row label="height">
                    <NumberInput value={height} onChange={(height) => setSmoothOptions({ height })} min={1} max={64} />
                </Row>
            )}
            <Row label="iters">
                <NumberInput value={iterations} onChange={(iterations) => setSmoothOptions({ iterations })} min={1} max={32} />
            </Row>
            <Row label="mask">
                <ExprInput
                    value={heightmapMaskText}
                    placeholder="(any non-air)"
                    suggest={suggestMask}
                    onChange={commitMask}
                    error={heightmapMaskError}
                />
            </Row>
        </div>
    );
}

// ── elevation ──────────────────────────────────────────────────────

const ELEVATION_MODES: ReadonlyArray<{ id: ElevationMode; label: string }> = [
    { id: 'raise', label: 'raise' },
    { id: 'lower', label: 'lower' },
    { id: 'flatten', label: 'flatten' },
];

const ELEVATION_FALLOFFS: ReadonlyArray<{ id: ElevationFalloff; label: string; fn: (t: number) => number }> = [
    { id: 'linear', label: 'linear', fn: (t) => 1 - t },
    { id: 'cosine', label: 'cosine', fn: (t) => 0.5 * (1 + Math.cos(t * Math.PI)) },
    { id: 'sharp', label: 'sharp', fn: (t) => (1 - t) ** 3 },
];

/** sampled svg path for a falloff curve drawn as a symmetric hill across
 *  the 0..w × 0..h box. x ∈ [-1, 1] maps to [0, w]; t = |x|; fn(t) is the
 *  normalised height (1 at the centre, 0 at the edges). */
function falloffPath(fn: (t: number) => number, w: number, h: number, samples = 48): string {
    let d = '';
    for (let i = 0; i <= samples; i++) {
        const x01 = i / samples;
        const t = Math.abs(x01 * 2 - 1);
        const x = x01 * w;
        const y = h - fn(t) * h;
        d += `${(i === 0 ? 'M' : 'L') + x.toFixed(2)},${y.toFixed(2)} `;
    }
    return d.trim();
}

function FalloffButton({
    active,
    label,
    fn,
    onClick,
}: {
    active: boolean;
    label: string;
    fn: (t: number) => number;
    onClick: () => void;
}) {
    const w = 48;
    const h = 20;
    return (
        <button
            type="button"
            onClick={onClick}
            className={`flex flex-col items-center gap-0.5 px-1 py-1 rounded transition-colors ${
                active ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800'
            }`}
        >
            <span className="text-[10px] font-mono leading-none">{label}</span>
            <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="block" aria-hidden="true">
                <path
                    d={falloffPath(fn, w, h)}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.25}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
        </button>
    );
}

export function ElevationOptions() {
    const elevationOptions = useEditRoom((s) => s.elevationOptions);
    const setElevationOptions = useEditRoom((s) => s.setElevationOptions);
    const {
        size,
        yLimit,
        mode,
        amount,
        rate,
        falloff,
        applyMode,
        heightmap,
        heightmapError,
        patternText,
        patternError,
        maskText,
        maskError,
    } = elevationOptions;
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [loading, setLoading] = useState(false);

    function commitPattern(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            // empty falls back to the column-surface default (extends terrain).
            setElevationOptions({ patternText: text, pattern: null, patternError: null });
            return;
        }
        try {
            setElevationOptions({ patternText: text, pattern: parsePattern(trimmed), patternError: null });
        } catch (e) {
            setElevationOptions({ patternText: text, patternError: e instanceof Error ? e.message : String(e) });
        }
    }

    function commitMask(text: string) {
        const trimmed = text.trim();
        if (!trimmed) {
            setElevationOptions({ maskText: text, mask: null, maskError: null });
            return;
        }
        try {
            setElevationOptions({ maskText: text, mask: parseMask(trimmed), maskError: null });
        } catch (e) {
            setElevationOptions({ maskText: text, maskError: e instanceof Error ? e.message : String(e) });
        }
    }

    async function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        setLoading(true);
        try {
            const img = await loadElevationImage(file);
            setElevationOptions({ heightmap: img, heightmapError: null });
        } catch (err) {
            setElevationOptions({
                heightmap: null,
                heightmapError: err instanceof Error ? err.message : String(err),
            });
        } finally {
            setLoading(false);
            if (fileInputRef.current) fileInputRef.current.value = '';
        }
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <Row label="mode">
                {ELEVATION_MODES.map((m) => (
                    <ToggleBtn key={m.id} active={mode === m.id} onClick={() => setElevationOptions({ mode: m.id })}>
                        {m.label}
                    </ToggleBtn>
                ))}
            </Row>
            <Row label="size">
                <NumberInput value={size} onChange={(size) => setElevationOptions({ size })} min={1} />
                <Range value={size} onChange={(size) => setElevationOptions({ size })} min={1} max={32} />
            </Row>
            <Row label="y limit">
                <NumberInput value={yLimit} onChange={(yLimit) => setElevationOptions({ yLimit })} min={1} />
                <Range value={yLimit} onChange={(yLimit) => setElevationOptions({ yLimit })} min={1} max={64} />
            </Row>
            <Row label="amount">
                <NumberInput value={amount} onChange={(amount) => setElevationOptions({ amount })} min={1} />
                <Range value={amount} onChange={(amount) => setElevationOptions({ amount })} min={1} max={64} />
            </Row>
            <Row label="falloff">
                <div className="flex gap-1 flex-1">
                    {ELEVATION_FALLOFFS.map((f) => (
                        <FalloffButton
                            key={f.id}
                            active={falloff === f.id}
                            label={f.label}
                            fn={f.fn}
                            onClick={() => setElevationOptions({ falloff: f.id })}
                        />
                    ))}
                </div>
            </Row>
            <Row label="apply">
                <ToggleBtn active={applyMode === 'single'} onClick={() => setElevationOptions({ applyMode: 'single' })}>
                    single
                </ToggleBtn>
                <ToggleBtn active={applyMode === 'continuous'} onClick={() => setElevationOptions({ applyMode: 'continuous' })}>
                    continuous
                </ToggleBtn>
            </Row>
            {applyMode === 'continuous' && (
                <Row label="rate">
                    <NumberInput value={rate} onChange={(rate) => setElevationOptions({ rate })} min={1} />
                    <Range value={rate} onChange={(rate) => setElevationOptions({ rate })} min={1} max={64} />
                </Row>
            )}
            <Row label="heightmap">
                <input ref={fileInputRef} type="file" accept="image/*" onChange={onFileChange} className="hidden" />
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading}
                    className="px-2 py-0.5 text-[10px] font-mono rounded text-neutral-400 hover:text-neutral-200"
                >
                    {loading ? 'loading…' : heightmap ? heightmap.name : 'load…'}
                </button>
                {heightmap && (
                    <button
                        type="button"
                        onClick={() => setElevationOptions({ heightmap: null, heightmapError: null })}
                        className="px-1.5 py-0.5 text-[10px] font-mono rounded text-neutral-500 hover:text-neutral-200"
                        title="clear heightmap"
                    >
                        ×
                    </button>
                )}
            </Row>
            {heightmapError && <div className="text-[10px] font-mono text-red-400 pl-16">{heightmapError}</div>}
            <Row label="pattern">
                <ExprInput
                    value={patternText}
                    placeholder="(extend surface)"
                    suggest={suggestPattern}
                    onChange={commitPattern}
                    error={patternError}
                />
            </Row>
            <Row label="mask">
                <ExprInput value={maskText} placeholder="(none)" suggest={suggestMask} onChange={commitMask} error={maskError} />
            </Row>
        </div>
    );
}

// ── inspect ────────────────────────────────────────────────────────

export function InspectOptions() {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex flex-col gap-1 px-2 py-1.5">
                <SelectionSummary idle="click a node or voxel to select" />
                <SelectTargetRow />
            </div>
        </div>
    );
}

// ── transform ──────────────────────────────────────────────────────

function PivotRow() {
    const placementActive = useEditRoom((s) => s.placementActive);
    const pivotOffset = useEditRoom((s) => s.transformPivotOffset);
    const setPreset = useEditRoom((s) => s.setPlacementPivotPreset);

    if (!placementActive) return null;

    // derive active preset from current offset (best-effort, custom won't match)
    const [px, py, pz] = pivotOffset;
    const isMin = px === 0 && py === 0 && pz === 0;

    function presetBtn(preset: PivotPreset, label: string, hint: string) {
        const active = preset === 'min' ? isMin : false; // approximate; good enough for min
        return (
            <button
                type="button"
                title={`pivot ${label} (${hint})`}
                onClick={() => setPreset(preset)}
                className={`px-2 py-0.5 text-[10px] font-mono rounded transition-colors ${
                    active ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:text-neutral-200'
                }`}
            >
                {label}
            </button>
        );
    }

    return (
        <Row label="pivot">
            {presetBtn('min', 'min', '[')}
            {presetBtn('center', 'center', ']')}
            {presetBtn('max', 'max', '\\')}
        </Row>
    );
}

export function TransformOptions() {
    const transformMode = useEditRoom((s) => s.transformMode);
    const setTransformMode = useEditRoom((s) => s.setTransformMode);
    const transformSpace = useEditRoom((s) => s.transformSpace);
    const setTransformSpace = useEditRoom((s) => s.setTransformSpace);
    const translationSnap = useEditRoom((s) => s.translationSnap);
    const setTranslationSnap = useEditRoom((s) => s.setTranslationSnap);
    const rotationSnap = useEditRoom((s) => s.rotationSnap);
    const setRotationSnap = useEditRoom((s) => s.setRotationSnap);
    const scaleSnap = useEditRoom((s) => s.scaleSnap);
    const setScaleSnap = useEditRoom((s) => s.setScaleSnap);
    const placementActive = useEditRoom((s) => s.placementActive);
    const snapTo = useEditRoom((s) => s.snapTo);
    const setSnapTo = useEditRoom((s) => s.setSnapTo);
    const transformHasVoxels = useEditRoom((s) => s.transformHasVoxels);

    function modeBtn(mode: TransformMode, label: string) {
        // scale is unenterable when transform has voxels (placement or selection)
        const disabled = mode === 'scale' && transformHasVoxels;
        return (
            <ToggleBtn active={transformMode === mode} disabled={disabled} onClick={() => setTransformMode(mode)}>
                {label}
            </ToggleBtn>
        );
    }

    function spaceBtn(space: TransformSpace, label: string) {
        return (
            <ToggleBtn active={transformSpace === space} onClick={() => setTransformSpace(space)}>
                {label}
            </ToggleBtn>
        );
    }

    function snapRow(
        label: string,
        value: number | null,
        onChange: (v: number | null) => void,
        presets: number[],
        defaultOn: number,
    ) {
        const enabled = value !== null;
        return (
            <Row label={label}>
                <button
                    type="button"
                    title={enabled ? 'disable snap' : 'enable snap'}
                    onClick={() => onChange(enabled ? null : defaultOn)}
                    className={`w-5 h-4 rounded text-[9px] font-mono border transition-colors shrink-0 ${
                        enabled ? 'bg-blue-600 border-blue-500 text-white' : 'bg-neutral-800 border-neutral-700 text-neutral-500'
                    }`}
                >
                    {enabled ? '✓' : '–'}
                </button>
                {presets.map((p) => (
                    <ToggleBtn key={p} active={enabled && value === p} onClick={() => onChange(p)}>
                        {p}
                    </ToggleBtn>
                ))}
            </Row>
        );
    }

    return (
        <div className="flex flex-col gap-1 px-2 py-1.5">
            <SelectionSummary />
            {placementActive && (
                <div className="text-[10px] font-mono text-neutral-500 italic">enter to commit · esc to cancel</div>
            )}
            <Row label="mode">
                {modeBtn('translate', 'translate')}
                {modeBtn('rotate', 'rotate')}
                {modeBtn('scale', 'scale')}
                {modeBtn('place', 'place')}
                {modeBtn('grab', 'grab')}
            </Row>
            {transformMode === 'grab' && (
                <div className="text-[10px] font-mono text-neutral-500 italic">
                    click + hold a node to grab · scroll to adjust distance
                </div>
            )}
            {transformMode !== 'grab' && (
                <>
                    <Row label="space">
                        {spaceBtn('world', 'world')}
                        {spaceBtn('local', 'local')}
                    </Row>
                    {snapRow('pos snap', translationSnap, setTranslationSnap, [0.25, 0.5, 1, 2, 4], 1)}
                    {snapRow('rot snap', rotationSnap, setRotationSnap, [15, 30, 45, 90], 45)}
                    {snapRow('scl snap', scaleSnap, setScaleSnap, [0.1, 0.25, 0.5, 1], 0.25)}
                </>
            )}
            {transformMode !== 'grab' && (
                <Row label="snap to">
                    <ToggleBtn
                        active={!transformHasVoxels && snapTo === 'face-center'}
                        onClick={() => setSnapTo('face-center')}
                        disabled={transformHasVoxels}
                    >
                        face center
                    </ToggleBtn>
                    <ToggleBtn active={transformHasVoxels || snapTo === 'corner'} onClick={() => setSnapTo('corner')}>
                        block corner
                    </ToggleBtn>
                </Row>
            )}
            {transformMode !== 'grab' && <PivotRow />}
        </div>
    );
}

// ── root ───────────────────────────────────────────────────────────

export function ToolOptions() {
    const activeTool = useEditRoom((s) => s.activeTool);

    return (
        <div className="flex flex-col border-t border-neutral-200">
            {activeTool === 'inspect' && <InspectOptions />}
            {activeTool === 'transform' && <TransformOptions />}
            {activeTool === 'build' && <BuildOptions />}
            {activeTool === 'box-select' && <BoxSelectOptions />}
            {activeTool === 'magic-select' && <MagicSelectOptions />}
            {activeTool === 'lasso-select' && <LassoSelectOptions />}
            {activeTool === 'brush-select' && <BrushSelectOptions />}
            {activeTool === 'paint' && <PaintOptions />}
            {activeTool === 'brush' && <BrushOptions />}
            {activeTool === 'smooth' && <SmoothOptions />}
            {activeTool === 'elevation' && <ElevationOptions />}
        </div>
    );
}
