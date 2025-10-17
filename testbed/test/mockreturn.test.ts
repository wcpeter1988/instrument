import { LogMethod, logCall, instrument } from '@workspace/instrument';

class DemoStatic {
  calls: number = 0;
  run(a: number, b: number) {
    this.calls++;
    return a + b;
  }
}
// Manually apply decorator to avoid TS decorator signature issues in test environment
{
  const desc = Object.getOwnPropertyDescriptor(DemoStatic.prototype, 'run')!;
  LogMethod({ mockReturn: 123, logReturn: true })(DemoStatic.prototype, 'run', desc);
  Object.defineProperty(DemoStatic.prototype, 'run', desc);
}

class DemoFactory {
  calls: number = 0;
  run(a: number, b: number) {
    this.calls++;
    return { sum: a + b, mocked: false };
  }
}
{
  const desc = Object.getOwnPropertyDescriptor(DemoFactory.prototype, 'run')!;
  LogMethod({ mockReturn: ({ args }: { args: any[] }) => ({ sum: args[0] + args[1], mocked: true }), logReturn: true })(DemoFactory.prototype, 'run', desc);
  Object.defineProperty(DemoFactory.prototype, 'run', desc);
}

describe('mockReturn option', () => {
  test('static mock prevents original execution', () => {
    const d = new DemoStatic();
    const r = d.run(2, 3);
    expect(r).toBe(123);
    expect(d.calls).toBe(0);
  });

  test('factory mock prevents original and computes value', () => {
    const d = new DemoFactory();
    const r = d.run(5, 7);
    expect(r).toEqual({ sum: 12, mocked: true });
    expect(d.calls).toBe(0);
  });

  test('logCall static mock', () => {
    let executed = false;
    const fn = (x: number) => { executed = true; return x * 2; };
    const wrapped = logCall(fn, { mockReturn: 999, logReturn: true });
    const res = wrapped(10);
    expect(res).toBe(999);
    expect(executed).toBe(false);
  });

  test('instrument() function mock', () => {
    let executed = false;
    const fn = (x: number, y: number) => { executed = true; return x + y; };
  const inst = instrument(fn, { mockReturn: ({ args }: { args: any[] }) => args[0] * args[1] });
    const res = (inst as any)(3, 4);
    expect(res).toBe(12);
    expect(executed).toBe(false);
  });
});
