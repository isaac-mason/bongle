import { type ComponentProps, forwardRef, type ReactNode, useEffect, useMemo, useState } from 'react';
import { ChevronDown } from '../../../../icons';
import { termsMatch } from '../../../core/asset-meta';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

export type SearchableSelectItem<T extends string | number = string> = {
    id: T;
    label: string;
    /** shown on a second line under the label, e.g. a stable id under a human-readable name. */
    sublabel?: string;
    /** extra words the search matches against, e.g. an asset's tags. */
    keywords?: readonly string[];
    leading?: ReactNode;
    /** trailing label, e.g. "(missing)". */
    badge?: ReactNode;
    disabled?: boolean;
};

export type SearchableSelectProps<T extends string | number = string> = {
    items: SearchableSelectItem<T>[];
    /** Currently-selected id. Omit for "add" semantics (no current value). */
    value?: T;
    onSelect: (id: T) => void;
    /** Search input placeholder (e.g. "search traits"). */
    placeholder?: string;
    /** Custom trigger, rendered inside `<PopoverTrigger asChild>` so it must forward refs / spread props. */
    trigger?: ReactNode;
    /** Class merged onto the default trigger. Ignored when `trigger` is set. */
    triggerClassName?: string;
    /** Class merged onto the popover content. */
    contentClassName?: string;
    /** Label shown by the default trigger when nothing matches `value`. */
    emptyLabel?: string;
};

// two patterns: pass `value` for a native-select-style trigger, or omit it and pass a
// custom `trigger` (e.g. a "+" icon button) for "add" semantics.
export function SearchableSelect<T extends string | number = string>({
    items,
    value,
    onSelect,
    placeholder = 'search…',
    trigger,
    triggerClassName,
    contentClassName,
    emptyLabel = '—',
}: SearchableSelectProps<T>) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [activeIndex, setActiveIndex] = useState(0);

    const filtered = useMemo(() => {
        const q = query.trim();
        if (!q) return items;
        return items.filter((it) => termsMatch([it.label, it.sublabel ?? '', ...(it.keywords ?? [])], q));
    }, [items, query]);

    useEffect(() => {
        if (!open) {
            setQuery('');
            setActiveIndex(0);
        }
    }, [open]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: reset the highlight only when the query changes; setActiveIndex is a stable setter
    useEffect(() => {
        setActiveIndex(0);
    }, [query]);

    const choose = (id: T) => {
        onSelect(id);
        setOpen(false);
    };

    const current = value !== undefined ? items.find((it) => it.id === value) : undefined;

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                {trigger ?? <DefaultSelectTrigger label={current?.label ?? emptyLabel} className={triggerClassName} />}
            </PopoverTrigger>
            <PopoverContent className={`flex flex-col min-w-[180px] p-1 ${contentClassName ?? ''}`}>
                <input
                    // biome-ignore lint/a11y/noAutofocus: intentionally focus the search field when the popover opens
                    autoFocus
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            e.stopPropagation();
                            setActiveIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            e.stopPropagation();
                            setActiveIndex((i) => Math.max(0, i - 1));
                        } else if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                            const pick = filtered[activeIndex];
                            if (pick && !pick.disabled) choose(pick.id);
                        } else if (e.key === 'Escape') {
                            e.preventDefault();
                            e.stopPropagation();
                            setOpen(false);
                        }
                    }}
                    placeholder={placeholder}
                    className="shrink-0 w-full mb-1 bg-surface-muted border border-border px-1.5 py-0.5 text-[11px] font-mono text-fg outline-none focus:border-fg-muted"
                />
                <div className="max-h-40 overflow-y-auto">
                    {filtered.length === 0 ? (
                        <div className="px-2 py-1 text-[10px] font-mono text-fg-muted italic">no matches</div>
                    ) : (
                        filtered.map((it, i) => {
                            const isActive = i === activeIndex;
                            const isSelected = value !== undefined && it.id === value;
                            return (
                                <button
                                    type="button"
                                    key={String(it.id)}
                                    disabled={it.disabled}
                                    onClick={() => !it.disabled && choose(it.id)}
                                    onMouseEnter={() => setActiveIndex(i)}
                                    className={`flex items-center gap-2 w-full text-left px-2 py-1 text-[11px] font-mono cursor-pointer ${
                                        it.disabled ? 'text-fg-muted opacity-50 cursor-not-allowed' : 'text-fg'
                                    } ${isActive ? 'bg-accent/20' : 'hover:bg-surface-muted'} ${isSelected ? 'font-semibold' : ''}`}
                                >
                                    {it.leading}
                                    <span className="flex flex-col min-w-0 flex-1">
                                        <span className="truncate">{it.label}</span>
                                        {it.sublabel && <span className="truncate text-[9px] text-fg-muted">{it.sublabel}</span>}
                                    </span>
                                    {it.badge && <span className="ml-auto text-[10px] text-fg-muted">{it.badge}</span>}
                                </button>
                            );
                        })
                    )}
                </div>
            </PopoverContent>
        </Popover>
    );
}

const DefaultSelectTrigger = forwardRef<HTMLButtonElement, ComponentProps<'button'> & { label: ReactNode }>(
    ({ label, className, ...props }, ref) => (
        <button
            ref={ref}
            type="button"
            {...props}
            className={`flex items-center justify-between gap-1 w-full bg-surface-muted border border-border px-1.5 py-0.5 text-[10px] font-mono text-fg outline-none hover:border-fg-muted cursor-pointer ${className ?? ''}`}
        >
            <span className="truncate">{label}</span>
            <ChevronDown size={12} className="shrink-0 text-fg-muted" />
        </button>
    ),
);
DefaultSelectTrigger.displayName = 'DefaultSelectTrigger';
