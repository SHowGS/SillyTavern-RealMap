export class GenerationCancellationScope {
    constructor(mainSignal = null) {
        this.controller = new AbortController();
        this.stopRequested = false;
        this.mainControllerReady = false;
        this.attachMainSignal(mainSignal);
    }

    get signal() {
        return this.controller.signal;
    }

    attachMainSignal(signal) {
        if (!(signal instanceof AbortSignal)) return;
        this.mainControllerReady = true;
        if (signal.aborted) {
            this.requestStop(signal.reason);
            return;
        }
        signal.addEventListener(
            'abort',
            () => this.requestStop(signal.reason),
            { once: true, signal: this.signal },
        );
    }

    markMainControllerReady() {
        this.mainControllerReady = true;
    }

    shouldInstallAsExternalController() {
        return !this.mainControllerReady && !this.signal.aborted;
    }

    requestStop(reason = '用户点击停止') {
        this.stopRequested = true;
        if (!this.signal.aborted) {
            this.controller.abort(reason);
        }
    }

    createChildController() {
        const child = new AbortController();
        if (this.signal.aborted) {
            child.abort(this.signal.reason);
            return child;
        }

        const abortChild = () => child.abort(this.signal.reason);
        const detach = () => this.signal.removeEventListener('abort', abortChild);
        this.signal.addEventListener('abort', abortChild, { once: true });
        child.signal.addEventListener('abort', detach, { once: true });
        return child;
    }
}
