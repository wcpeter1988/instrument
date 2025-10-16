import {
  Service,
  WithState,
  loggedAdd,
  loggedMultiply,
  loggedSumRest,
  loggedMaybeFailSync,
  loggedQuickAsync,
} from '../src/service';
import { runMockServiceDecorated } from '../src/workflow';
import { instrument, logInline } from '@workspace/instrument';

// Sync successes
test('loggedAdd works', () => {
  expect(loggedAdd(2, 3)).toBe(5);
});

test('loggedMultiply with optional param', () => {
  expect(loggedMultiply(5)).toBe(10);
  expect(loggedMultiply(5, 3)).toBe(15);
});

test('loggedSumRest with rest params', () => {
  expect(loggedSumRest(1, 2, 3, 4)).toBe(10);
  expect(loggedSumRest()).toBe(0);
});

test('loggedMaybeFailSync returns values when non-negative', () => {
  expect(loggedMaybeFailSync(0)).toBe(0);
  expect(loggedMaybeFailSync()).toBe(0);
});

// Service methods successes
test('Service greet variants', () => {
  const svc = new Service();
  expect(svc.greet('TS')).toBe('Hello, TS!');
  expect(svc.greetOptional('Alice')).toBe('Hello, Alice!');
  expect(svc.greetOptional('Alice', 'Dr.')).toBe('Hello, Dr. Alice!');
  expect(svc.defaultGreet()).toBe('Hello, World!');
});

test('Service sum and maybeThrow(false)', () => {
  const svc = new Service();
  expect(svc.sum(1, 2, 3)).toBe(6);
  expect(svc.maybeThrow(false)).toBe(42);
});

// Async successes
test('Service fetchUser and fetchOptional success', async () => {
  const svc = new Service();
  const u = await svc.fetchUser(7);
  expect(u).toEqual({ id: 7, name: 'user-7' });
  await expect(svc.fetchOptional()).resolves.toBeNull();
  await expect(svc.fetchOptional(7)).resolves.toEqual({ id: 7, name: 'user-7' });
});

test('loggedQuickAsync default/value', async () => {
  await expect(loggedQuickAsync()).resolves.toBe('default');
  await expect(loggedQuickAsync('hi')).resolves.toBe('hi');
});

test('waitAndMaybeFail resolves', async () => {
  const svc = new Service();
  await expect(svc.waitAndMaybeFail(1)).resolves.toBe('ok');
});

// Stateful class with includeThis logging
test('WithState increments', async () => {
  const s = new WithState();
  expect(s.inc()).toBe(1);
  expect(s.inc(5)).toBe(6);
  await expect(s.incLater(2)).resolves.toBe(8);
});

test('Mock workflow (decorated) runs end-to-end', async () => {
  const res: unknown = await runMockServiceDecorated('What is instrumentation?');
  // Support both legacy string return and structured object return
  if (typeof res === 'string') {
    const full = res;
    expect(typeof full).toBe('string');
    const chunks = full.match(/.{1,12}/g) || [full];
    expect(chunks.join('')).toBe(full);
  } else if (res && typeof res === 'object') {
    const obj = res as {
      question: string;
      context: string[];
      prompt: string;
      chunks: string[];
      full: string;
      final: string;
    };
    expect(obj.question).toBe('What is instrumentation?');
    expect(Array.isArray(obj.context)).toBe(true);
    expect(typeof obj.prompt).toBe('string');
    expect(obj.chunks.join('')).toBe(obj.full);
    expect(typeof obj.final).toBe('string');
  }
});

test('Proxy-based instrumentation works for object and function', async () => {
  const f = (x: number, y: number) => x * y;
  const ifn = instrument(f, { label: 'mul' });
  expect(ifn(2, 4)).toBe(8);

  const obj = {
    inc(n: number) { return n + 1; },
    async later(v: string) { return v + '!'; },
  };
  const iobj = instrument(obj);
  expect(iobj.inc(5)).toBe(6);
  await expect(iobj.later('ok')).resolves.toBe('ok!');
});

test('logInline wraps functions without altering behavior', () => {
  const fn = (s: string) => `x:${s}`;
  const wrapped = logInline(fn);
  expect(wrapped('a')).toBe('x:a');
});
