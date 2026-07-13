// editor/ui/components/ColorPicker.tsx — the paint app's color control: a live
// swatch, a hex text field, H/S/L sliders, and a palette grid. Value is a
// #rrggbb (or #rrggbbaa) hex string; onChange fires with the same.

import { type CSSProperties, useEffect, useRef, useState } from 'react';

export const TRANSPARENT = '#00000000';

const CHECKER = 'repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 8px 8px';
const HUE = 'linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%)';

const PALETTE = [
    '#000000',
    '#1d2b53',
    '#7e2553',
    '#008751',
    '#ab5236',
    '#5f574f',
    '#c2c3c7',
    '#fff1e8',
    '#ff004d',
    '#ffa300',
    '#ffec27',
    '#00e436',
    '#29adff',
    '#83769c',
    '#ff77a8',
    '#ffccaa',
    '#ffffff',
    '#e03c3c',
    '#f07f28',
    '#f0c020',
    '#3cb45a',
    '#2aa0a8',
    '#4670e6',
    '#8040c0',
    '#222222',
    '#444444',
    '#666666',
    '#888888',
    '#aaaaaa',
    '#cccccc',
    '#eeeeee',
    TRANSPARENT,
];

// ── color math ──────────────────────────────────────────────────────
function hexToRgb(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const [rn, gn, bn] = [r / 255, g / 255, b / 255];
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, Math.round(l * 100)];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h = 0;
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    return [Math.round(h * 60), Math.round(s * 100), Math.round(l * 100)];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const [sn, ln] = [s / 100, l / 100];
    const c = (1 - Math.abs(2 * ln - 1)) * sn;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    const [r1, g1, b1] =
        hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
    const m = ln - c / 2;
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
    const [hsl, setHsl] = useState<[number, number, number]>([0, 0, 0]);
    const [hexText, setHexText] = useState(value);
    const lastEmitted = useRef('');

    // sync from external value changes (eyedropper, palette clicks) unless we
    // just emitted this value ourselves — avoids slider jitter from rounding.
    useEffect(() => {
        if (value === lastEmitted.current) return;
        setHexText(value);
        setHsl(rgbToHsl(...hexToRgb(value.slice(0, 7))));
    }, [value]);

    const emit = (hex: string) => {
        lastEmitted.current = hex;
        onChange(hex);
    };

    const setChannel = (next: [number, number, number]) => {
        setHsl(next);
        const hex = rgbToHex(...hslToRgb(...next));
        setHexText(hex);
        emit(hex);
    };

    const onHex = (raw: string) => {
        setHexText(raw);
        const m = raw.trim().replace(/^#/, '');
        if (/^[0-9a-fA-F]{6}$/.test(m) || /^[0-9a-fA-F]{8}$/.test(m)) {
            const hex = `#${m.toLowerCase()}`;
            setHsl(rgbToHsl(...hexToRgb(hex.slice(0, 7))));
            emit(hex);
        }
    };

    const [h, s, l] = hsl;
    const transparent = value.length >= 9 && value.slice(7, 9) === '00';

    return (
        <div style={panel}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <div style={{ ...swatch, background: transparent ? CHECKER : value.slice(0, 7) }} />
                <input
                    value={hexText}
                    spellCheck={false}
                    onChange={(e) => onHex(e.target.value)}
                    style={hexInput}
                    aria-label="hex color"
                />
            </div>
            <Slider label="H" min={0} max={360} value={h} onChange={(v) => setChannel([v, s, l])} track={HUE} />
            <Slider
                label="S"
                min={0}
                max={100}
                value={s}
                onChange={(v) => setChannel([h, v, l])}
                track={`linear-gradient(to right, hsl(${h} 0% ${l}%), hsl(${h} 100% ${l}%))`}
            />
            <Slider
                label="L"
                min={0}
                max={100}
                value={l}
                onChange={(v) => setChannel([h, s, v])}
                track={`linear-gradient(to right, #000, hsl(${h} ${s}% 50%), #fff)`}
            />
            <div style={grid}>
                {PALETTE.map((c) => (
                    <button
                        key={c}
                        type="button"
                        title={c === TRANSPARENT ? 'transparent' : c}
                        onClick={() => {
                            setHexText(c);
                            if (c !== TRANSPARENT) setHsl(rgbToHsl(...hexToRgb(c)));
                            emit(c);
                        }}
                        style={{
                            ...cell,
                            outline: value === c ? '2px solid #000' : 'none',
                            background: c === TRANSPARENT ? CHECKER : c,
                        }}
                    />
                ))}
            </div>
        </div>
    );
}

function Slider(props: { label: string; min: number; max: number; value: number; onChange: (v: number) => void; track: string }) {
    return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, color: '#888' }}>{props.label}</span>
            <input
                type="range"
                min={props.min}
                max={props.max}
                value={props.value}
                onChange={(e) => props.onChange(Number(e.target.value))}
                style={{ flex: 1, background: props.track, borderRadius: 0, height: 12 }}
            />
            <span style={{ width: 28, textAlign: 'right', color: '#888' }}>{props.value}</span>
        </label>
    );
}

const panel: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    padding: 8,
    borderBottom: '1px solid #000',
    font: '12px/1 ui-monospace, monospace',
    flexShrink: 0,
};
const swatch: CSSProperties = { width: 34, height: 34, border: '1px solid #000', flexShrink: 0 };
const hexInput: CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid #000',
    padding: '5px 6px',
    font: '12px/1 ui-monospace, monospace',
};
const grid: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(16, 1fr)', gap: 2 };
const cell: CSSProperties = { width: '100%', aspectRatio: '1', padding: 0, border: '1px solid #999', cursor: 'pointer' };
