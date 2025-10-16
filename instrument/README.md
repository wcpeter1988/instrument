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
