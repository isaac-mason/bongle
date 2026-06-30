// reusable range slider. tool panels pair this with <NumberInput> for the
// classic "type-or-drag" affordance, slider clamps to [min,max], the
// paired number input is allowed to exceed the slider's range so users
// can dial in extreme values without resizing the track.

type Props = {
    value: number;
    onChange: (n: number) => void;
    min: number;
    max: number;
    step?: number;
    /** appended to the default `flex-1` for one-off layout tweaks. */
    className?: string;
};

export function Range({ value, onChange, min, max, step = 1, className }: Props) {
    // clamp the displayed thumb position when the paired number input has
    // pushed `value` past `max`, the value itself is preserved, only the
    // slider visualisation pegs at the end.
    const visible = Math.min(max, Math.max(min, value));
    return (
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={visible}
            onChange={(e) => onChange(Number(e.target.value))}
            className={`flex-1${className ? ` ${className}` : ''}`}
        />
    );
}
