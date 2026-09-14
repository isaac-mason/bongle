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
    /** when set, deliver only to this client instead of fanning to the room. */
    to?: Client;
};

export type ChatInputEntry = {
    line: string;
    /** undefined when the entry was queued by a server-side script rather
     *  than by an inbound `chat_input` from a client. */
    from?: Client;
};

export type ChatServer = {
    /** slash-command specs + their local listeners for this room. */
    commands: ChatCommands.ChatCommands;
    /** false silences this room: `tick` discards both queues unparsed, so no
     *  input is handled and nothing is broadcast. toggled by `setEnabled`. */
    enabled: boolean;
    /** inbound `chat_input` lines queued by the network layer; drained by `tick`. */
    inbox: ChatInputEntry[];
    /** lines staged for broadcast; drained by `tick` into `chat_broadcast`. */
    outbox: ChatBroadcastMsg[];
};

export function init(): ChatServer {
    return {
        commands: ChatCommands.init(),
        enabled: true,
        inbox: [],
        outbox: [],
    };
}

export function setEnabled(chat: ChatServer, enabled: boolean): void {
    chat.enabled = enabled;
}

/** queue an inbound `chat_input` line for processing on the next tick. */
export function enqueueInput(chat: ChatServer, entry: ChatInputEntry): void {
    chat.inbox.push(entry);
}

/** queue a chat line for broadcast to every client in the room. */
export function broadcast(chat: ChatServer, msg: ChatBroadcastMsg): void {
    chat.outbox.push(msg);
}

/** drains inbox and outbox once per server frame. inbox entries with a local listener
 *  run inline; everything else is promoted into the outbox as a plain message and
 *  fanned to every client as `chat_broadcast`. */
export function tick(chat: ChatServer, net: ServerNet, rooms: Rooms, room: Room, clients: Clients): void {
    if (!chat.enabled) {
        chat.inbox.length = 0;
        chat.outbox.length = 0;
        return;
    }

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
    // shadow profanity filter: echo flagged lines back to the sender alone, giving
    // no feedback signal to probe the filter with.
    if (Profanity.containsProfanity(trimmed)) msg.to = fromClient;
    broadcast(chat, msg);
}

function displayNameOf(client: Client, clients: Clients): string {
    return clients.connected.get(client)?.user.username ?? 'anon';
}
