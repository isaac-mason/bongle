/**
 * <ExprInput> — small text input with grammar-aware autocomplete.
 *
 * shape mirrors the chat panel's completion UX: dropdown below the input,
 * arrow keys cycle, Tab/Enter accepts, Esc dismisses. used by the tool
 * panels for `pattern` / `mask` fields so users don't need to memorise the
 * grammar (block ids, `$active`, `#existing`, `!`/`,` operators, etc).
 *
 * grammar-specific knowledge lives in the suggest fn (see
 * `pattern.ts:suggestPattern` / `mask.ts:suggestMask`); this component is
 * pure UX — it doesn't know about block ids, weights, or operators. that
 * keeps it reusable for any future grammar-typed field (e.g. selectors).
 */

import { Popover } from '@base-ui/react/popover';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { registry } from '../../core/registry';

export type ExprSuggestion = { text: string; label?: string; detail?: string };

export type ExprSuggestResult = {
    /** start index of the substring to replace on accept. */
    replaceStart: number;
    /** end index (exclusive) of the substring to replace on accept. */
    replaceEnd: number;
    suggestions: ExprSuggestion[];
};

export type ExprSuggestFn = (
    text: string,
    cursor: number,
    blockIds: ReadonlyArray<{ id: string; name?: string }>,
) => ExprSuggestResult;

type Props = {
    value: string;
    placeholder?: string;
    suggest: ExprSuggestFn;
    onChange: (next: string) => void;
    /** parse error from the consumer's commit fn — rendered below the input. */
    error?: string | null;
};

// snapshot the global block-def list once per render. registry mutations
// during a session are rare (room load); a fresh useMemo per parent render
// keeps it correct without an explicit subscription.
function useBlockIds(): ReadonlyArray<{ id: string; name?: string }> {
    return useMemo(() => registry.blockRegistry.defs.filter((d) => d.id !== 'air').map((d) => ({ id: d.id, name: d.name })), []);
}

export function ExprInput({ value, placeholder, suggest, onChange, error }: Props) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [cursor, setCursor] = useState(value.length);
    const [open, setOpen] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);

    const blockIds = useBlockIds();
    const result = useMemo(() => suggest(value, cursor, blockIds), [suggest, value, cursor, blockIds]);
    const suggestions = result.suggestions;

    useEffect(() => {
        if (selectedIndex >= suggestions.length && suggestions.length > 0) setSelectedIndex(0);
    }, [suggestions.length, selectedIndex]);

    const accept = useCallback(
        (sug: ExprSuggestion) => {
            const before = value.slice(0, result.replaceStart);
            const after = value.slice(result.replaceEnd);
            const next = `${before}${sug.text}${after}`;
            const nextCursor = before.length + sug.text.length;
            onChange(next);
            // schedule the caret move for after react commits the value change.
            requestAnimationFrame(() => {
                const el = inputRef.current;
                if (!el) return;
                el.setSelectionRange(nextCursor, nextCursor);
                setCursor(nextCursor);
            });
        },
        [value, result.replaceStart, result.replaceEnd, onChange],
    );

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (!open || suggestions.length === 0) {
            if (e.key === 'Escape') {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
            }
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            setOpen(false);
            return;
        }
        if (e.key === 'Tab' || e.key === 'Enter') {
            e.preventDefault();
            accept(suggestions[selectedIndex]!);
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex((i) => (i + 1) % suggestions.length);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
            return;
        }
    }

    const popoverOpen = open && suggestions.length > 0;

    return (
        <div className="flex-1">
            <input
                ref={inputRef}
                type="text"
                value={value}
                placeholder={placeholder}
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                className="w-full bg-neutral-800 text-neutral-200 text-[10px] font-mono px-1 py-0.5 rounded border border-neutral-700"
                onChange={(e) => {
                    onChange(e.target.value);
                    setCursor(e.target.selectionStart ?? e.target.value.length);
                    setSelectedIndex(0);
                    setOpen(true);
                }}
                onFocus={(e) => {
                    setCursor(e.target.selectionStart ?? e.target.value.length);
                    setOpen(true);
                }}
                onKeyUp={(e) => {
                    const t = e.target as HTMLInputElement;
                    setCursor(t.selectionStart ?? t.value.length);
                }}
                onClick={(e) => {
                    const t = e.target as HTMLInputElement;
                    setCursor(t.selectionStart ?? t.value.length);
                    setOpen(true);
                }}
                onKeyDown={onKeyDown}
            />
            <Popover.Root
                open={popoverOpen}
                onOpenChange={(next, details) => {
                    if (next) return;
                    // ignore outside-pointer-down only when it lands in our own
                    // input so the input keeps focus while we type; clicks
                    // elsewhere should close.
                    if (details.reason === 'outside-press' && details.event.target === inputRef.current) {
                        details.cancel();
                        return;
                    }
                    setOpen(false);
                }}
            >
                <Popover.Portal>
                    <Popover.Positioner
                        // anchor to the input rather than a trigger button.
                        anchor={inputRef}
                        side="bottom"
                        align="start"
                        sideOffset={2}
                    >
                        <Popover.Popup
                            // keep focus in the input — the popup otherwise grabs
                            // focus on open and steals the caret.
                            initialFocus={false}
                            finalFocus={false}
                            className="z-50 max-h-48 overflow-y-auto bg-neutral-900 border border-neutral-700 text-[10px] font-mono shadow-lg"
                            style={{ width: 'var(--anchor-width)' }}
                        >
                            {suggestions.map((sug, i) => (
                                <button
                                    type="button"
                                    key={sug.text}
                                    className={`w-full flex items-baseline justify-between text-left px-1.5 py-0.5 cursor-pointer ${
                                        i === selectedIndex
                                            ? 'bg-neutral-700 text-white'
                                            : 'text-neutral-300 hover:bg-neutral-800'
                                    }`}
                                    onMouseDown={(e) => {
                                        // mousedown (not click) so the input keeps focus
                                        // and the accept happens before blur fires.
                                        e.preventDefault();
                                        accept(sug);
                                    }}
                                >
                                    <span>{sug.label ?? sug.text}</span>
                                    {sug.detail && (
                                        <span className={i === selectedIndex ? 'text-neutral-300 ml-2' : 'text-neutral-500 ml-2'}>
                                            {sug.detail}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </Popover.Popup>
                    </Popover.Positioner>
                </Popover.Portal>
            </Popover.Root>
            {error && <div className="text-[10px] font-mono text-red-400 mt-0.5">{error}</div>}
        </div>
    );
}
