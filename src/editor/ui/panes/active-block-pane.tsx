import { registry } from '../../../core/registry';
import { formatKey, parseKey } from '../../../core/voxels/block-registry';
import type { BlockStateDef } from '../../../core/voxels/block-state';
import { useEditRoom } from '../../edit-room-store';
import { useEditor } from '../../editor-store';
import { activeBlockKeyOf } from '../../inventory';

function stateLabel(states: BlockStateDef, localIndex: number): string {
    const props = states.props;
    const keys = Object.keys(props);
    if (keys.length === 0) return 'default';
    const decoded = states.decode(localIndex) as Record<string, unknown>;
    if (keys.length === 1) {
        const v = decoded[keys[0]!];
        return v === true ? 'true' : v === false ? 'false' : String(v);
    }
    return keys
        .map((k) => {
            const v = decoded[k];
            const vs = v === true ? 'true' : v === false ? 'false' : String(v);
            return `${k}=${vs}`;
        })
        .join(' ');
}

function BlockIcon({ stateKey, size = 24 }: { stateKey: string; size?: number }) {
    const atlasUrl = useEditor((s) => s.blockIconAtlasUrl);
    const coords = useEditor((s) => s.blockIconCoords);
    const cols = useEditor((s) => s.blockIconCols);
    const rows = useEditor((s) => s.blockIconRows);

    const pos = coords[stateKey];
    if (!atlasUrl || !pos || !cols || !rows)
        return <div style={{ width: size, height: size }} className="bg-surface-muted rounded" />;

    const [col, row] = pos;
    return (
        <div
            style={{
                width: size,
                height: size,
                backgroundImage: `url(${atlasUrl})`,
                backgroundSize: `${cols * size}px ${rows * size}px`,
                backgroundPosition: `-${col * size}px -${row * size}px`,
                backgroundRepeat: 'no-repeat',
                imageRendering: 'auto',
            }}
        />
    );
}

/**
 * shows the currently selected block + its available state variants.
 */
export function ActiveBlockPane() {
    const room = useEditor((s) => s.room);
    const hotbar = useEditor((s) => s.hotbar);
    const activeSlotIndex = useEditRoom((s) => s.activeSlotIndex);
    const activeBlockKey = activeBlockKeyOf(hotbar, activeSlotIndex);
    const setHotbarSlot = useEditor((s) => s.setHotbarSlot);
    const setBlockState = (key: string) => setHotbarSlot(activeSlotIndex, { kind: 'block', blockKey: key });

    if (!room) return <div className="px-2 py-2 text-[10px] font-mono text-fg-muted">no scene loaded</div>;

    const { defs } = registry.blockRegistry;
    const parsed = parseKey(activeBlockKey);
    const activeId = parsed?.blockId ?? '';
    const activeDef = defs.find((d) => d.id === activeId);

    if (!activeDef) {
        return <div className="px-2 py-2 text-[10px] font-mono text-fg-muted italic">none selected</div>;
    }

    return (
        <div className="p-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
                <BlockIcon stateKey={activeBlockKey} size={32} />
                <div className="text-[12px] font-mono font-semibold text-fg">{activeDef.id}</div>
            </div>
            {activeDef.states.totalStates > 1 && (
                <div className="flex flex-wrap gap-1">
                    {Array.from({ length: activeDef.states.totalStates }, (_, i) => {
                        const key = formatKey(activeDef.id, activeDef.states, i);
                        const active = key === activeBlockKey;
                        return (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setBlockState(key)}
                                title={key}
                                className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono cursor-pointer whitespace-nowrap ${
                                    active
                                        ? 'border-accent bg-accent/25 text-fg'
                                        : 'border-border bg-surface text-fg hover:border-fg-muted hover:text-fg'
                                }`}
                            >
                                <BlockIcon stateKey={key} size={16} />
                                {stateLabel(activeDef.states, i)}
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
