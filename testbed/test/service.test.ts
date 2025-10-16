import {
  Service,
  WithState,
  loggedAdd,
  loggedMultiply,
  loggedSumRest,
  loggedMaybeFailSync,
  loggedQuickAsync,
} from '../src/service';

// Sync functions
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

test('loggedMaybeFailSync throws on negative', () => {
  expect(() => loggedMaybeFailSync(-1)).toThrow();
  expect(loggedMaybeFailSync(0)).toBe(0);
  expect(loggedMaybeFailSync()).toBe(0);
});

// Service methods
test('Service greet variants', () => {
  const svc = new Service();
  expect(svc.greet('TS')).toBe('Hello, TS!');
  expect(svc.greetOptional('Alice')).toBe('Hello, Alice!');
  expect(svc.greetOptional('Alice', 'Dr.')).toBe('Hello, Dr. Alice!');
  expect(svc.defaultGreet()).toBe('Hello, World!');
});

test('Service sum and maybeThrow', () => {
  const svc = new Service();
  expect(svc.sum(1, 2, 3)).toBe(6);
  expect(svc.maybeThrow(false)).toBe(42);
  expect(() => svc.maybeThrow(true)).toThrow();
});

// Async functions
test('Service fetchUser and fetchOptional', async () => {
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

test('waitAndMaybeFail resolves/rejects', async () => {
  const svc = new Service();
  await expect(svc.waitAndMaybeFail(1)).resolves.toBe('ok');
  await expect(svc.waitAndMaybeFail(1, true)).rejects.toThrow('boom-async');
});

// Stateful class with includeThis logging
test('WithState increments', async () => {
  const s = new WithState();
  expect(s.inc()).toBe(1);
  expect(s.inc(5)).toBe(6);
  await expect(s.incLater(2)).resolves.toBe(8);
});
