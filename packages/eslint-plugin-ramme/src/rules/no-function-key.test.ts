// The pins of no-function-key (stage 6a, decision 10; the `style` preset), written before the rule: a function key is
// accepted (DESIGN.md §3.1) but is not the ramme style, which keys a service by its class, or by a token
// (`createInjectionKey`), or by `createKeyFor` over a class. Reported: `lookup`, `inject`, `createKeyFor`,
// `valueProvider`, `factoryProvider`, `classProvider`, `aliasProvider` or `setScope` given, as the key, an identifier
// that resolves in this file to a function declaration or a `const` initialised with an arrow or a function
// expression, not a class. A function given as a provider's value is a value, not a key.
import { assertionOptions, ruleTester } from '../test/rule-tester.js';
import { noFunctionKey } from './no-function-key.js';

/** The rule's message, as the specification words it; a rule may go on after it (a reference). */
const message = /^a function key is accepted but not the ramme style; use a class or createInjectionKey/;

const imports =
  "import { NodeTopic, aliasProvider, classProvider, createInjectionKey, createKeyFor, factoryProvider, inject, lookup, setScope, valueProvider } from 'ramme';\n";

ruleTester.run('no-function-key', noFunctionKey, {
  assertionOptions,
  valid: [
    { name: 'a class key', code: `${imports}class Clock {}\nexport const read = () => lookup(Clock);` },
    { name: 'a class expression', code: `${imports}const Clock = class {};\nexport class Svc { readonly clock = inject(Clock); }` },
    { name: 'a token', code: `${imports}const Port = createInjectionKey<number>('Port');\nexport const read = () => lookup(Port);` },
    { name: 'createKeyFor over a class', code: `${imports}class SystemClock {}\nexport const ClockKey = createKeyFor(SystemClock);` },
    { name: 'classProvider of a class', code: `${imports}class Impl {}\nexport const p = classProvider(Impl);` },
    {
      name: 'an import: this file does not show it is a function',
      code: `${imports}import { makeConfig } from './config';\nexport const read = () => lookup(makeConfig);`,
    },
    { name: 'a parameter', code: `${imports}export function read<T>(key: () => T) { return lookup(key); }` },
    {
      name: 'a function as a provider’s value is a value, not a key',
      code: `${imports}const log = (e: unknown) => void e;\nexport const p = valueProvider(NodeTopic, log);`,
    },
    { name: 'a function called, not used as a key', code: `${imports}function makeConfig() { return {}; }\nexport const c = makeConfig();` },
    // Beyond the pins (the plugin README): a call through a name of Object.prototype's is no key verb, and a `let`
    // may hold anything by the time it is used.
    { name: 'a method named like an object’s own', code: `${imports}function f() { return 1; }\nexport const s = f.toString() + String(f.valueOf());` },
    { name: 'a let, which may be reassigned', code: `${imports}let make = () => ({});\nmake = () => ({ x: 1 });\nexport const read = () => lookup(make);` },
  ],
  invalid: [
    {
      name: 'lookup of a function declaration',
      code: `${imports}function makeConfig() { return {}; }\nexport const read = () => lookup(makeConfig);`,
      errors: [{ message, line: 3 }],
    },
    {
      name: 'inject of an arrow const',
      code: `${imports}const clock = () => Date.now();\nexport class Svc { readonly clock = inject(clock); }`,
      errors: [{ message, line: 3 }],
    },
    {
      name: 'createKeyFor of a function-expression const',
      code: `${imports}const makeClock = function () { return { now: () => 0 }; };\nexport const ClockKey = createKeyFor(makeClock);`,
      errors: [{ message, line: 3 }],
    },
    {
      name: 'each provider helper and setScope, given a function key',
      code: `${imports}declare const Impl: new () => object;\ndeclare const Other: new () => object;\ndeclare const SessionScope: { readonly name: string };\nfunction makeConfig() { return {}; }\nvalueProvider(makeConfig, {});\nfactoryProvider(makeConfig, () => ({}));\nclassProvider(makeConfig, Impl);\naliasProvider(makeConfig, Other);\nsetScope(makeConfig, SessionScope);`,
      errors: [6, 7, 8, 9, 10].map((line) => ({ message, line })),
    },
    {
      name: 'an alias’s target is a key too',
      code: `${imports}class Cache {}\nconst makeCache = () => new Cache();\naliasProvider(Cache, makeCache);`,
      errors: [{ message, line: 4, column: 22 }],
    },
  ],
});
