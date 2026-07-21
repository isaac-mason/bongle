import * as Icons from "../../../icons";
import { type EulerOrder, euler, type Quat, quat } from 'mathcat';
import { type ComponentProps, forwardRef, type ReactNode, useEffect, useRef, useState } from 'react';
import { IconButton, Input, SearchableSelect, type SearchableSelectItem } from '../../client/ui/components';
import { registry } from '../../core/registry';
import type { Node, Realm } from '../../core/scene/scene-tree';
import { createPrefabConfig, getNodeById } from '../../core/scene/scene-tree';
import type { BlockRefSchema, PrefabRefSchema, Schema } from '../../core/scene/prop/prop';
import { type EnumOption, enumLabel, enumValue } from '../../core/scene/prop/prop';
import * as Selection from '../../core/scene/selection';
import type { ControlDef, TraitDef } from '../../core/scene/traits';
import { formatKey } from '../../core/voxels/block-registry';
import { PrefabThumb } from './prefab-thumb';
import { useEditRoom } from '../edit-room-store';
import { useEditor } from '../editor-store';

function useTraits(): TraitDef[] {
    return [...registry.traits.byId.values()];
}

function useTraitsBySlot(): Map<number, TraitDef> {
    return registry.slotToTrait;
}

/* ── Schema-driven property editors ─────────────────────────────── */

function NumberEditor({
    value,
    schema,
    onChange,
}: {
    value: number;
    schema: { min?: number; max?: number; step?: number };
    onChange: (v: number) => void;
}) {
    return (
        <Input
            type="number"
            value={value}
            min={schema.min}
            max={schema.max}
            step={schema.step}
            onChange={(e) => onChange(Number(e.target.value))}
        />
    );
}

function StringEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    return <Input type="text" value={value} onChange={(e) => onChange(e.target.value)} />;
}

function BooleanEditor({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
    return <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="accent-accent" />;
}

/* ── Quaternion editor (Blender-style mode toggle) ──────────────── */

import { loadInspectorRotationMode, type InspectorRotationMode as RotationMode, saveInspectorRotationMode } from '../preferences';

const ROTATION_MODES: { value: RotationMode; label: string }[] = [
    { value: 'quat', label: 'Quat (XYZW)' },
    { value: 'xyz', label: 'Euler XYZ°' },
    { value: 'xzy', label: 'Euler XZY°' },
    { value: 'yxz', label: 'Euler YXZ°' },
    { value: 'yzx', label: 'Euler YZX°' },
    { value: 'zxy', label: 'Euler ZXY°' },
    { value: 'zyx', label: 'Euler ZYX°' },
];

const RAD_TO_DEG = 180 / Math.PI;

function quatToEulerDegrees(q: number[], order: EulerOrder): [number, number, number] {
    const out: [number, number, number, EulerOrder] = [0, 0, 0, order];
    euler.fromQuat(out, q as Quat, order);
    return [out[0] * RAD_TO_DEG, out[1] * RAD_TO_DEG, out[2] * RAD_TO_DEG];
}

function QuaternionEditor({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
    const [mode, setMode] = useState<RotationMode>(loadInspectorRotationMode);
    const updateMode = (next: RotationMode) => {
        saveInspectorRotationMode(next);
        setMode(next);
    };

    return (
        <div className="space-y-1">
            <SearchableSelect<RotationMode>
                items={ROTATION_MODES.map((m) => ({ id: m.value, label: m.label }))}
                value={mode}
                onSelect={updateMode}
                placeholder="search modes…"
            />
            {mode === 'quat' ? (
                <VectorEditor value={value} onChange={onChange} labels={['X', 'Y', 'Z', 'W']} />
            ) : (
                <EulerInputs value={value} order={mode} onChange={onChange} />
            )}
        </div>
    );
}

/**
 * Three Euler-angle inputs (degrees). Draft is the source of truth while the
 * user is editing; we only commit (euler→quat→onChange) on blur or Enter.
 * That avoids round-tripping the canonical quat back through decode on every
 * keystroke, which would jitter the unfocused axes (especially near gimbal
 * lock) and fight the user's typing.
 *
 * Draft is held as strings so intermediate states like "" / "-" / "1." don't
 * coerce to NaN-or-zero mid-typing.
 */
function EulerInputs({ value, order, onChange }: { value: number[]; order: EulerOrder; onChange: (q: number[]) => void }) {
    const draftFromValue = (): [string, string, string] => {
        const e = quatToEulerDegrees(value, order);
        return [String(e[0]), String(e[1]), String(e[2])];
    };
    const focusedRef = useRef(false);
    const [draft, setDraft] = useState<[string, string, string]>(draftFromValue);

    // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync the draft only on external value/order changes, not on every draftFromValue re-creation
    useEffect(() => {
        if (!focusedRef.current) setDraft(draftFromValue());
    }, [value, order]);

    const commit = (current: [string, string, string]) => {
        const x = Number(current[0]);
        const y = Number(current[1]);
        const z = Number(current[2]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
        const q: Quat = [0, 0, 0, 1];
        quat.fromDegrees(q, x, y, z, order);
        onChange([q[0], q[1], q[2], q[3]]);
    };

    return (
        <div className="flex gap-1">
            {(['X', 'Y', 'Z'] as const).map((label, i) => (
                <div key={label} className="flex items-center gap-0.5 flex-1 min-w-0">
                    <span className="text-[10px] font-mono text-fg shrink-0">{label}</span>
                    <Input
                        type="number"
                        value={draft[i]}
                        onChange={(e) => {
                            const next: [string, string, string] = [draft[0], draft[1], draft[2]];
                            next[i] = e.target.value;
                            setDraft(next);
                        }}
                        onFocus={() => {
                            focusedRef.current = true;
                        }}
                        onBlur={() => {
                            focusedRef.current = false;
                            commit(draft);
                        }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                e.currentTarget.blur();
                            } else if (e.key === 'Escape') {
                                e.preventDefault();
                                setDraft(draftFromValue());
                                focusedRef.current = false;
                                e.currentTarget.blur();
                            }
                        }}
                        className="min-w-0"
                    />
                </div>
            ))}
        </div>
    );
}

function VectorEditor({ value, onChange, labels }: { value: number[]; onChange: (v: number[]) => void; labels: string[] }) {
    return (
        <div className="flex gap-1">
            {labels.map((label, i) => (
                <div key={label} className="flex items-center gap-0.5 flex-1 min-w-0">
                    <span className="text-[10px] font-mono text-fg shrink-0">{label}</span>
                    <Input
                        type="number"
                        value={value[i] ?? 0}
                        onChange={(e) => {
                            const next = [...value];
                            next[i] = Number(e.target.value);
                            onChange(next);
                        }}
                        className="min-w-0"
                    />
                </div>
            ))}
        </div>
    );
}

function EnumEditor({
    value,
    options,
    onChange,
}: {
    value: string | number;
    options: readonly EnumOption[];
    onChange: (v: string | number) => void;
}) {
    const items: SearchableSelectItem<string | number>[] = options.map((opt) => ({
        id: enumValue(opt),
        label: String(enumLabel(opt)),
    }));
    return <SearchableSelect<string | number> items={items} value={value} onSelect={onChange} placeholder="search…" />;
}

function TupleEditor({
    value,
    schema,
    onChange,
}: {
    value: unknown[];
    schema: { type: 'tuple'; of: Schema[] };
    onChange: (v: unknown[]) => void;
}) {
    return (
        <div className="space-y-1">
            {schema.of.map((itemSchema, i) => (
                <div key={String(i)} className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-fg-muted w-4 shrink-0">{i}:</span>
                    <PropertyEditor
                        schema={itemSchema}
                        value={value[i]}
                        onChange={(newVal) => {
                            const next = [...value];
                            next[i] = newVal;
                            onChange(next);
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

function ObjectEditor({
    value,
    schema,
    onChange,
}: {
    value: Record<string, unknown>;
    schema: { type: 'object'; fields: Record<string, Schema> };
    onChange: (v: Record<string, unknown>) => void;
}) {
    return (
        <div className="space-y-1 pl-2 border-l border-border">
            {Object.entries(schema.fields).map(([key, fieldSchema]) => (
                <div key={key}>
                    <span className="block text-[10px] font-mono text-fg mb-0.5">{key}</span>
                    <PropertyEditor
                        schema={fieldSchema}
                        value={value?.[key]}
                        onChange={(newVal) => {
                            onChange({ ...value, [key]: newVal });
                        }}
                    />
                </div>
            ))}
        </div>
    );
}

function ListEditor({
    value,
    schema,
    onChange,
}: {
    value: unknown[];
    schema: { type: 'list'; of: Schema };
    onChange: (v: unknown[]) => void;
}) {
    return (
        <div className="space-y-1">
            {value.map((item, i) => (
                <div key={String(i)} className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-fg-muted w-4 shrink-0">{i}</span>
                    <div className="flex-1 min-w-0">
                        <PropertyEditor
                            schema={schema.of}
                            value={item}
                            onChange={(newVal) => {
                                const next = [...value];
                                next[i] = newVal;
                                onChange(next);
                            }}
                        />
                    </div>
                    <IconButton
                        variant="danger"
                        onClick={() => {
                            const next = value.filter((_, idx) => idx !== i);
                            onChange(next);
                        }}
                    >
                        <Icons.X size={10} />
                    </IconButton>
                </div>
            ))}
            <button
                type="button"
                onClick={() => onChange([...value, null])}
                className="flex items-center gap-1 text-[10px] font-mono text-fg hover:text-fg"
            >
                <Icons.Plus size={10} /> Add
            </button>
        </div>
    );
}

function UnionEditor({
    value,
    schema,
    onChange,
}: {
    value: Record<string, unknown>;
    schema: { type: 'union'; key: string; variants: Array<{ type: 'object'; fields: Record<string, Schema> }> };
    onChange: (v: Record<string, unknown>) => void;
}) {
    const discriminator = value?.[schema.key];
    const selectedVariant = schema.variants.find((v) => {
        const lit = v.fields[schema.key];
        return lit && lit.type === 'literal' && lit.value === discriminator;
    });

    const variantItems: SearchableSelectItem<string>[] = schema.variants.map((variant, i) => {
        const lit = variant.fields[schema.key];
        const label = lit && lit.type === 'literal' ? String(lit.value) : `variant ${i}`;
        return { id: label, label };
    });

    return (
        <div className="space-y-1">
            <SearchableSelect<string>
                items={variantItems}
                value={String(discriminator ?? '')}
                onSelect={(newDiscriminator) => {
                    const variant = schema.variants.find((v) => {
                        const lit = v.fields[schema.key];
                        return lit && lit.type === 'literal' && String(lit.value) === newDiscriminator;
                    });
                    if (!variant) return;
                    const next: Record<string, unknown> = {};
                    for (const [k, s] of Object.entries(variant.fields)) {
                        // skip the discriminator, we set it explicitly below
                        if (k === schema.key) continue;
                        if (s.type === 'number') next[k] = 0;
                        else if (s.type === 'string') next[k] = '';
                        else if (s.type === 'boolean') next[k] = false;
                        else if (s.type === 'vector2') next[k] = [0, 0];
                        else if (s.type === 'vector3') next[k] = [0, 0, 0];
                        else if (s.type === 'vector4' || s.type === 'quaternion') next[k] = [0, 0, 0, 0];
                        else if (s.type === 'literal') next[k] = s.value;
                        // other complex types (object, list, union…) left undefined,
                        // the editor will render them with their own fallback defaults
                    }
                    next[schema.key] = newDiscriminator;
                    onChange(next);
                }}
                placeholder="search variants…"
            />
            {selectedVariant && (
                <div className="pl-2 border-l border-border">
                    {Object.entries(selectedVariant.fields)
                        .filter(([k]) => k !== schema.key)
                        .map(([key, fieldSchema]) => (
                            <div key={key}>
                                <span className="block text-[10px] font-mono text-fg mb-0.5">{key}</span>
                                <PropertyEditor
                                    schema={fieldSchema}
                                    value={value?.[key]}
                                    onChange={(newVal) => {
                                        onChange({ ...value, [key]: newVal });
                                    }}
                                />
                            </div>
                        ))}
                </div>
            )}
        </div>
    );
}

function defaultForSchema(schema: Schema): unknown {
    switch (schema.type) {
        case 'boolean':
            return false;
        case 'number':
            return 0;
        case 'string':
            return '';
        case 'vector2':
            return [0, 0];
        case 'vector3':
            return [0, 0, 0];
        case 'vector4':
            return [0, 0, 0, 0];
        case 'quaternion':
            return [0, 0, 0, 1];
        case 'list':
            return [];
        case 'tuple':
            return schema.of.map(defaultForSchema);
        case 'object': {
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(schema.fields)) obj[k] = defaultForSchema(v);
            return obj;
        }
        case 'record':
            return {};
        case 'literal':
            return schema.value;
        case 'enumeration':
            return enumValue(schema.values[0]);
        case 'nullable':
            return null;
        case 'optional':
            return undefined;
        case 'nullish':
            return null;
        case 'mesh':
            return null;
        case 'prefab':
        case 'block':
            return '';
        case 'union': {
            const variant = schema.variants[0];
            const obj: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(variant.fields)) obj[k] = defaultForSchema(v);
            return obj;
        }
    }
}

function OptionalEditor({
    value,
    schema,
    onChange,
    label,
}: {
    value: unknown;
    schema: { type: 'optional' | 'nullable' | 'nullish'; of: Schema };
    onChange: (v: unknown) => void;
    label: string;
}) {
    const hasValue = value !== undefined && value !== null;

    return (
        <div className="space-y-1">
            <label className="flex items-center gap-1 text-[10px] font-mono text-fg">
                <input
                    type="checkbox"
                    checked={hasValue}
                    onChange={(e) => {
                        if (e.target.checked) {
                            onChange(defaultForSchema(schema.of));
                        } else {
                            onChange(schema.type === 'nullable' ? null : undefined);
                        }
                    }}
                    className="accent-accent"
                />
                {label}
            </label>
            {hasValue && (
                <div className="pl-2 border-l border-border">
                    <PropertyEditor schema={schema.of} value={value} onChange={onChange} />
                </div>
            )}
        </div>
    );
}

function MeshEditor({
    value,
    onChange,
}: {
    value: { modelId: string; meshName: string } | null;
    onChange: (v: { modelId: string; meshName: string } | null) => void;
}) {
    const resources = useEditor((state) => state.resources);
    const meshes: Array<{ modelId: string; meshName: string }> = [];
    if (resources) {
        for (const [modelId, entry] of resources.models) {
            if (!entry.handle) continue;
            for (const meshName of Object.keys(entry.handle.meshes)) {
                meshes.push({ modelId, meshName });
            }
        }
    }
    const current = value ? `${value.modelId}/${value.meshName}` : '';
    const items: SearchableSelectItem<string>[] = [
        { id: '', label: 'none' },
        ...meshes.map(({ modelId, meshName }) => ({
            id: `${modelId}/${meshName}`,
            label: `${modelId}/${meshName}`,
        })),
    ];
    return (
        <SearchableSelect<string>
            items={items}
            value={current}
            onSelect={(raw) => {
                if (!raw) {
                    onChange(null);
                    return;
                }
                const slash = raw.indexOf('/');
                onChange({ modelId: raw.slice(0, slash), meshName: raw.slice(slash + 1) });
            }}
            placeholder="search meshes…"
            emptyLabel="none"
        />
    );
}

function PrefabRefEditor({ value, onChange }: { value: string; schema: PrefabRefSchema; onChange: (v: string) => void }) {
    const room = useEditor((s) => s.room);
    if (!room) return null;
    const prefabDefs = registry.prefabs.byId;
    const ids = Array.from(prefabDefs.keys()).sort();
    const thumbSize = 16;
    const items: SearchableSelectItem<string>[] = [
        { id: '', label: 'none' },
        ...ids.map((id) => {
            const def = prefabDefs.get(id);
            const name = def?.name ?? id;
            const leading = (
                <PrefabThumb key={id} prefabId={id} size={thumbSize} className="rounded-sm overflow-hidden shrink-0" />
            );
            return { id, label: name, sublabel: name === id ? undefined : id, leading };
        }),
    ];
    return (
        <SearchableSelect<string>
            items={items}
            value={value}
            onSelect={(id) => onChange(id)}
            placeholder="search prefabs…"
            emptyLabel="none"
        />
    );
}

function BlockRefEditor({ value, onChange }: { value: string; schema: BlockRefSchema; onChange: (v: string) => void }) {
    const room = useEditor((s) => s.room);
    const blockIconAtlasUrl = useEditor((s) => s.blockIconAtlasUrl);
    const blockIconCoords = useEditor((s) => s.blockIconCoords);
    const blockIconPx = useEditor((s) => s.blockIconPx);
    const blockIconCols = useEditor((s) => s.blockIconCols);
    if (!room) return null;
    const defs = registry.blockRegistry.defs;
    const thumbSize = 16;
    const hasAtlas = blockIconAtlasUrl && blockIconPx > 0 && blockIconCols > 0;
    const items: SearchableSelectItem<string>[] = [
        { id: '', label: 'none' },
        ...defs.map((def) => {
            const coord = blockIconCoords[def.id];
            const leading =
                hasAtlas && coord ? (
                    <div
                        key={def.id}
                        className="rounded-sm overflow-hidden shrink-0"
                        style={{
                            width: thumbSize,
                            height: thumbSize,
                            backgroundImage: `url(${blockIconAtlasUrl})`,
                            backgroundPosition: `-${coord[0] * thumbSize}px -${coord[1] * thumbSize}px`,
                            backgroundSize: `${blockIconCols * thumbSize}px auto`,
                            imageRendering: 'pixelated' as const,
                        }}
                    />
                ) : null;
            const name = def.name ?? def.id;
            return { id: def.id, label: name, sublabel: name === def.id ? undefined : def.id, leading };
        }),
    ];
    return (
        <SearchableSelect<string>
            items={items}
            value={value}
            onSelect={(id) => onChange(id)}
            placeholder="search blocks…"
            emptyLabel="none"
        />
    );
}

function LiteralEditor({ value }: { value: unknown }) {
    return <span className="text-[10px] font-mono text-fg">{String(value)}</span>;
}

function RecordEditor({
    value,
    schema,
    onChange,
}: {
    value: Record<string, unknown>;
    schema: { type: 'record'; field: Schema };
    onChange: (v: Record<string, unknown>) => void;
}) {
    const entries = Object.entries(value ?? {});

    return (
        <div className="space-y-1">
            {entries.map(([k, v]) => (
                <div key={k} className="flex items-center gap-1">
                    <span className="text-[10px] font-mono text-fg w-16 truncate shrink-0">{k}</span>
                    <div className="flex-1 min-w-0">
                        <PropertyEditor
                            schema={schema.field}
                            value={v}
                            onChange={(newVal) => {
                                onChange({ ...value, [k]: newVal });
                            }}
                        />
                    </div>
                    <IconButton
                        variant="danger"
                        onClick={() => {
                            const next = { ...value };
                            delete next[k];
                            onChange(next);
                        }}
                    >
                        <Icons.X size={10} />
                    </IconButton>
                </div>
            ))}
            <button
                type="button"
                onClick={() => {
                    const newKey = `key${Object.keys(value ?? {}).length}`;
                    onChange({ ...value, [newKey]: null });
                }}
                className="flex items-center gap-1 text-[10px] font-mono text-fg hover:text-fg"
            >
                <Icons.Plus size={10} /> Add
            </button>
        </div>
    );
}

/**
 * Render an editor for a single property value based on its schema type.
 * Falls back to a JSON text display for complex/unrecognized schemas.
 */
function PropertyEditor({ schema, value, onChange }: { schema: Schema; value: unknown; onChange: (v: unknown) => void }) {
    switch (schema.type) {
        case 'number':
            return <NumberEditor value={(value as number) ?? 0} schema={schema} onChange={onChange} />;
        case 'string':
            return <StringEditor value={(value as string) ?? ''} onChange={onChange} />;
        case 'boolean':
            return <BooleanEditor value={(value as boolean) ?? false} onChange={onChange} />;
        case 'vector2':
            return <VectorEditor value={(value as number[]) ?? [0, 0]} onChange={onChange} labels={['X', 'Y']} />;
        case 'vector3':
            return <VectorEditor value={(value as number[]) ?? [0, 0, 0]} onChange={onChange} labels={['X', 'Y', 'Z']} />;
        case 'vector4':
            return <VectorEditor value={(value as number[]) ?? [0, 0, 0, 0]} onChange={onChange} labels={['X', 'Y', 'Z', 'W']} />;
        case 'quaternion':
            return <QuaternionEditor value={(value as number[]) ?? [0, 0, 0, 1]} onChange={onChange} />;
        case 'enumeration':
            return <EnumEditor value={value as string | number} options={schema.values} onChange={onChange} />;
        case 'tuple':
            return <TupleEditor value={(value as unknown[]) ?? []} schema={schema} onChange={onChange} />;
        case 'object':
            return <ObjectEditor value={(value as Record<string, unknown>) ?? {}} schema={schema} onChange={onChange} />;
        case 'list':
            return <ListEditor value={(value as unknown[]) ?? []} schema={schema} onChange={onChange} />;
        case 'union':
            return <UnionEditor value={(value as Record<string, unknown>) ?? {}} schema={schema} onChange={onChange} />;
        case 'optional':
            return <OptionalEditor value={value} schema={schema} onChange={onChange} label="optional" />;
        case 'nullable':
            return <OptionalEditor value={value} schema={schema} onChange={onChange} label="nullable" />;
        case 'nullish':
            return <OptionalEditor value={value} schema={schema} onChange={onChange} label="nullish" />;
        case 'literal':
            return <LiteralEditor value={value} />;
        case 'record':
            return <RecordEditor value={(value as Record<string, unknown>) ?? {}} schema={schema} onChange={onChange} />;
        case 'mesh':
            return <MeshEditor value={(value as { modelId: string; meshName: string } | null) ?? null} onChange={onChange} />;
        case 'prefab':
            return <PrefabRefEditor value={(value as string) ?? ''} schema={schema} onChange={onChange} />;
        case 'block':
            return <BlockRefEditor value={(value as string) ?? ''} schema={schema} onChange={onChange} />;
        default:
            return <span className="text-[10px] font-mono text-fg break-all">{JSON.stringify(value)}</span>;
    }
}

/* ── Trait section ──────────────────────────────────────────────── */

function TraitSection({ node, traitSlot }: { node: Node; traitSlot: number }) {
    const traitsBySlot = useTraitsBySlot();
    const removeTrait = useEditRoom((s) => s.removeTrait);
    const setTrait = useEditRoom((s) => s.setTrait);
    const def = traitsBySlot.get(traitSlot);
    if (!def) return null;

    const instance = node._traits.get(traitSlot);

    // collect controls for display
    const propertyEntries: Array<{ key: string; reg: ControlDef; value: unknown }> = [];
    for (const reg of def.controls) {
        if (reg.hidden) continue;
        propertyEntries.push({
            key: reg.controlId,
            reg,
            value: instance ? reg.get(instance) : undefined,
        });
    }

    const isEditorOwned = def.id === 'editor' || def.id.startsWith('editor.');

    return (
        <div className="border border-border rounded">
            <div className="flex items-center justify-between px-2 py-1 bg-surface-muted">
                <span className="text-[11px] font-mono font-semibold text-fg">{def.id}</span>
                {node.scene && isEditorOwned && <Icons.Lock size={11} className="text-fg-muted" />}
                {node.scene && !isEditorOwned && (
                    <IconButton
                        variant="danger"
                        onClick={() => {
                            removeTrait(node.id, def.id);
                        }}
                    >
                        <Icons.X size={12} />
                    </IconButton>
                )}
            </div>
            {propertyEntries.length === 0 ? (
                <div className="px-2 py-1 text-[10px] font-mono text-fg-muted italic">no editable properties</div>
            ) : (
                <div className="px-2 py-1.5 space-y-1.5">
                    {propertyEntries.map(({ key, reg, value }) => (
                        <div key={key}>
                            <span className="block text-[10px] font-mono text-fg mb-0.5">{reg.label ?? key}</span>
                            <PropertyEditor
                                schema={reg.schema}
                                value={value}
                                onChange={(newValue) => {
                                    setTrait(node.id, def.id, { [key]: newValue });
                                }}
                            />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/* ── Unresolved trait section ───────────────────────────────────── */

function UnresolvedTraitSection({
    node,
    traitId,
    data,
}: {
    node: Node;
    traitId: string;
    data: { binary?: Uint8Array; json?: Record<string, unknown> };
}) {
    const removeTrait = useEditRoom((s) => s.removeTrait);
    return (
        <div className="border border-warn/40 rounded bg-warn/10">
            <div className="flex items-center gap-1 px-2 py-1 bg-warn/15">
                <Icons.TriangleAlert size={12} className="text-warn shrink-0" />
                <span className="text-[11px] font-mono font-semibold text-warn">{traitId}</span>
                <span className="text-[10px] font-mono text-warn ml-auto">unresolved</span>
                {node.scene && (
                    <IconButton variant="danger" onClick={() => removeTrait(node.id, traitId)}>
                        <Icons.X size={12} />
                    </IconButton>
                )}
            </div>
            <div className="px-2 py-1 text-[10px] font-mono text-warn">
                {data.json ? (
                    <pre className="whitespace-pre-wrap break-all">{JSON.stringify(data.json, null, 2)}</pre>
                ) : data.binary ? (
                    <span>{data.binary.byteLength} bytes (binary)</span>
                ) : (
                    <span>no data</span>
                )}
            </div>
        </div>
    );
}

/* ── Add Trait popover (renders inside section divider) ─────────── */

function AddTraitAction({ node }: { node: Node }) {
    const room = useEditor((s) => s.room);
    const addTrait = useEditRoom((s) => s.addTrait);
    const traits = useTraits();

    if (!room) return null;

    const items: SearchableSelectItem<string>[] = traits
        .filter((def) => !node._traits.has(def.slot))
        .map((def) => ({ id: def.id, label: def.name, sublabel: def.name === def.id ? undefined : def.id }));

    if (items.length === 0) return <SectionAddButton disabled />;

    return (
        <SearchableSelect<string>
            items={items}
            onSelect={(id) => addTrait(node.id, id)}
            placeholder="search traits…"
            trigger={<SectionAddButton />}
        />
    );
}

/* ── Section divider with inline label ─────────────────────────── */

/**
 * Section header: uppercase label + thin rule + optional right-aligned action
 * slot. Used by every node-inspect section so the panel reads as a vertical
 * sequence of cleanly separated blocks.
 */
function SectionDivider({ label, action }: { label: string; action?: ReactNode }) {
    return (
        <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono font-semibold text-fg-muted uppercase tracking-wide shrink-0">{label}</span>
            <div className="flex-1 h-px bg-surface-muted" />
            {action && <div className="shrink-0">{action}</div>}
        </div>
    );
}

/**
 * "+" button used inside SectionDivider to host an add-popover trigger.
 * Bordered + 20px square so it reads as a real affordance against the rule.
 */
const SectionAddButton = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(({ disabled, className, ...props }, ref) => (
    <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={`shrink-0 flex items-center justify-center w-5 h-5 rounded border ${
            disabled
                ? 'text-fg-muted border-border bg-surface-muted cursor-not-allowed'
                : 'text-fg border-border bg-surface hover:bg-surface-muted hover:border-fg-muted cursor-pointer'
        } ${className ?? ''}`}
        {...props}
    >
        <Icons.Plus size={13} />
    </button>
));
SectionAddButton.displayName = 'SectionAddButton';

/* ── Prefab section ─────────────────────────────────────────────── */

/**
 * Inline "+ Prefab" affordance shown in the Node section divider when no
 * prefab is set. Opens a popover listing available prefab defs; picking one
 * attaches a default config to the node.
 */
const AddPrefabTriggerButton = forwardRef<HTMLButtonElement, ComponentProps<'button'>>(({ className, ...props }, ref) => (
    <button
        ref={ref}
        type="button"
        className={`flex items-center gap-1 px-1.5 h-5 text-[10px] font-mono text-fg bg-surface border border-border rounded hover:bg-surface-muted hover:border-fg-muted cursor-pointer ${className ?? ''}`}
        {...props}
    >
        <Icons.Layers size={11} />
        <Icons.Plus size={11} />
    </button>
));
AddPrefabTriggerButton.displayName = 'AddPrefabTriggerButton';

function AddPrefabAction({ node }: { node: Node }) {
    const room = useEditor((s) => s.room);
    const setPrefab = useEditRoom((s) => s.setPrefab);

    const prefabDefs = room ? registry.prefabs.byId : null;
    const prefabIds = prefabDefs ? Array.from(prefabDefs.keys()).sort() : [];

    if (node.prefab || prefabIds.length === 0) return null;

    const thumbSize = 24;
    const items: SearchableSelectItem<string>[] = prefabIds.map((id) => {
        const leading = (
            <PrefabThumb key={id} prefabId={id} size={thumbSize} className="rounded-sm overflow-hidden shrink-0" />
        );
        return { id, label: id, leading };
    });

    return (
        <SearchableSelect<string>
            items={items}
            placeholder="search prefabs…"
            trigger={<AddPrefabTriggerButton />}
            onSelect={(id) => {
                const def = prefabDefs?.get(id);
                if (!def) return;
                setPrefab(
                    node.id,
                    createPrefabConfig(def.id, {
                        args: def.args ? structuredClone(def.args.default) : undefined,
                    }),
                );
            }}
        />
    );
}

/** Full prefab section, only rendered when node.prefab is set. */
function PrefabSection({ node }: { node: Node }) {
    const room = useEditor((s) => s.room);
    const setPrefab = useEditRoom((s) => s.setPrefab);
    const clearPrefab = useEditRoom((s) => s.clearPrefab);
    const prefabDefs = room ? registry.prefabs.byId : null;
    const prefabIds = prefabDefs ? Array.from(prefabDefs.keys()).sort() : [];

    const config = node.prefab;
    if (!config) return null;

    const def = prefabDefs?.get(config.prefabId);

    const isMissing = !prefabIds.includes(config.prefabId);
    const items: SearchableSelectItem<string>[] = [
        ...(isMissing ? [{ id: config.prefabId, label: config.prefabId, badge: '(missing)' }] : []),
        ...prefabIds.map((id) => ({ id, label: id })),
    ];

    return (
        <div className="space-y-1.5">
            <SectionDivider
                label="prefab"
                action={
                    <IconButton variant="danger" onClick={() => clearPrefab(node.id)} title="clear prefab">
                        <Icons.X size={12} />
                    </IconButton>
                }
            />

            {/* prefab picker */}
            <div>
                <span className="block text-[10px] font-mono text-fg mb-0.5">prefabId</span>
                <SearchableSelect<string>
                    items={items}
                    value={config.prefabId}
                    onSelect={(id) => {
                        const next = prefabDefs?.get(id);
                        if (!next) return;
                        setPrefab(node.id, {
                            ...config,
                            prefabId: next.id,
                            args: next.args ? structuredClone(next.args.default) : undefined,
                        });
                    }}
                    placeholder="search prefabs…"
                />
            </div>

            {def && <div className="text-[10px] font-mono text-fg">type: {def.type}</div>}

            {def ? (
                def.args ? (
                    <div>
                        <span className="block text-[10px] font-mono text-fg mb-0.5">args</span>
                        <PropertyEditor
                            schema={def.args.schema}
                            value={config.args ?? def.args.default}
                            onChange={(args) => {
                                setPrefab(node.id, { ...config, args });
                            }}
                        />
                    </div>
                ) : null
            ) : (
                <div className="text-[10px] font-mono text-warn">prefab def missing</div>
            )}
        </div>
    );
}

/* ── Inspector panel ────────────────────────────────────────────── */

export function InspectorPanel() {
    const room = useEditor((s) => s.room);
    const selectedNodeIds = useEditRoom((s) => s.selection.nodes);
    const voxelCount = useEditRoom((s) => Selection.countVoxels(s.selection));
    const sceneRevision = useEditRoom((s) => s.sceneRevision);
    const inspectedVoxel = useEditRoom((s) => s.inspectedVoxel);
    const setBlock = useEditRoom((s) => s.setBlock);
    const blockIconAtlasUrl = useEditor((s) => s.blockIconAtlasUrl);
    const blockIconCoords = useEditor((s) => s.blockIconCoords);
    const blockIconPx = useEditor((s) => s.blockIconPx);
    const blockIconCols = useEditor((s) => s.blockIconCols);

    void sceneRevision;

    if (!room) {
        return <div className="p-2 text-[10px] text-fg-muted font-mono">no scene loaded</div>;
    }

    // ── voxel inspect ────────────────────────────────────────────────
    if (inspectedVoxel) {
        const { wx, wy, wz, key } = inspectedVoxel;
        const blockRegistry = registry.blockRegistry;
        const stateId = blockRegistry.keyToState.get(key);

        const iconSize = 16;

        if (stateId === undefined) {
            return (
                <div className="p-2 space-y-1">
                    <SectionDivider label="voxel" />
                    <div className="text-[10px] font-mono text-fg break-all">{key}</div>
                    <div className="text-[10px] font-mono text-warn italic">unknown block</div>
                    <div className="text-[10px] font-mono text-fg-muted">
                        {wx}, {wy}, {wz}
                    </div>
                </div>
            );
        }

        const blockIndex = blockRegistry.stateToBlockIndex[stateId];
        const def = blockRegistry.defs[blockIndex];
        const propNames = Object.keys(def.states.props);
        const decoded = def.states.decode(blockRegistry.stateToLocalIndex[stateId]) as Record<string, unknown>;

        const iconCoord = blockIconCoords[def.id] ?? blockIconCoords[key];
        const hasIcon = blockIconAtlasUrl && iconCoord && blockIconPx > 0 && blockIconCols > 0;
        const iconStyle = hasIcon
            ? {
                  width: iconSize,
                  height: iconSize,
                  backgroundImage: `url(${blockIconAtlasUrl})`,
                  backgroundPosition: `-${iconCoord[0] * iconSize}px -${iconCoord[1] * iconSize}px`,
                  backgroundSize: `${blockIconCols * iconSize}px auto`,
                  imageRendering: 'pixelated' as const,
              }
            : undefined;

        return (
            <div className="p-2 space-y-2">
                <SectionDivider
                    label="voxel"
                    action={
                        <div className="flex items-center gap-1.5">
                            {hasIcon && <div className="rounded-sm overflow-hidden" style={iconStyle} />}
                            <span className="text-[10px] font-mono text-fg font-semibold">{def.id}</span>
                        </div>
                    }
                />

                {/* coords */}
                <div className="text-[10px] font-mono text-fg-muted">
                    {wx}, {wy}, {wz}
                </div>

                {/* props */}
                {propNames.length > 0 && (
                    <div className="space-y-1.5">
                        {propNames.map((propName) => {
                            const propDef = def.states.props[propName];
                            const currentVal = decoded[propName];

                            const seen = new Set<string>();
                            const values: string[] = [];
                            for (let local = 0; local < def.states.totalStates; local++) {
                                const d = def.states.decode(local) as Record<string, unknown>;
                                const v = String(d[propName]);
                                if (!seen.has(v)) {
                                    seen.add(v);
                                    values.push(v);
                                }
                            }

                            return (
                                <div key={propName}>
                                    <span className="block text-[10px] font-mono text-fg mb-0.5">{propName}</span>
                                    <div className="flex flex-wrap gap-1">
                                        {values.map((v) => {
                                            const active = String(currentVal) === v;
                                            const targetDecoded: Record<string, unknown> = {
                                                ...decoded,
                                                [propName]:
                                                    propDef.type === 'int'
                                                        ? Number(v)
                                                        : v === 'true'
                                                          ? true
                                                          : v === 'false'
                                                            ? false
                                                            : v,
                                            };
                                            let targetLocal = -1;
                                            for (let local = 0; local < def.states.totalStates; local++) {
                                                const d = def.states.decode(local) as Record<string, unknown>;
                                                if (propNames.every((k) => String(d[k]) === String(targetDecoded[k]))) {
                                                    targetLocal = local;
                                                    break;
                                                }
                                            }
                                            const targetKey =
                                                targetLocal >= 0 ? formatKey(def.id, def.states, targetLocal) : null;

                                            return (
                                                <button
                                                    key={v}
                                                    type="button"
                                                    disabled={active || targetKey === null}
                                                    onClick={() => {
                                                        if (targetKey) setBlock(wx, wy, wz, targetKey);
                                                    }}
                                                    className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-colors ${
                                                        active
                                                            ? 'bg-accent text-on-accent cursor-default'
                                                            : 'bg-surface-muted text-fg hover:bg-border cursor-pointer'
                                                    }`}
                                                >
                                                    {v}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        );
    }

    // ── node inspect ─────────────────────────────────────────────────
    if (selectedNodeIds.size === 0 && voxelCount === 0) {
        return <div className="p-2 text-[10px] text-fg-muted font-mono italic">nothing selected</div>;
    }

    if (selectedNodeIds.size !== 1) {
        const parts: string[] = [];
        if (selectedNodeIds.size > 0) parts.push(`${selectedNodeIds.size} node${selectedNodeIds.size !== 1 ? 's' : ''}`);
        if (voxelCount > 0) parts.push(`${voxelCount.toLocaleString()} voxel${voxelCount !== 1 ? 's' : ''}`);
        return <div className="p-2 text-[10px] text-fg-muted font-mono italic">{parts.join(' + ')} selected</div>;
    }

    const selectedNodeId = selectedNodeIds.values().next().value!;
    const node = getNodeById(room.nodes, selectedNodeId);
    if (!node) {
        return <div className="p-2 text-[10px] text-fg-muted font-mono italic">node not found</div>;
    }

    const traitSlots = Array.from(node._traits.keys());

    return (
        <div className="flex flex-col max-h-full">
            <div className="overflow-y-auto flex-1 p-2 space-y-4">
                {/* ── node ──────────────────────────────────────────── */}
                <div className="space-y-1.5">
                    <SectionDivider label="node" action={<AddPrefabAction node={node} />} />

                    <NameEditor node={node} />

                    {/* realm, root is always 'shared', no editor */}
                    {node.parent && (
                        <div className="flex items-center gap-2">
                            <span className="text-[10px] font-mono text-fg shrink-0 w-12">realm</span>
                            <RealmEditor node={node} />
                        </div>
                    )}

                    <div className="text-[10px] font-mono text-fg-muted">
                        id: {node.id}
                        {!node.persist && <span className="ml-2 text-warn">non-persistent</span>}
                    </div>
                </div>

                {/* ── prefab (only when set) ────────────────────────── */}
                <PrefabSection node={node} />

                {/* ── traits ────────────────────────────────────────── */}
                <div className="space-y-1.5">
                    <SectionDivider label="traits" action={<AddTraitAction node={node} />} />
                    {traitSlots.length === 0 && node._unresolvedTraits.size === 0 ? (
                        <div className="text-[10px] font-mono text-fg-muted italic">no traits</div>
                    ) : (
                        <>
                            {traitSlots.map((index) => (
                                <TraitSection key={index} node={node} traitSlot={index} />
                            ))}
                            {Array.from(node._unresolvedTraits).map(([id, data]) => (
                                <UnresolvedTraitSection key={`unresolved-${id}`} node={node} traitId={id} data={data} />
                            ))}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}

/* ── Name editor ────────────────────────────────────────────────── */

function NameEditor({ node }: { node: Node }) {
    const setName = useEditRoom((s) => s.setName);
    return (
        <Input
            type="text"
            value={node.name ?? ''}
            placeholder={`Node ${node.id}`}
            onChange={(e) => {
                setName(node.id, e.target.value || undefined);
            }}
        />
    );
}

const REALM_OPTIONS: { value: Realm; tip: string }[] = [
    { value: 'inherit', tip: 'Take realm from the nearest non-inherit ancestor (default).' },
    { value: 'shared', tip: 'Server-owned, replicated to all clients.' },
    { value: 'client', tip: 'Lives only on the client that created it; never replicated.' },
    { value: 'server', tip: 'Lives only on the server; never replicated.' },
    { value: 'each', tip: 'Server AND every client get their own independent copy on attach.' },
];

function RealmEditor({ node }: { node: Node }) {
    const setRealm = useEditRoom((s) => s.setRealm);
    return (
        <div className="flex w-full">
            {REALM_OPTIONS.map((opt, i) => {
                const active = node.realm === opt.value;
                return (
                    <button
                        key={opt.value}
                        type="button"
                        title={opt.tip}
                        onClick={() => setRealm(node.id, opt.value)}
                        className={`flex-1 px-1 py-0.5 text-[10px] font-mono cursor-pointer border ${
                            active
                                ? 'bg-accent text-on-accent border-accent'
                                : 'bg-surface text-fg border-border hover:bg-surface-muted hover:text-fg'
                        } ${i === 0 ? 'rounded-l' : '-ml-px'} ${i === REALM_OPTIONS.length - 1 ? 'rounded-r' : ''}`}
                    >
                        {opt.value}
                    </button>
                );
            })}
        </div>
    );
}

/* ── Name editor ────────────────────────────────────────────────── */
