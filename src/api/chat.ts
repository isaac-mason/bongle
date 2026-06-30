/**
 * public chat namespace. scripts register slash commands + chat handlers
 * through here. transport rides the first-class `chat_input`
 * (client→server) and `chat_broadcast` (server→client) protocol messages.
 *
 * usage (shared script, runs on both client and server):
 *   const giveCmd = chat.command(ctx, {
 *       name: '/give',
 *       description: 'give a player an item',
 *       args: [{ name: 'item', type: 'string' }],
 *   });
 *   if (env.server) {
 *       chat.listen(ctx, giveCmd, ({ args, from }) => { ... });
 *   }
 *
 * `chat.command` registers the spec on whichever side runs it (both, for a
 * shared script) so completion + parse-validation work on both. `chat.listen`
 * attaches a handler scoped to ctx, auto-removed on script dispose. side is
 * implied by *where* listen is called; no explicit flag.
 */

import { env } from 'bongle';
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
import * as ServerChat from '../server/chat';

export type { ArgType, CommandHandle, CommandInvocation, CommandSpec, MessageHandler, ParseResult, Suggestion };

function commandsOf(ctx: ScriptContext): ChatCommands.ChatCommands | null {
    if (env.client && ctx.client?.room) return ctx.client.room.chat.commands;
    if (env.server && ctx.server?.room) return ctx.server.room.chat.commands;
    return null;
}

/**
 * register a chat command spec. returns a handle; attach a runtime handler
 * with `chat.listen(ctx, handle, fn)`. spec lives in the room's chat as
 * long as the script instance is alive, auto-removed on dispose.
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
 * attach a handler for `handle`'s command, scoped to ctx. when the input
 * pipeline finds a command match with a local listener, the listener runs
 * and the command is "consumed" (not forwarded onward).
 *
 * call on whichever side should execute the command. shared scripts gate
 * with `env.server` / `env.client`.
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
 * listen for plain chat messages broadcast to this room. fires on every
 * non-command message (server-broadcast ChatBroadcast). client-only,
 * server scripts that want to inspect inbound chat should register a
 * `chat.command` of their own.
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
 * emit a chat message. on the server, broadcasts to every client in the
 * room (appears as a system message). on the client, forwards the text to
 * the server as if the user typed it, useful for programmatic /me, etc.
 *
 * the text may carry inline `[…]` formatting tags, applied by the chat panel
 * as it renders:
 *
 * - `[#rrggbb]`, set the colour to any 24-bit hex (e.g. `[#ff8800]`),
 *   case-insensitive.
 * - `[b]` `[i]` `[u]` `[s]`, turn bold / italic / underline / strike ON.
 * - `[/]`, reset colour and every style back to the default.
 *
 * formatting is cumulative: a colour tag swaps only the colour and leaves any
 * active styles intact (`[b][#ff8800]bold orange`), so colours and styles
 * layer freely, only `[/]` clears them. any bracketed run that isn't a known
 * tag (`[lol]`, `[1]`, an emote) renders verbatim, so ordinary text using
 * brackets is never eaten. tags ride inside the plain string, there's no
 * structured payload, so they degrade gracefully to readable text anywhere
 * the panel isn't doing the rendering.
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

/** define a reusable arg type (e.g. an `item` resolver). */
export function argType<T>(t: ArgType<T>): ArgType<T> {
    return ChatCommands.defineArgType(t);
}

/** inline enum arg type, one-shot, no global registration. */
export function enumType<T extends string>(values: T[]): ArgType<T> {
    return ChatCommands.enumType(values);
}
