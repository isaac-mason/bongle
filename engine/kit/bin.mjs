#!/usr/bin/env node
// npm strips `bin` entries whose path doesn't end in `.js`/`.cjs`/`.mjs`,
// so the published bin can't point straight at `./index.ts`. This shim
// registers tsx's ESM loader for the running process and then imports
// the real TS entry — same effect as `tsx ./index.ts`, but invokable as
// the bin's executable file.
import { register } from 'tsx/esm/api';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

register();

const here = path.dirname(fileURLToPath(import.meta.url));
await import(path.join(here, 'index.ts'));
