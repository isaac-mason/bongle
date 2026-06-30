/**
 * per-room server chat. composes core/chat-commands. data-driven: inbound
 * `chat_input` protocol messages are pushed onto `inbox`; system or
 * pass-through broadcasts are pushed onto `outbox`. both are drained by
 * `tick` each frame, inbox entries are parsed (consumed by local handlers
 * or promoted into the outbox as plain messages), outbox entries are
 * fanned to every client in the room via `Net.broadcastToRoom`.
 *
 * server has no line buffer, no subscribers, no message-listener set: it
 * never displays chat and never re-broadcasts to itself.
 */

import type { Client } from 'bongle/interface';
import type { CommandInvocation } from '../core/chat-commands';
import * as ChatCommands from '../core/chat-commands';
import * as Profanity from '../core/profanity';
import type { Clients } from './clients';
import type { ServerNet } from './net';
import * as Net from './net';
import type { Room, Rooms } from './rooms';

export type ChatBroadcastKind = 'message' | 'system' | 'error' | 'input';

export type ChatBroadcastMsg = {
    from: string;
    text: string;
    kind: ChatBroadcastKind;
    /** when set, deliver this entry to that one client only instead of
     *  fanning to the whole room. used by the shadow profanity filter: a
     *  flagged line is echoed back to its sender alone. */
    to?: Client;
};

export type ChatInputEntry = {
    line: string;
    /** undefined when the entry was queued by a server-side script rather
     *  than by an inbound `chat_input` from a client. */
    from?: Client;
};

export type ChatServer = {
    commands: ChatCommands.ChatCommands;
    inbox: ChatInputEntry[];
    outbox: ChatBroadcastMsg[];
};

export function init(): ChatServer {
    return {
        commands: ChatCommands.init(),
        inbox: [],
        outbox: [],
    };
}

/** queue an inbound `chat_input` line for processing on the next tick. */
export function enqueueInput(chat: ChatServer, entry: ChatInputEntry): void {
    chat.inbox.push(entry);
}

/** queue a chat line for broadcast to every client in the room. used by
 *  `chat.message(ctx, text)` on the server side and as the promotion path
 *  for unconsumed inbox entries. */
export function broadcast(chat: ChatServer, msg: ChatBroadcastMsg): void {
    chat.outbox.push(msg);
}

/**
 * drain inbox and outbox. inbox entries are parsed: locally listened
 * commands run inline; everything else (plain messages, unhandled slash)
 * is promoted into the outbox as a plain message. outbox entries are
 * fanned to every client as `chat_broadcast`.
 *
 * called once per server frame per room from the room tick loop.
 */
export function tick(chat: ChatServer, net: ServerNet, rooms: Rooms, room: Room, clients: Clients): void {
    for (let i = 0; i < chat.inbox.length; i++) {
        const entry = chat.inbox[i]!;
        processInputEntry(chat, entry, clients);
    }
    chat.inbox.length = 0;

    for (let i = 0; i < chat.outbox.length; i++) {
        const msg = chat.outbox[i]!;
        const wire = {
            type: 'chat_broadcast',
            roomId: room.id,
            from: msg.from,
            text: msg.text,
            kind: msg.kind,
        } as const;
        if (msg.to !== undefined) {
            Net.send(net, msg.to, wire);
        } else {
            Net.broadcastToRoom(net, rooms, room, wire);
        }
    }
    chat.outbox.length = 0;
}

function processInputEntry(chat: ChatServer, entry: ChatInputEntry, clients: Clients): void {
    const trimmed = entry.line.trim();
    if (!trimmed) return;
    const parsed = ChatCommands.tryParseCommand(chat.commands, trimmed);
    if (parsed && !('error' in parsed) && ChatCommands.hasLocalListener(chat.commands, parsed.cmd.name)) {
        const inv: CommandInvocation = {
            args: parsed.argValues,
            flags: parsed.flagValues,
            from: entry.from,
        };
        ChatCommands.dispatchLocal(chat.commands, parsed.cmd, inv, (text) =>
            broadcast(chat, { from: 'system', text, kind: 'error' }),
        );
        return;
    }
    const fromClient = entry.from;
    if (fromClient === undefined) {
        // server-script-queued line: trusted, never filtered.
        broadcast(chat, { from: 'system', text: trimmed, kind: 'system' });
        return;
    }
    const msg: ChatBroadcastMsg = {
        from: displayNameOf(fromClient, clients),
        text: trimmed,
        kind: 'message',
    };
    // shadow profanity filter: a flagged line is echoed back to its sender
    // alone (their UI renders it as normal) and never fanned to the room, so
    // there's no feedback signal to probe the filter against.
    if (Profanity.containsProfanity(trimmed)) msg.to = fromClient;
    broadcast(chat, msg);
}

function displayNameOf(client: Client, clients: Clients): string {
    return clients.connected.get(client)?.user.username ?? 'anon';
}
