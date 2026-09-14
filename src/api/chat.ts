import type { MessageHandler } from '../client/chat';
import * as ClientChat from '../client/chat';
import type {
    ArgType,
    CommandHandle,
    CommandHandler,
    CommandInvocation,
    CommandSpec,
    ParseResult,
    Suggestion,
} from '../core/chat-commands';
import * as ChatCommands from '../core/chat-commands';
import type { ScriptContext } from '../core/scene/scripts';
import { env } from '../env';
import * as ServerChat from '../server/chat';

export type { ArgType, CommandHandle, CommandInvocation, CommandSpec, MessageHandler, ParseResult, Suggestion };

function commandsOf(ctx: ScriptContext): ChatCommands.ChatCommands | null {
    if (env.client && ctx.client?.room) return ctx.client.room.chat.commands;
    if (env.server && ctx.server?.room) return ctx.server.room.chat.commands;
    return null;
}

/**
 * register a chat command spec. returns a handle; attach a runtime handler
 * with `chat.listen(ctx, handle, fn)`. auto-removed on script dispose.
 */
export function command(ctx: ScriptContext, spec: CommandSpec): CommandHandle {
    const instance = ctx._instance;
    if (!instance) return { name: spec.name };
    if (env.client && ctx.client?.room) {
        const chat = ctx.client.room.chat;
        ClientChat.registerCommand(chat, spec);
        instance.onDispose.add(() => ClientChat.unregisterCommand(chat, spec.name));
        return { name: spec.name };
    }
    if (env.server && ctx.server?.room) {
        const chat = ctx.server.room.chat;
        ChatCommands.register(chat.commands, spec);
        instance.onDispose.add(() => ChatCommands.unregister(chat.commands, spec.name));
        return { name: spec.name };
    }
    return { name: spec.name };
}

/**
 * attach a handler for `handle`'s command, scoped to ctx. a matched command
 * is consumed by the listener, not forwarded onward.
 */
export function listen(ctx: ScriptContext, handle: CommandHandle, fn: CommandHandler): () => void {
    const instance = ctx._instance;
    const cmds = commandsOf(ctx);
    if (!instance || !cmds) return () => {};
    const off = ChatCommands.addListener(cmds, handle.name, fn);
    instance.onDispose.add(off);
    return () => {
        off();
        instance.onDispose.delete(off);
    };
}

/**
 * listen for plain chat messages broadcast to this room. client-only;
 * server scripts should register a `chat.command` instead.
 */
export function onMessage(ctx: ScriptContext, fn: MessageHandler): () => void {
    if (!env.client) return () => {};
    const instance = ctx._instance;
    const chat = ctx.client?.room?.chat;
    if (!instance || !chat) return () => {};
    const off = ClientChat.addMessageListener(chat, fn);
    instance.onDispose.add(off);
    return () => {
        off();
        instance.onDispose.delete(off);
    };
}

/**
 * emit a chat message. on the server, broadcasts to every client in the room
 * as a system message. on the client, forwards the text as if the user typed it.
 *
 * text may carry inline formatting tags: `[#rrggbb]` sets colour, `[b]` `[i]`
 * `[u]` `[s]` turn on bold/italic/underline/strike, `[/]` resets both. tags
 * are cumulative until `[/]`; unrecognised bracketed text renders verbatim.
 *
 * @example
 * // "Alice" aqua+bold, the verb grey, "Bob" red+bold
 * chat.message(ctx, `[#55ffff][b]Alice[/] [#aaaaaa]slew[/] [#ff5555][b]Bob[/]`);
 */
export function message(ctx: ScriptContext, text: string): void {
    if (env.server && ctx.server?.room) {
        ServerChat.broadcast(ctx.server.room.chat, { from: 'system', text, kind: 'system' });
        return;
    }
    if (env.client && ctx.client?.room) {
        ClientChat.submit(ctx.client.room.chat, text);
    }
}

/**
 * enable or disable chat for the calling script's room (per-room, not global).
 * on the client it hides the chat UI; on the server it drops inbound and
 * outbound chat traffic. default is enabled.
 */
export function setEnabled(ctx: ScriptContext, enabled: boolean): void {
    if (env.client && ctx.client?.room) ClientChat.setEnabled(ctx.client.room.chat, enabled);
    if (env.server && ctx.server?.room) ServerChat.setEnabled(ctx.server.room.chat, enabled);
}

/** define a reusable arg type (e.g. an `item` resolver). */
export function argType<T>(t: ArgType<T>): ArgType<T> {
    return ChatCommands.defineArgType(t);
}

/** inline enum arg type, one-shot, no global registration. */
export function enumType<T extends string>(values: T[]): ArgType<T> {
    return ChatCommands.enumType(values);
}
