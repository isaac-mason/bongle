import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import { MessageSquare } from '../../../../icons';
import type { ParseState, Suggestion } from '../../../core/chat-commands';
import * as ChatCommands from '../../../core/chat-commands';
import type { ChatClient, ChatLine } from '../../chat';
import * as ClientChat from '../../chat';
import { useClient, useRoom } from '../stores/client-store';

// drives the on-screen chat opener since the '/','t' key openers don't exist on touch.
function useIsTouch(): boolean {
    return useClient((s) => s.inputMode === 'touch');
}

// px covered by the soft keyboard, tracked via visualViewport; 0 when inactive or unsupported.
function useKeyboardInset(active: boolean): number {
    const [inset, setInset] = useState(0);
    useEffect(() => {
        const vv = typeof window !== 'undefined' ? window.visualViewport : null;
        if (!active || !vv) {
            setInset(0);
            return;
        }
        const update = () => setInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
        update();
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
        return () => {
            vv.removeEventListener('resize', update);
            vv.removeEventListener('scroll', update);
        };
    }, [active]);
    return inset;
}

const HISTORY_LIMIT = 50;
const OPEN_HISTORY_LINES = 100;
const CLOSED_RECENT_LINES = 5;
const RECENT_LIFETIME_MS = 10_000;
// opacity ramps from 1 to 0 over this trailing slice.
const RECENT_FADE_MS = 1_000;
// touch: the latest line beside the chat button fades out over this trailing slice.
const TOUCH_LATEST_MS = 4_500;
const TOUCH_LATEST_FADE_MS = 800;

// panel-local open + seed state; the active room's ChatClient owns the line buffer.
export type ChatPanelStore = {
    isOpen: boolean;
    /** consumed and cleared by the panel on mount. */
    seed: string;
    open: (opts?: { seed?: string }) => void;
    close: () => void;
    consumeSeed: () => string;
};

export const useChatPanel = create<ChatPanelStore>((set, get) => ({
    isOpen: false,
    seed: '',
    open: (opts) => set({ isOpen: true, seed: opts?.seed ?? '' }),
    close: () => set({ isOpen: false }),
    consumeSeed: () => {
        const s = get().seed;
        if (s) set({ seed: '' });
        return s;
    },
}));

const EMPTY_LINES: ChatLine[] = [];
const EMPTY_SUGGESTIONS: Suggestion[] = [];

function useChatLines(chat: ChatClient | null): ChatLine[] {
    const subscribe = useCallback((cb: () => void) => (chat ? ClientChat.subscribe(chat, cb) : () => {}), [chat]);
    const getSnapshot = useCallback(() => chat?.lines ?? EMPTY_LINES, [chat]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// re-renders on toggle: setEnabled notifies the same subscribers the line buffer uses.
export function useChatEnabled(): boolean {
    const chat = useRoom((r) => r.chat);
    const subscribe = useCallback((cb: () => void) => (chat ? ClientChat.subscribe(chat, cb) : () => {}), [chat]);
    const getSnapshot = useCallback(() => chat?.enabled ?? true, [chat]);
    return useSyncExternalStore(subscribe, getSnapshot, () => true);
}

function lineColor(kind: ChatLine['kind']): string {
    if (kind === 'error') return 'text-red-300';
    if (kind === 'system') return 'text-yellow-200';
    if (kind === 'input') return 'text-neutral-300';
    return 'text-white';
}

function formatLine(l: ChatLine): string {
    if (l.kind === 'system') return l.text;
    return l.from ? `${l.from}: ${l.text}` : l.text;
}

// chat format tags: [#rrggbb] sets color, [b]/[i]/[u]/[s] toggle styles on, [/] resets all; unknown bracketed runs render verbatim.
const HEX_TAG_RE = /^#[0-9a-f]{6}$/i;

type Segment = { text: string; color?: string; bold: boolean; italic: boolean; underline: boolean; strike: boolean };

function parseFormatCodes(text: string): Segment[] {
    const segments: Segment[] = [];
    let color: string | undefined;
    let bold = false;
    let italic = false;
    let underline = false;
    let strike = false;
    let buf = '';
    const flush = (): void => {
        if (buf) segments.push({ text: buf, color, bold, italic, underline, strike });
        buf = '';
    };
    for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === '[') {
            const end = text.indexOf(']', i + 1);
            if (end !== -1) {
                const tag = text.slice(i + 1, end).toLowerCase();
                const isTag = tag === '/' || tag === 'b' || tag === 'i' || tag === 'u' || tag === 's' || HEX_TAG_RE.test(tag);
                if (isTag) {
                    // flush the run under the current style before mutating it.
                    flush();
                    if (tag === '/') {
                        color = undefined;
                        bold = italic = underline = strike = false;
                    } else if (tag === 'b') bold = true;
                    else if (tag === 'i') italic = true;
                    else if (tag === 'u') underline = true;
                    else if (tag === 's') strike = true;
                    else color = tag;
                    i = end; // skip past the tag; the loop's i++ lands after ']'
                    continue;
                }
            }
        }
        buf += ch;
    }
    flush();
    return segments;
}

function FormattedText({ text }: { text: string }) {
    if (!text.includes('[')) return <>{text}</>;
    const segments = parseFormatCodes(text);
    return (
        <>
            {segments.map((s, i) => (
                <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: positional formatting segments
                    key={i}
                    style={{
                        color: s.color,
                        fontWeight: s.bold ? 'bold' : undefined,
                        fontStyle: s.italic ? 'italic' : undefined,
                        textDecoration:
                            s.underline && s.strike
                                ? 'underline line-through'
                                : s.underline
                                  ? 'underline'
                                  : s.strike
                                    ? 'line-through'
                                    : undefined,
                    }}
                >
                    {s.text}
                </span>
            ))}
        </>
    );
}

// module-scoped so history survives ChatPanel mount/unmount (e.g. editor toggled off/on).
const submitHistory: string[] = [];

export function ChatPanel() {
    const isOpen = useChatPanel((s) => s.isOpen);
    const close = useChatPanel((s) => s.close);
    const chat = useRoom((r) => r.chat);
    const lines = useChatLines(chat);
    // touch chat UX is gated on active PLAY mode, not the UI shell (the editor renders this panel too).
    const playMode = useRoom((r) => r.playerMode) === 'play';
    const touchUi = useIsTouch() && playMode;
    const keyboardInset = useKeyboardInset(touchUi && isOpen);
    const enabled = useChatEnabled();

    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const historyScrollRef = useRef<HTMLDivElement>(null);
    const [input, setInput] = useState('');
    const [cursor, setCursor] = useState(0);
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [historyCursor, setHistoryCursor] = useState(-1);

    // "now" ticks only while a recent line is still fading; paused when chat is open or nothing recent.
    const [now, setNow] = useState(() => Date.now());
    const newestTs = lines.length > 0 ? lines[lines.length - 1]!.ts : 0;
    const hasActiveRecent = !isOpen && newestTs > 0 && Date.now() - newestTs < RECENT_LIFETIME_MS;
    // biome-ignore lint/correctness/useExhaustiveDependencies: ticks only while a recent line is live; setNow is a stable setter
    useEffect(() => {
        if (!hasActiveRecent) return;
        const id = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(id);
    }, [hasActiveRecent, newestTs]);

    useEffect(() => {
        if (!isOpen) return;
        const seed = useChatPanel.getState().consumeSeed();
        setInput(seed);
        setCursor(seed.length);
        setSelectedIndex(0);
        setHistoryCursor(-1);
        // touch: skip auto-focus, it would pop the soft keyboard over the history before the user reads it.
        if (touchUi && !seed) return;
        const id = requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(seed.length, seed.length);
        });
        return () => cancelAnimationFrame(id);
    }, [isOpen, touchUi]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: lines.length is a re-pin trigger, not read in the body
    useEffect(() => {
        if (!isOpen) return;
        const el = historyScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [isOpen, lines.length]);

    const commands = chat?.commands ?? null;
    const parsed: ParseState = useMemo(() => ChatCommands.parseLine(commands, input, cursor), [commands, input, cursor]);
    const rawSuggestions: Suggestion[] = useMemo(() => ChatCommands.suggestAt(commands, parsed), [commands, parsed]);
    const suggestions = input.startsWith('/') ? rawSuggestions : EMPTY_SUGGESTIONS;
    // arrow keys recall chat history instead of walking suggestions while no command is typed yet.
    const arrowsRecallHistory = input === '' || input === '/';

    useEffect(() => {
        if (selectedIndex >= suggestions.length && suggestions.length > 0) setSelectedIndex(0);
    }, [suggestions.length, selectedIndex]);

    useEffect(() => {
        if (!isOpen) return;
        function onMouseDown(e: MouseEvent) {
            const root = panelRef.current;
            if (!root) return;
            if (e.target instanceof Node && root.contains(e.target)) return;
            setInput('');
            setCursor(0);
            close();
        }
        document.addEventListener('mousedown', onMouseDown);
        return () => document.removeEventListener('mousedown', onMouseDown);
    }, [isOpen, close]);

    function acceptSuggestion(sug: Suggestion): void {
        const isCmdToken = parsed.activeArgIndex === -1 && !parsed.cursorTokenIsFlag && !parsed.cursorIsSubcommand;
        // command-token replacement spans the leading '/' too, since the suggestion text already includes it.
        const insertStart = isCmdToken ? 0 : parsed.cursorTokenStart;
        const before = input.slice(0, insertStart);
        const after = input.slice(parsed.cursorTokenEnd);
        const replacement = isCmdToken ? `/${sug.text}` : sug.text;
        const next = `${before}${replacement} ${after}`.replace(/\s+$/, after ? '' : ' ');
        const nextCursor = before.length + replacement.length + 1;
        setInput(next);
        setCursor(nextCursor);
        requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.setSelectionRange(nextCursor, nextCursor);
        });
    }

    function commit(): void {
        const trimmed = input.trim();
        if (!trimmed) {
            close();
            return;
        }
        const h = submitHistory;
        if (h[h.length - 1] !== trimmed) {
            h.push(trimmed);
            if (h.length > HISTORY_LIMIT) h.splice(0, h.length - HISTORY_LIMIT);
        }
        if (chat) ClientChat.submit(chat, trimmed);
        setInput('');
        setCursor(0);
        setHistoryCursor(-1);
        close();
    }

    function recallHistory(delta: number): void {
        const h = submitHistory;
        if (h.length === 0) return;
        const nextIdx = Math.max(-1, Math.min(h.length - 1, historyCursor + delta));
        setHistoryCursor(nextIdx);
        const recalled = nextIdx === -1 ? '' : h[h.length - 1 - nextIdx]!;
        setInput(recalled);
        setCursor(recalled.length);
    }

    function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
        // stop propagation so the global open-chat listener doesn't see this event: close()'s
        // setState flushes before bubbling reaches document, so it would read isOpen as false and reopen.
        e.stopPropagation();
        if (e.key === 'Escape') {
            e.preventDefault();
            setInput('');
            setCursor(0);
            close();
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            if (suggestions.length === 0) return;
            acceptSuggestion(suggestions[selectedIndex]!);
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (suggestions.length > 0 && !arrowsRecallHistory) {
                setSelectedIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
            } else {
                recallHistory(1);
            }
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (suggestions.length > 0 && !arrowsRecallHistory) {
                setSelectedIndex((i) => (i + 1) % suggestions.length);
            } else {
                recallHistory(-1);
            }
            return;
        }
    }

    const recentClosed = useMemo(() => {
        if (isOpen) return EMPTY_LINES;
        const out: ChatLine[] = [];
        for (const l of lines) {
            if (now - l.ts < RECENT_LIFETIME_MS) out.push(l);
        }
        return out.length > CLOSED_RECENT_LINES ? out.slice(-CLOSED_RECENT_LINES) : out;
    }, [lines, now, isOpen]);

    function recentOpacity(line: ChatLine): number {
        const age = now - line.ts;
        const fadeStart = RECENT_LIFETIME_MS - RECENT_FADE_MS;
        if (age < fadeStart) return 1;
        return Math.max(0, 1 - (age - fadeStart) / RECENT_FADE_MS);
    }

    const openHistory = isOpen ? lines.slice(-OPEN_HISTORY_LINES) : EMPTY_LINES;

    // touch closed-state shows only the single newest line beside the button, briefly.
    const latestLine = !isOpen && lines.length > 0 ? lines[lines.length - 1]! : null;
    const latestAge = latestLine ? now - latestLine.ts : Number.POSITIVE_INFINITY;
    const latestVisible = latestAge < TOUCH_LATEST_MS;
    const latestOpacity =
        latestAge < TOUCH_LATEST_MS - TOUCH_LATEST_FADE_MS
            ? 1
            : Math.max(0, 1 - (latestAge - (TOUCH_LATEST_MS - TOUCH_LATEST_FADE_MS)) / TOUCH_LATEST_FADE_MS);

    // touch: bottom-left sits under the joystick, so open uses a bottom-sheet above the
    // soft keyboard instead (above the touch-controls layer so it captures their touches).
    const panelBase = 'pointer-events-none flex flex-col items-stretch gap-1';
    const panelClass = touchUi ? panelBase : `absolute bottom-24 left-3 right-3 z-50 ${panelBase}`;
    const panelStyle: React.CSSProperties = !touchUi
        ? {}
        : isOpen
          ? { position: 'fixed', left: 0, right: 0, bottom: keyboardInset, padding: '0 8px 8px', zIndex: 450 }
          : {};

    if (!enabled) return null;

    return (
        <>
            {/* backdrop sits above the touch-controls layer so the joystick/buttons stay inert while typing. */}
            {touchUi && isOpen && (
                <div
                    className="fixed inset-0 bg-black/40"
                    style={{ zIndex: 449 }}
                    onPointerDown={() => {
                        setInput('');
                        setCursor(0);
                        close();
                    }}
                />
            )}
            {touchUi && !isOpen && (
                <div
                    className="fixed left-3 top-[56%] -translate-y-1/2 flex items-center gap-2 pointer-events-none"
                    // above the touch-controls layer (z-400) so the button captures its own taps.
                    style={{ zIndex: 410 }}
                >
                    <button
                        type="button"
                        aria-label="Open chat"
                        onClick={() => useChatPanel.getState().open()}
                        className="pointer-events-auto flex items-center justify-center w-10 h-10 select-none shrink-0"
                        style={{
                            background: 'rgba(20, 20, 20, 0.55)',
                            border: '2px solid rgba(255, 255, 255, 0.5)',
                            borderRadius: 8,
                            color: '#fff',
                        }}
                    >
                        <MessageSquare size={24} />
                    </button>
                    {latestVisible && latestLine && (
                        <div
                            style={{ opacity: latestOpacity }}
                            className={`bg-black/50 px-2 py-0.5 text-[12px] leading-snug font-mono max-w-[33vw] line-clamp-2 ${lineColor(latestLine.kind)}`}
                        >
                            <FormattedText text={formatLine(latestLine)} />
                        </div>
                    )}
                </div>
            )}
            <div ref={panelRef} className={panelClass} style={panelStyle}>
                {isOpen ? (
                    <div
                        ref={historyScrollRef}
                        className="pointer-events-auto bg-black/50 px-2 py-1 max-w-md max-h-[60vh] overflow-y-auto text-[12px] font-mono flex flex-col gap-0.5"
                    >
                        {openHistory.length === 0 ? (
                            <div className="text-neutral-400">no messages yet.</div>
                        ) : (
                            openHistory.map((l, i) => (
                                // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines (no stable id)
                                <div key={`${l.ts}-${i}`} className={`${lineColor(l.kind)} whitespace-pre-wrap`}>
                                    <FormattedText text={formatLine(l)} />
                                </div>
                            ))
                        )}
                    </div>
                ) : touchUi ? null : (
                    recentClosed.length > 0 && (
                        <div className="max-w-md flex flex-col gap-0.5 text-[12px] font-mono">
                            {recentClosed.map((l, i) => (
                                <div
                                    // biome-ignore lint/suspicious/noArrayIndexKey: append-only log lines (no stable id)
                                    key={`${l.ts}-${i}`}
                                    style={{ opacity: recentOpacity(l) }}
                                    className={`bg-black/50 px-2 py-0.5 ${lineColor(l.kind)} whitespace-pre-wrap`}
                                >
                                    <FormattedText text={formatLine(l)} />
                                </div>
                            ))}
                        </div>
                    )
                )}

                {isOpen && suggestions.length > 0 && (
                    <div className="pointer-events-auto max-w-md bg-black/70 text-[12px] font-mono max-h-48 overflow-y-auto">
                        {suggestions.map((sug, i) => (
                            // biome-ignore lint/a11y/noStaticElementInteractions: suggestion option; keyboard nav is handled at the input level
                            <div
                                key={sug.text}
                                className={`flex items-baseline justify-between px-2 py-0.5 cursor-pointer ${
                                    i === selectedIndex ? 'bg-white/20 text-white' : 'text-neutral-200 hover:bg-white/10'
                                }`}
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    acceptSuggestion(sug);
                                }}
                            >
                                <span>{sug.label ?? sug.text}</span>
                                {sug.detail && (
                                    <span className={i === selectedIndex ? 'text-neutral-300 ml-3' : 'text-neutral-400 ml-3'}>
                                        {sug.detail}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                {isOpen && input.startsWith('/') && <Signature parsed={parsed} />}

                {isOpen && (
                    <div className="pointer-events-auto max-w-md bg-black/50 flex items-center px-2 py-1.5 text-[12px] font-mono">
                        <span className="text-neutral-400 mr-1.5">›</span>
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            className="flex-1 bg-transparent outline-none text-white placeholder:text-neutral-400"
                            placeholder="say something — /help for commands"
                            onChange={(e) => {
                                setInput(e.target.value);
                                setCursor(e.target.selectionStart ?? e.target.value.length);
                                setSelectedIndex(0);
                                setHistoryCursor(-1);
                            }}
                            onKeyUp={(e) => {
                                const t = e.target as HTMLInputElement;
                                setCursor(t.selectionStart ?? t.value.length);
                            }}
                            onClick={(e) => {
                                const t = e.target as HTMLInputElement;
                                setCursor(t.selectionStart ?? t.value.length);
                            }}
                            onKeyDown={onKeyDown}
                        />
                    </div>
                )}
            </div>
        </>
    );
}

// shows "/cmd <arg>" with the active arg bolded, plus any parse errors.
function Signature({ parsed }: { parsed: ParseState }) {
    if (!parsed.cmd) return null;
    const argLabels = parsed.cmd.args.map((a) => `<${a.name}>`);
    const errorEntries = Object.entries(parsed.argErrors);

    return (
        <div className="pointer-events-auto max-w-md bg-black/50 px-2 py-1 text-[12px] font-mono text-neutral-200">
            <div>
                <span className="text-white">/{parsed.cmd.name}</span>{' '}
                {argLabels.map((label, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: command arg labels are positional
                    <span key={i} className={i === parsed.activeArgIndex ? 'text-white font-bold' : 'text-neutral-400'}>
                        {label}{' '}
                    </span>
                ))}
                <span className="text-neutral-400">— {parsed.cmd.description}</span>
            </div>
            {errorEntries.length > 0 && (
                <div className="text-red-300">
                    {errorEntries.map(([name, msg]) => (
                        <div key={name}>
                            {name}: {msg}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
