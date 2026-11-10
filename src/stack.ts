// ---------------------------------------------------------------------------
// Stack — one of a node's two stacks (DESIGN.md §2.1, §2.4; I5).
//
// A doubly linked list with an identity index. Positions never move: an
// entry is appended at the tail and physically unlinked when its release
// ends, so nothing is retained after unlink. There is no cursor: the release loop asks for `topPending()`
// afresh on every step, so an entry pushed during release is the new tail
// and is released next (DESIGN.md §2.4).
// ---------------------------------------------------------------------------

import type { FailureRecord } from './internal-context.js';
import type { NodeImpl } from './node-impl.js';
import { AlreadyOwnedError } from './resource.js';

export type EntryState = 'live' | 'releasing' | 'released';

export interface Entry {
  /** Identity for `release(x)`; for a node entry, the node itself. */
  readonly target: object;
  readonly name: string;
  /** Set for node entries. */
  readonly node: NodeImpl | undefined;
  /** Passive entries; node entries use the release loop's node path. Its result is the release fiber's body result (DESIGN.md §4.5). */
  readonly dispose: () => unknown;
  state: EntryState;
  /**
   * Created when the release starts, before any dispose code runs; settles
   * (never rejects) when it ends. Defined whenever `state !== 'live'` (D16).
   */
  done: Promise<void> | undefined;
  /** The release's own error when it threw; for an early release also in `owner.unconsumed` until delivered (D16). */
  failure: FailureRecord | undefined;
  /** The release was started by `release(x)`/`releaseAll()`, not by the owner's loop. */
  early: boolean;
  /** Maintained by the stack; cleared at `unlink` so a released entry retains no neighbour. */
  prev: Entry | undefined;
  next: Entry | undefined;
  readonly stack: Stack;
}

export class Stack {
  #head: Entry | undefined = undefined;
  #tail: Entry | undefined = undefined;
  #count = 0;
  /** Created on the first push: an empty stack is two pointers. */
  #index: Map<object, Entry> | undefined = undefined;

  constructor(readonly kind: 'explicit' | 'provided') {}

  /** Linked entries: live and releasing ones. An entry leaves at `unlink`, which its owner performs as it marks it released. */
  get size(): number {
    return this.#count;
  }

  /**
   * Append at the tail. Throws `AlreadyOwnedError` if `target` is already on
   * this stack; an entry marked `'released'` but not yet unlinked does not
   * count, and stays removable by `unlink`.
   */
  push(e: Omit<Entry, 'prev' | 'next' | 'stack'>): Entry {
    if (this.find(e.target) !== undefined)
      throw new AlreadyOwnedError(`${e.name} is already owned on this ${this.kind} stack`);
    const entry: Entry = { ...e, prev: this.#tail, next: undefined, stack: this };
    if (this.#tail === undefined) this.#head = entry;
    else this.#tail.next = entry;
    this.#tail = entry;
    this.#count++;
    (this.#index ??= new Map()).set(entry.target, entry);
    return entry;
  }

  /** The linked entry for `target`, by identity; released entries are absent. */
  find(target: object): Entry | undefined {
    const e = this.#index?.get(target);
    return e !== undefined && e.state !== 'released' ? e : undefined;
  }

  /**
   * Physical removal, so nothing is retained after unlink. Idempotent; neighbours keep their order (I5).
   * Membership is the entry's own links, not the index: a target pushed again
   * while its old entry is `'released'` but still linked owns the index slot,
   * and the old entry must still be removable.
   */
  unlink(e: Entry): void {
    if (!this.#linked(e)) return;
    if (this.#index!.get(e.target) === e) this.#index!.delete(e.target);
    if (e.prev === undefined) this.#head = e.next;
    else e.prev.next = e.next;
    if (e.next === undefined) this.#tail = e.prev;
    else e.next.prev = e.prev;
    e.prev = undefined;
    e.next = undefined;
    this.#count--;
  }

  /**
   * Move a linked entry to the tail, keeping the entry object and its index slot (G3, I5; DESIGN.md §3.3): a declared
   * value's node, live on its storage context's provided stack from its first touch, takes its place
   * after the dependencies its factory created. A no-op for an entry that is not linked here, and for
   * the tail. Not called while the stack is being iterated.
   */
  moveToTail(e: Entry): void {
    if (!this.#linked(e) || this.#tail === e) return;
    const next = e.next!; // not the tail
    if (e.prev === undefined) this.#head = next;
    else e.prev.next = next;
    next.prev = e.prev;
    e.prev = this.#tail;
    e.next = undefined;
    this.#tail!.next = e;
    this.#tail = e;
  }

  /** Linked here: every linked entry but the head has a `prev`, and `unlink` clears it. */
  #linked(e: Entry): boolean {
    return e.stack === this && (e.prev !== undefined || this.#head === e);
  }

  /** From the tail: the first entry whose state is not `'released'`. A `'releasing'` entry is returned; the loop waits on its `done`. */
  topPending(): Entry | undefined {
    let e = this.#tail;
    while (e !== undefined && e.state === 'released') e = e.prev;
    return e;
  }

  hasPending(): boolean {
    return this.topPending() !== undefined;
  }

  /**
   * From the tail: the first node entry whose state is not `'released'`, passing passive entries. What the
   * release loop takes while a failure handler still holds the owner (DESIGN.md §2.4).
   */
  topPendingNode(): Entry | undefined {
    let e = this.#tail;
    while (e !== undefined && (e.state === 'released' || e.node === undefined)) e = e.prev;
    return e;
  }

  /**
   * Head → tail. Entries pushed while iterating are visited; the yielded
   * entry may be unlinked while iterating, others may not (use
   * `snapshotTopDown()` for that). Both may happen in one step.
   */
  *[Symbol.iterator](): IterableIterator<Entry> {
    let e = this.#head;
    while (e !== undefined) {
      const prev = e.prev;
      const next = e.next;
      yield e;
      if (this.#linked(e)) e = e.next; // read afresh: a push during the yield may have appended after the tail
      else if (next !== undefined) e = next; // still linked, and anything pushed meanwhile lies after it
      else e = prev !== undefined ? prev.next : this.#head; // `e` was the tail: what follows its old predecessor was pushed meanwhile
    }
  }

  /** Tail → head, as an array, without `'released'` entries; for `releaseAll()`. */
  snapshotTopDown(): Entry[] {
    const out: Entry[] = [];
    for (let e = this.#tail; e !== undefined; e = e.prev) if (e.state !== 'released') out.push(e);
    return out;
  }
}
