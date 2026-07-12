/**
 * per-room client chat. composes core/chat-commands. owns the displayable
 * line buffer + UI subscribers + message-listener set. data-driven
 * transport: inbound `chat_broadcast` payloads land in `inbox`, outbound
 * user-typed lines land in `outbox`. `tick(net, room)` drains both each
 * frame, inbox entries become lines + fan out to listeners, outbox lines
 * are enqueued as `chat_input` protocol messages.
 *
 * scripts and the UI panel call `submit(chat, line)` for input and
 * `subscribe(chat, fn)` for re-renders.
 */

import type { CommandHandler, CommandInvocation } from '../core/chat-commands';
import * as ChatCommands from '../core/chat-commands';
import type { ClientNet } from './net';
import * as Net from './net';

export type ChatLineKind = 'message' | 'system' | 'error' | 'input';

export type ChatLine = {
    kind: ChatLineKind;
    text: string;
    from?: string;
    ts: number;
};

export type ChatBroadcastMsg = { from: string; text: string; kind: ChatLineKind };

export type MessageHandler = (msg: ChatBroadcastMsg) => void;

const MAX_LINES = 100;

export type ChatClient = {
    /** false hides this room's chat panel; the line buffer and transport keep
     *  running, so only the UI is gated. toggled by `setEnabled`. */
    enabled: boolean;
    /** slash-command specs + their local listeners for this room. */
    commands: ChatCommands.ChatCommands;
    /** displayable line buffer, capped at `MAX_LINES`. replaced (never mutated
     *  in place) on append so `useSyncExternalStore` sees a fresh snapshot. */
    lines: ChatLine[];
    /** UI re-render callbacks, fired on any change to `lines`, `enabled`, or
     *  the command list. */
    subscribers: Set<() => void>;
    /** script listeners for inbound plain chat (`chat.onMessage`). */
    messageListeners: Set<MessageHandler>;
    /** inbound `chat_broadcast` payloads queued by the network layer;
     *  drained by `tick` into `lines` + `messageListeners`. */
    inbox: ChatBroadcastMsg[];
    /** outbound lines queued by `submit`; drained by `tick` into
     *  `chat_input` protocol messages. */
    outbox: string[];
};

export function init(): ChatClient {
    const chat: ChatClient = {
        commands: ChatCommands.init(),
        enabled: true,
        lines: [],
        subscribers: new Set(),
        messageListeners: new Set(),
        inbox: [],
        outbox: [],
    };
    registerBuiltins(chat);
    return chat;
}

/** built-in commands available in every room (play and edit). currently just
 *  `/help`, which dumps the full command list grouped by WE-style vs. bare. */
function registerBuiltins(chat: ChatClient): void {
    ChatCommands.register(chat.commands, {
        name: 'help',
        description: 'list available commands',
        args: [],
    });
    ChatCommands.addListener(chat.commands, 'help', () => {
        const all = [...chat.commands.specs.values()];
        const world = all.filter((c) => c.name.startsWith('/'));
        const general = all.filter((c) => !c.name.startsWith('/'));
        const fmt = (c: ChatCommands.CommandSpec) => `/${c.name} — ${c.description}`;
        const lines: string[] = [];
        if (world.length) lines.push(...world.map(fmt));
        if (world.length && general.length) lines.push('');
        if (general.length) lines.push(...general.map(fmt));
        appendLine(chat, { kind: 'system', text: lines.join('\n') });
    });
}

export function subscribe(chat: ChatClient, fn: () => void): () => void {
    chat.subscribers.add(fn);
    return () => chat.subscribers.delete(fn);
}

/** show or hide this room's chat panel. notifies subscribers so the panel
 *  re-renders — they snapshot `enabled` alongside `lines`. */
export function setEnabled(chat: ChatClient, enabled: boolean): void {
    if (chat.enabled === enabled) return;
    chat.enabled = enabled;
    notify(chat);
}

function notify(chat: ChatClient): void {
    for (const fn of chat.subscribers) {
        try {
            fn();
        } catch {
            // swallow, subscriber errors shouldn't break dispatch
        }
    }
}

export function appendLine(chat: ChatClient, line: Omit<ChatLine, 'ts'>): void {
    // new array reference each append, useSyncExternalStore compares
    // snapshots by Object.is, so an in-place push would silently skip
    // re-renders (visible as "new messages don't appear" while closed).
    const next = chat.lines.concat({ ...line, ts: Date.now() });
    chat.lines = next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
    notify(chat);
}

export function addMessageListener(chat: ChatClient, fn: MessageHandler): () => void {
    chat.messageListeners.add(fn);
    return () => {
        chat.messageListeners.delete(fn);
    };
}

/** ChatCommands.register + notify so the panel reflects the new command in
 *  its completion list. */
export function registerCommand(chat: ChatClient, spec: ChatCommands.CommandSpec): void {
    ChatCommands.register(chat.commands, spec);
    notify(chat);
}

export function unregisterCommand(chat: ChatClient, name: string): void {
    ChatCommands.unregister(chat.commands, name);
    notify(chat);
}

export function addCommandListener(chat: ChatClient, name: string, fn: CommandHandler): () => void {
    return ChatCommands.addListener(chat.commands, name, fn);
}

/** queue an inbound `chat_broadcast` payload for processing on the next
 *  tick. called by the network layer in `engine-client.ts`. */
export function enqueueBroadcast(chat: ChatClient, msg: ChatBroadcastMsg): void {
    chat.inbox.push(msg);
}

/**
 * user submitted `line` via the chat panel (or a script called
 * `chat.message(ctx, line)`).
 *   - slash command with a local listener → echo locally + dispatch, done.
 *   - slash command with a local spec but no local listener → echo locally
 *     + forward to the server (the spec was registered on both sides; the
 *     listener lives server-side).
 *   - slash command with no local spec → echo locally + error. every legit
 *     command registers a spec on the client (see api/chat.ts) so an
 *     unknown slash is a typo, not a server-side command.
 *   - plain chat (no leading '/') → no local echo; stage onto `outbox` for
 *     the next tick to forward as `chat_input`. the server fans it back via
 *     `chat_broadcast` (which includes us), so a local echo would double
 *     up.
 */
export function submit(chat: ChatClient, line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.charAt(0) === '/') {
        appendLine(chat, { kind: 'input', text: trimmed });
        const parsed = ChatCommands.tryParseCommand(chat.commands, trimmed);
        if (!parsed) {
            const name = trimmed.split(/\s+/)[0] ?? trimmed;
            appendLine(chat, { kind: 'error', text: `unknown command: ${name}` });
            return;
        }
        if ('error' in parsed) {
            appendLine(chat, { kind: 'error', text: parsed.error });
            return;
        }
        if (ChatCommands.hasLocalListener(chat.commands, parsed.cmd.name)) {
            const inv: CommandInvocation = { args: parsed.argValues, flags: parsed.flagValues };
            ChatCommands.dispatchLocal(chat.commands, parsed.cmd, inv, (text) => appendLine(chat, { kind: 'error', text }));
            return;
        }
        chat.outbox.push(trimmed);
        return;
    }

    chat.outbox.push(trimmed);
}

/**
 * drain inbox and outbox. inbox payloads append to `lines` + fan out to
 * `messageListeners`; outbox lines flush as `chat_input` protocol messages.
 * called once per client frame per room from the client tick loop.
 */
export function tick(chat: ChatClient, net: ClientNet, roomId: string): void {
    for (let i = 0; i < chat.inbox.length; i++) {
        const msg = chat.inbox[i]!;
        appendLine(chat, { kind: msg.kind, text: msg.text, from: msg.from });
        for (const fn of chat.messageListeners) {
            try {
                fn(msg);
            } catch {
                // swallow, listener errors shouldn't break dispatch
            }
        }
    }
    chat.inbox.length = 0;

    for (let i = 0; i < chat.outbox.length; i++) {
        const line = chat.outbox[i]!;
        Net.send(net, { type: 'chat_input', roomId, line });
    }
    chat.outbox.length = 0;
}
