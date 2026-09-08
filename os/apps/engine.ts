// os/apps/engine.ts, how an OS app reaches the engine: through its realm's runner,
// so the module instance is the one the user's declarations registered into. A
// static engine import in an app would be a second instance. The env flags are the
// realm's identity, and the engine dist is env-neutral (every chunk reads the live
// `bongle/env` object), so they must land before the first module that reads one.

import type { Runner } from '../interface';

export async function importEngine(runner: Runner, side: 'client' | 'server', entry: string): Promise<void> {
    const { env } = await runner.import('bongle/env');
    env.client = side === 'client';
    env.server = side === 'server';
    env.editor = true;
    await runner.import(entry);
}
