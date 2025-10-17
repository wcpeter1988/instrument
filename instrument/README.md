# @workspace/instrument

Decorator-like logging utilities for TypeScript/JavaScript to log function parameters and return values.

## Features

- Function wrapper `logCall(fn, options)`
- Method decorator `@LogMethod()`
- Class decorator `@LogAll()` to instrument all methods
- Handles sync and async functions
- Emits structured log units (LogUnit) with dictionary-based `payload.args` & `payload.vars` for direct name access (e.g. `args.userId`).

## Install

In this monorepo, consumers use it via workspace dependency. Externally:

```
npm install @workspace/instrument
```

## Usage

```ts
import { logCall, LogMethod, LogAll } from '@workspace/instrument';

const add = (a: number, b: number) => a + b;
const loggedAdd = logCall(add, { label: 'add' });
console.log(loggedAdd(1, 2));

@LogAll()
class Service {
  greet(name: string) { return `Hello ${name}`; }
}

const s = new Service();
s.greet('world');
```

## LogUnit Structure

When instrumentation captures a call, it constructs a `LogUnit`:

```ts
interface LogUnit {
  tagId: string;            // label for the call (function/class.method)
  timestamp: number;        // start time (ms epoch)
  session?: string;         // optional session correlation id
  project?: string;         // optional project label
  payload: {
    args?: Record<string, any>;                    // argument values keyed by parameter name (or arg{index})
    thisArg?: any;                                 // serialized `this` when includeThis enabled
    vars?: Record<string, { value: any; at: string }>; // inline logged variables via logVar/logVars
    return?: any;                                  // return value if logReturn enabled
    error?: string;                                // stack or message on exception
    end?: number;                                  // end timestamp (ms epoch)
    durationMs?: number;                           // elapsed time
  };
}
```

### Access Patterns

Because `args` & `vars` are dictionaries:

```ts
unit.payload.args?.userId; // direct by name
unit.payload.vars?.context?.value; // variable details
```

### Migration Notes

Earlier versions stored `args` as an array of `{ name, value }` and `vars` as an array. Existing persisted data can be normalized externally by converting arrays to dictionaries keyed by `name || 'arg{index}'`. This package no longer emits the old array shape.

## Mocking Return Values

You can force instrumented calls to return a fixed (or computed) value without invoking the original implementation using the `mockReturn` option. This works uniformly across `logCall`, `@LogMethod`, `@LogAll`, and `instrument()`.

### Static Mock

```ts
import { logCall } from '@workspace/instrument';

const realAdd = (a: number, b: number) => { throw new Error('Should not run'); };
const mockedAdd = logCall(realAdd, { label: 'add', mockReturn: 42, logReturn: true });
mockedAdd(1, 2); // returns 42
```

### Factory Function Mock

Provide a factory to generate the mocked value based on args/this/label/original.

```ts
class Api {
  @LogMethod({ mockReturn: ({ args }) => ({ status: 'fake', sum: args[0] + args[1] }), logReturn: true })
  compute(x: number, y: number) { return x + y; } // original never called
}
```

### Type Signature

```ts
mockReturn?: any | ((ctx: { args: any[]; thisArg: any; label: string; original: Function }) => any | Promise<any>);
```

- If `mockReturn` is defined, the original function/method body is skipped.
- If the factory returns a Promise, it's awaited transparently.
- The logged `payload.return` (when `logReturn: true`) contains the mocked value.
- A `payload.mocked: true` flag is added to emitted `LogUnit` objects for decorated methods (and other instrumentation forms) to indicate the result was mocked.

### Use Cases

- Deterministic testing without hitting real implementations
- Stubbing expensive or side-effectful methods while still collecting timing + arg logs
- Feature flagging / partial rollouts by conditionally supplying `mockReturn` at runtime

### Conditional Mocking

You can decide at runtime whether to mock by returning the real implementation conditionally in your factory:

```ts
@LogMethod({
  mockReturn: ({ args, original }) => {
    const [mode] = args;
    if (mode === 'real') return original(...args); // fall through to real logic
    return { mode, mocked: true };
  },
  logReturn: true,
})
run(mode: string) { return { mode, mocked: false }; }
```

Note: If you intentionally call `original(...args)` inside the factory, that invocation won't be double-instrumented; you're manually delegating.

## Session Replay (Override Logged Values)

You can override the logged argument/variable/return data for a session using previously captured `LogUnit`s without altering actual execution. This lets you "replay" a prior run while still running current code (useful for diffing behavior, privacy redaction scenarios, or deterministic evaluation while exercising real side effects).

### How It Works

1. Start a session: `startInstrumentSession(project, sessionId)`.
2. Call `setInstrumentSessionReplay(units)` providing an array of historical `LogUnit` objects.
3. For each emitted unit during this session, if a replay unit exists for the same `tagId`, the logged `payload.args`, `payload.vars`, and `payload.return` are replaced by values from the replay unit (sequentially if multiple).
4. The actual function/method still executes; its real return value is not changed (only the logged one). A flag `payload.replayed: true` is added.

### Example

```ts
import { startInstrumentSession, setInstrumentSessionReplay, LogMethod } from '@workspace/instrument';

// Previously captured units
const previous: LogUnit[] = [
  { tagId: 'Service.compute', timestamp: 0, payload: { args: { a: 1, b: 2 }, return: 3 } },
  { tagId: 'Service.compute', timestamp: 0, payload: { args: { a: 10, b: 20 }, return: 30 } },
];

startInstrumentSession('proj', 'sess');
setInstrumentSessionReplay(previous);

class Service {
  @LogMethod({ logReturn: true })
  compute(a: number, b: number) { return a + b; }
}

const s = new Service();
s.compute(100, 200); // real return 300; logged args/return show first replay (a:1,b:2, return:3)
s.compute(5, 7);     // real return 12; logged args/return show second replay (a:10,b:20, return:30)
```

### Inspecting Units

Replay-modified units include:

```ts
unit.payload.replayed === true;
```

### Notes

- If more calls occur than replay units, the last replay unit is reused.
- Missing fields in replay unit (`args`, `vars`, or `return`) fall back to original logged value.
- Replay does not affect `thisArg`, timing, errors, or the actual runtime result returned to callers.
- Combine with `mockReturn` if you also wish to alter execution result.

### Auto Replay on Session Start

`startInstrumentSession(project, sessionId, endpoint, autoReplay=true)` will attempt a non-blocking fetch of existing data for that project/session (if an `endpoint` is provided) and automatically enable replay with any retrieved units. Disable by passing `autoReplay=false`.

```ts
// Auto replay enabled (default): existing units pulled from datalake
startInstrumentSession('proj', 'sess-123', 'http://localhost:3300', true);

// Disable auto replay
startInstrumentSession('proj', 'sess-123', 'http://localhost:3300', false);

// Clear replay state manually
clearInstrumentSessionReplay();
```

Auto replay only overrides logged payload; it never mutates function execution.

