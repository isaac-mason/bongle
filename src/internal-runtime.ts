import { __addDeps } from './core/capture/dep-wrap';
import { registerFlushHandler, requestFlush } from './core/capture/flush';
import { __decideReload, __popModule, __pushModule } from './core/capture/module-scope';

export const __bongle = {
    push: __pushModule,
    pop: __popModule,
    reload: __decideReload,
    deps: __addDeps,
    flush: requestFlush,
    registerFlush: registerFlushHandler,
};
