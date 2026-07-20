// reusable number input matching the tool-panel style. clamps on commit
// (`min` / `max`) and falls back to `min` (or 0) when the field is empty,
// that matches the existing parseInt(...)||1 pattern in magic-select.
//
// pair with <Range> for slider+input rows. omitting `max` lets the user
// type values beyond the paired slider's range, which is the intended
// behaviour for tool sizes/amounts.

type Props = {
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
    /** 'sm' (w-12) is the default; 'md' (w-20) for wider fields (e.g. /set limit). */
    width?: 'sm' | 'md';
};

export function NumberInput({ value, onChange, min, max, step = 1, width = 'sm' }: Props) {
    const w = width === 'md' ? 'w-20' : 'w-12';
    return (
        <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => {
                let n = Number(e.target.value);
                if (!Number.isFinite(n)) n = min ?? 0;
                if (min !== undefined) n = Math.max(min, n);
                if (max !== undefined) n = Math.min(max, n);
                onChange(n);
            }}
            className={`${w} bg-surface-muted text-fg text-[10px] font-mono px-1 py-0.5 rounded border border-border`}
        />
    );
}
