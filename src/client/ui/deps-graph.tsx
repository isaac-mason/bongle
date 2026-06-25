/**
 * DepsGraph — neighborhood view of the engine's content DepGraph.
 *
 * Shows the selected node centered between its producers (left) and
 * consumers (right), with SVG arcs between them. Clicking an item
 * navigates the selection. With nothing selected, prompts the user to
 * pick a node from the adjacent list.
 *
 * The full topology view was dropped — once the graph is non-trivial
 * a laid-out DAG turns into spaghetti you read by clicking anyway,
 * which is exactly what the list does.
 */

import { useMemo } from 'react';
import type { DepGraphSnapshot } from '../../core/capture/dep-graph';

const COL_W = 200;
const ROW_H = 22;
const ROW_GAP = 4;
const ARC_GAP = 72;

const REGISTRY_COLOR: Record<string, string> = {
    prefabs: '#4f8',
    scripts: '#fc6',
    scenes: '#8cf',
    models: '#c8f',
    blocks: '#fa6',
    blockTextures: '#f88',
    traits: '#f6c',
    matchmaking: '#aaa',
    commands: '#ccc',
};

function colorFor(registry: string): string {
    return REGISTRY_COLOR[registry] ?? '#888';
}

function depKey(registry: string, id: string): string {
    return `${registry}:${id}`;
}

function splitKey(key: string): { registry: string; id: string } {
    const i = key.indexOf(':');
    return { registry: key.slice(0, i), id: key.slice(i + 1) };
}

type Props = {
    snapshot: DepGraphSnapshot;
    selected: string | null;
    onSelect: (key: string | null) => void;
};

function DepsGraph({ snapshot, selected, onSelect }: Props) {
    const neighbors = useMemo(() => {
        if (!selected) return null;
        const producers: string[] = [];
        const consumers: string[] = [];
        for (const e of snapshot.edges) {
            const pk = depKey(e.producer.registry, e.producer.id);
            const ck = depKey(e.consumer.registry, e.consumer.id);
            if (ck === selected) producers.push(pk);
            if (pk === selected) consumers.push(ck);
        }
        producers.sort();
        consumers.sort();
        return { producers, consumers };
    }, [snapshot, selected]);

    if (!selected || !neighbors) {
        return (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#555',
                    font: '11px Helvetica,Arial,sans-serif',
                    background: '#0a0a0a',
                }}
            >
                select a node above to see its neighborhood
            </div>
        );
    }

    const rows = Math.max(neighbors.producers.length, neighbors.consumers.length, 1);
    const contentH = rows * ROW_H + (rows - 1) * ROW_GAP;
    const width = 3 * COL_W + 2 * ARC_GAP;
    const centerY = (contentH - ROW_H) / 2;
    const xSelected = COL_W + ARC_GAP;
    const xConsumers = 2 * (COL_W + ARC_GAP);

    const rowY = (i: number) => i * (ROW_H + ROW_GAP);

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: debug graph background (click-to-deselect)
        // biome-ignore lint/a11y/useKeyWithClickEvents: mouse-driven debug graph
        <div
            style={{
                width: '100%',
                height: '100%',
                background: '#0a0a0a',
                overflow: 'auto',
            }}
            onClick={() => onSelect(null)}
        >
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops click-through only; mouse-driven debug graph */}
            <svg
                width={width}
                height={contentH}
                style={{ display: 'block', margin: '12px auto' }}
                aria-hidden="true"
                onClick={(e) => e.stopPropagation()}
            >
                {/* arcs: producer right edge -> selected left edge */}
                {neighbors.producers.map((p, i) => (
                    <path
                        key={`pa:${p}`}
                        d={arcPath(COL_W, rowY(i) + ROW_H / 2, xSelected, centerY + ROW_H / 2)}
                        stroke={colorFor(splitKey(p).registry)}
                        strokeWidth={1}
                        fill="none"
                        opacity={0.6}
                    />
                ))}
                {/* arcs: selected right edge -> consumer left edge */}
                {neighbors.consumers.map((c, i) => (
                    <path
                        key={`ca:${c}`}
                        d={arcPath(xSelected + COL_W, centerY + ROW_H / 2, xConsumers, rowY(i) + ROW_H / 2)}
                        stroke={colorFor(splitKey(c).registry)}
                        strokeWidth={1}
                        fill="none"
                        opacity={0.6}
                    />
                ))}

                <ColumnLabel x={COL_W / 2} label={`producers · ${neighbors.producers.length}`} />
                <ColumnLabel x={xSelected + COL_W / 2} label="selected" />
                <ColumnLabel x={xConsumers + COL_W / 2} label={`consumers · ${neighbors.consumers.length}`} />

                {neighbors.producers.length === 0 && <Placeholder x={0} y={centerY} label="— none —" />}
                {neighbors.producers.map((p, i) => (
                    <Item key={`p:${p}`} x={0} y={rowY(i)} keyStr={p} onClick={() => onSelect(p)} />
                ))}

                <Item x={xSelected} y={centerY} keyStr={selected} selected onClick={() => onSelect(null)} />

                {neighbors.consumers.length === 0 && <Placeholder x={xConsumers} y={centerY} label="— none —" />}
                {neighbors.consumers.map((c, i) => (
                    <Item key={`c:${c}`} x={xConsumers} y={rowY(i)} keyStr={c} onClick={() => onSelect(c)} />
                ))}
            </svg>
        </div>
    );
}

function arcPath(x1: number, y1: number, x2: number, y2: number): string {
    const dx = (x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function ColumnLabel({ x, label }: { x: number; label: string }) {
    return (
        <text x={x} y={-2} textAnchor="middle" fill="#666" style={{ font: 'bold 9px Helvetica,Arial,sans-serif' }}>
            {label}
        </text>
    );
}

function Placeholder({ x, y, label }: { x: number; y: number; label: string }) {
    return (
        <text
            x={x + COL_W / 2}
            y={y + ROW_H / 2}
            dominantBaseline="middle"
            textAnchor="middle"
            fill="#444"
            style={{ font: '10px monospace' }}
        >
            {label}
        </text>
    );
}

function Item({
    x,
    y,
    keyStr,
    selected,
    onClick,
}: {
    x: number;
    y: number;
    keyStr: string;
    selected?: boolean;
    onClick: () => void;
}) {
    const { registry, id } = splitKey(keyStr);
    const c = colorFor(registry);
    const clipId = `clip-${keyStr.replace(/[^a-z0-9]/gi, '_')}`;
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: clickable node in a mouse-driven debug graph
        <g
            transform={`translate(${x} ${y})`}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
                e.stopPropagation();
                onClick();
            }}
        >
            <rect width={COL_W} height={ROW_H} fill={selected ? c : '#181818'} stroke={c} strokeWidth={1} />
            <clipPath id={clipId}>
                <rect width={COL_W - 8} height={ROW_H} />
            </clipPath>
            <g clipPath={`url(#${clipId})`}>
                <text
                    x={6}
                    y={ROW_H / 2 - 4}
                    dominantBaseline="middle"
                    fill={selected ? '#000' : c}
                    style={{ font: '8px monospace' }}
                >
                    {registry}
                </text>
                <text
                    x={6}
                    y={ROW_H / 2 + 5}
                    dominantBaseline="middle"
                    fill={selected ? '#000' : '#ddd'}
                    style={{ font: 'bold 10px monospace' }}
                >
                    {id}
                </text>
            </g>
        </g>
    );
}

export default DepsGraph;
