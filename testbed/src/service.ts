import { LogAll, logCall } from '@workspace/instrument';

export interface User {
  id: number;
  name: string;
}

@LogAll({ label: 'Service' })
export class Service {
  greet(name: string) {
    return `Hello, ${name}!`;
  }

  async fetchUser(id: number): Promise<User> {
    await new Promise((r) => setTimeout(r, 50));
    return { id, name: `user-${id}` };
  }

  // Sync with optional parameter
  greetOptional(name: string, title?: string) {
    return `Hello, ${title ? title + ' ' : ''}${name}!`;
  }

  // Sync with default parameter
  defaultGreet(name = 'World') {
    return this.greet(name);
  }

  // Sync with rest parameters
  sum(...nums: number[]) {
    return nums.reduce((a, b) => a + b, 0);
  }

  // Sync that may throw
  maybeThrow(shouldThrow?: boolean) {
    if (shouldThrow) throw new Error('boom-sync');
    return 42;
  }

  // Async with optional parameter and possible rejection
  async waitAndMaybeFail(delayMs: number, shouldFail?: boolean) {
    await new Promise((r) => setTimeout(r, delayMs));
    if (shouldFail) throw new Error('boom-async');
    return 'ok';
  }

  // Async with optional parameter returning nullable
  async fetchOptional(id?: number): Promise<User | null> {
    if (id == null) return null;
    return this.fetchUser(id);
  }
}

export const add = (a: number, b: number) => a + b;
export const loggedAdd = logCall(add, { label: 'add', includeThis: false });

// Standalone functions for broader coverage
export const multiply = (a: number, b?: number) => a * (b ?? 2);
export const loggedMultiply = logCall(multiply, { label: 'multiply' });

export const sumRest = (...nums: number[]) => nums.reduce((a, b) => a + b, 0);
export const loggedSumRest = logCall(sumRest, { label: 'sumRest' });

export const maybeFailSync = (x?: number) => {
  if (typeof x === 'number' && x < 0) throw new Error('negative-not-allowed');
  return x ?? 0;
};
export const loggedMaybeFailSync = logCall(maybeFailSync, { label: 'maybeFailSync' });

export const quickAsync = async (value?: string) => value ?? 'default';
export const loggedQuickAsync = logCall(quickAsync, { label: 'quickAsync' });

// Class with includeThis to demonstrate logging of instance state
@LogAll({ label: 'State', includeThis: true })
export class WithState {
  private count = 0;
  inc(by?: number) {
    this.count += by ?? 1;
    return this.count;
  }
  async incLater(by?: number) {
    await new Promise((r) => setTimeout(r, 10));
    return this.inc(by);
  }
}
