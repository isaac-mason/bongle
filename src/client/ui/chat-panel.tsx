/**
 * chat panel, minecraft-style bottom-of-viewport overlay.
 *
 *   closed: desktop floats the last few lines bottom-left, fading after
 *           RECENT_LIFETIME_MS. play-mode touch shows only the single newest line
 *           beside a mid-left chat button (no stacked log under the joystick).
 *   open:   history pane above the input, scrolled to the bottom. clicking outside
 *           or Esc closes. opens with '/' (slash) or 't' on desktop; on play-mode
 *           touch, the chat button opens a bottom-sheet docked above the soft keyboard,
 *           over a dim backdrop that closes on tap and keeps touches off the controls.
 *
 * input handling: Enter sends verbatim; Tab accepts the highlighted
 * completion; ArrowUp/Down cycles the suggestion list (or recalls prior
 * submissions when there are no suggestions). Suggestions only show when
 * the input starts with '/'.
 *
 * data flow: subscribes to the active room's ChatClient for the line buffer
 * + command list. Submit goes through `ClientChat.submit`, which echoes
 * locally, dispatches local listeners, and queues unhandled lines onto the
 * outbox for the next tick to forward to the server.
 */

import { MessageSquare } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { create } from 'zustand';
import type { ParseState, Suggestion } from '../../core/chat-commands';
import * as ChatCommands from '../../core/chat-commands';
import * as Device from '../../render/device';
import type { ChatClient, ChatLine } from '../chat';
import * as ClientChat from '../chat';
import { useRoom } from './client-store';

/** touch-primary (phone/tablet) — reuses the robust boot-time device probe. drives the
 *  on-screen chat opener + bottom-sheet, since the `/`,`t` key openers don't exist there. */
function useIsTouch(): boolean {
    const [device] = useState(() => Device.init());
    return device.touchPrimary;
}

/** px the soft keyboard covers at the bottom, tracked via visualViewport, so the open
 *  sheet can dock just above it. 0 when inactive or unsupported. */
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
/** max lines shown in the closed-mode floating overlay. */
const CLOSED_RECENT_LINES = 5;
/** how long a fresh line stays visible while the panel is closed. */
const RECENT_LIFETIME_MS = 10_000;
/** trailing fade window, opacity ramps from 1→0 over this slice at the end. */
const RECENT_FADE_MS = 1_000;
/** touch: the single latest line beside the chat button lingers only briefly (a glance
 *  nudge), fading over the trailing slice. */
const TOUCH_LATEST_MS = 4_500;
const TOUCH_LATEST_FADE_MS = 800;

/** panel-local open + seed state. shared across the (one) on-screen panel
 *  instance, the active room's `ChatClient` owns the line buffer. */
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

/** whether chat is enabled for the active room (`chat.setEnabled(ctx, …)`).
 *  `ClientChat.setEnabled` notifies the same subscribers the line buffer uses,
 *  so this re-renders on toggle. Shared by `ChatPanel` and the play-ui openers. */
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

// Inline formatting tags, square-bracket delimited so messages still read as
// plain text where they aren't understood: `[#rrggbb]` sets a 24-bit colour,
// `[b]`/`[i]`/`[u]`/`[s]` turn bold/italic/underline/strike ON, and `[/]`
// resets everything. State is cumulative, a colour tag changes only the
// colour and leaves any active styles intact (only `[/]` clears them), so
// colours and styles layer freely. Any bracketed run that isn't a known tag
// (`[lol]`, `[1]`, an emote) renders verbatim, so ordinary chat that happens
// to use brackets is never eaten. Tags ride inside a normal chat string, no
// protocol change, so any script can style a line via `chat.message(ctx, …)`.
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
                    // emit the run so far under the OLD style, then mutate.
                    flush();
                    if (tag === '/') {
                        color = undefined;
                        bold = italic = underline = strike = false;
                    } else if (tag === 'b') bold = true;
                    else if (tag === 'i') italic = true;
                    else if (tag === 'u') underline = true;
                    else if (tag === 's') strike = true;
                    else color = tag; // `#rrggbb`, a colour change leaves styles intact
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

/** render a chat string with `[…]` colour/style tags applied. */
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

/** module-scoped command history, survives ChatPanel mount/unmount
 *  (e.g. editor toggled off/on) so prior submissions stay recallable. */
const submitHistory: string[] = [];

export function ChatPanel() {
    const isOpen = useChatPanel((s) => s.isOpen);
    const close = useChatPanel((s) => s.close);
    const chat = useRoom((r) => r.chat);
    const lines = useChatLines(chat);
    // the touch chat UX (edge button + bottom-sheet + single latest line) is gated on the
    // active room being in PLAY mode (not the UI shell — the editor renders this panel too,
    // and play-from-here flips playerMode to 'play'). editing keeps plain keyboard chat.
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

    // ticking "now" for closed-mode fade. only runs while there's at least
    // one line still within the lifetime window, pauses when chat is open
    // (history pane renders in full, no fade math needed) and when no recent
    // line exists.
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
        // desktop: focus the input so you can type immediately. touch: DON'T — auto-focus
        // pops the soft keyboard over the history; let the user read first and tap the input
        // (or start with a seed, e.g. an editor '/' command) to summon the keyboard.
        if (touchUi && !seed) return;
        const id = requestAnimationFrame(() => {
            const el = inputRef.current;
            if (!el) return;
            el.focus();
            el.setSelectionRange(seed.length, seed.length);
        });
        return () => cancelAnimationFrame(id);
    }, [isOpen, touchUi]);

    // pin history to bottom when open + whenever a new line arrives.
    // biome-ignore lint/correctness/useExhaustiveDependencies: lines.length is a re-pin trigger, not read in the body
    useEffect(() => {
        if (!isOpen) return;
        const el = historyScrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [isOpen, lines.length]);

    const commands = chat?.commands ?? null;
    const parsed: ParseState = useMemo(() => ChatCommands.parseLine(commands, input, cursor), [commands, input, cursor]);
    const rawSuggestions: Suggestion[] = useMemo(() => ChatCommands.suggestAt(commands, parsed), [commands, parsed]);
    // hide completions when the user is typing plain chat (no leading '/').
    const suggestions = input.startsWith('/') ? rawSuggestions : EMPTY_SUGGESTIONS;
    // arrow keys walk chat history (not suggestions) while the input is empty
    // or just the bare '/' opener — no meaningful command has been typed yet.
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
        // command-token replacement spans the chat-opener `/` too, since the
        // suggestion text already needs `/` prepended (and WE-style names carry
        // a second `/`). every other slot replaces just the cursor token.
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
        // Stop chat-input keys from reaching the global open-chat listener
        // (play-ui / edit-ui document-keydown). Enter would otherwise
        // commit+close then immediately re-open from the same native event:
        // close()'s setState flushes before bubbling reaches document, so
        // the input has unmounted, focus moved to body, isInputFocused()
        // returns false, and the global handler hits its `!isOpen` branch.
        // Escape closes via the same path. The other keys (Tab/Arrow) are
        // already handled locally; stop them too so the host doesn't see
        // chat keystrokes as game input.
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

    // touch closed-state shows ONLY the single newest line beside the button (no stacked
    // log), and only briefly — a nudge to glance, not a persistent readout.
    const latestLine = !isOpen && lines.length > 0 ? lines[lines.length - 1]! : null;
    const latestAge = latestLine ? now - latestLine.ts : Number.POSITIVE_INFINITY;
    const latestVisible = latestAge < TOUCH_LATEST_MS;
    const latestOpacity =
        latestAge < TOUCH_LATEST_MS - TOUCH_LATEST_FADE_MS
            ? 1
            : Math.max(0, 1 - (latestAge - (TOUCH_LATEST_MS - TOUCH_LATEST_FADE_MS)) / TOUCH_LATEST_FADE_MS);

    // desktop: the classic bottom-left overlay. touch: no `/`,`t` keys and the bottom-left
    // sits under the joystick, so — open → a bottom-sheet docked above the soft keyboard
    // (above the touch-controls layer so it captures their touches); closed → the panel is
    // empty (the newest line rides beside the edge chat button instead).
    const panelBase = 'pointer-events-none flex flex-col items-stretch gap-1';
    const panelClass = touchUi ? panelBase : `absolute bottom-24 left-3 right-3 z-50 ${panelBase}`;
    const panelStyle: React.CSSProperties = !touchUi
        ? {}
        : isOpen
          ? { position: 'fixed', left: 0, right: 0, bottom: keyboardInset, padding: '0 8px 8px', zIndex: 450 }
          : {};

    // chat disabled for this room — render nothing (no log, no touch button).
    if (!enabled) return null;

    return (
        <>
            {/* touch open: a dim backdrop above the touch-controls layer — captures stray
                touches (so the joystick/buttons under it are inert while typing) + taps to close. */}
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
            {/* touch closed: the opener — a chat bubble on the left edge, a little past centre
                (below any top-notch/HUD, above the lower-left move zone). the single newest
                line briefly flashes to its RIGHT so it stays on-screen. */}
            {touchUi && !isOpen && (
                <div
                    className="fixed left-3 top-[56%] -translate-y-1/2 flex items-center gap-2 pointer-events-none"
                    // above the touch-controls layer (z-400): the button sits inside the
                    // lower-left dynamic-joystick zone, so it must capture its own taps.
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
                        <MessageSquare size={20} strokeWidth={2.2} />
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

/** signature line: `/set <block>` with the active arg bolded; or the parse
 *  error / command description underneath. */
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
