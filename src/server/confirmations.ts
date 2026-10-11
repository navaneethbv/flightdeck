import { randomUUID } from 'node:crypto';
import { RequestError } from './request-body.js';

export interface ConfirmationRun {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'awaiting_confirmation';
  confirmId?: string;
  confirmPrompt?: string;
  confirmOperation?: string;
}

interface PendingConfirmation {
  runId: string;
  operation: string;
  resolve: (approved: boolean) => void;
}

/** Single-use, operation-bound decisions, serialized separately for each run. */
export class ConfirmationQueue {
  private readonly pending = new Map<string, PendingConfirmation>();
  private stopped = false;

  constructor(private readonly timeoutMs: number, private readonly onUpdate: () => void) {}

  requester(run: ConfirmationRun): (prompt: string, operation: string, signal?: AbortSignal) => Promise<boolean> {
    let previous = Promise.resolve();
    return (prompt, operation, signal) => {
      const decision = previous.then(() => this.prompt(run, prompt, operation, signal));
      previous = decision.then(() => undefined);
      return decision;
    };
  }

  decide(confirmId: string, operation: string, approved: boolean): void {
    const pending = this.pending.get(confirmId);
    if (!pending) throw new RequestError(404, `no pending confirmation "${confirmId}"`);
    if (pending.operation !== operation) {
      throw new RequestError(400, 'confirmation does not match the pending operation');
    }
    pending.resolve(approved);
  }

  denyRun(runId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.runId === runId) pending.resolve(false);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const pending of this.pending.values()) pending.resolve(false);
  }

  private prompt(run: ConfirmationRun, prompt: string, operation: string, signal?: AbortSignal): Promise<boolean> {
    if (this.stopped || signal?.aborted || run.status === 'failed' || run.status === 'succeeded') {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const confirmId = randomUUID();
      const finish = (approved: boolean) => {
        const active = run.status === 'awaiting_confirmation' && !this.stopped && !signal?.aborted;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending.delete(confirmId);
        if (run.status === 'awaiting_confirmation') run.status = 'running';
        run.confirmId = undefined;
        run.confirmPrompt = undefined;
        run.confirmOperation = undefined;
        resolve(approved && active);
      };
      const abort = () => { finish(false); };
      const timer = setTimeout(abort, this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(confirmId, { runId: run.id, operation, resolve: finish });
      run.status = 'awaiting_confirmation';
      run.confirmId = confirmId;
      run.confirmPrompt = prompt;
      run.confirmOperation = operation;
      this.onUpdate();
    });
  }
}
