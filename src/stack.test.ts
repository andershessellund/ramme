import { describe, it, expect } from 'vitest';
import { Stack } from './stack.js';
import type { NodeImpl } from './node-impl.js';
import type { Entry } from './stack.js';
import { AlreadyOwnedError } from './resource.js';
import { gcUntil, hasGc } from './test/util.js';

function input(target: object, name = 'e'): Omit<Entry, 'prev' | 'next' | 'stack'> {
  return { target, name, node: undefined, dispose: () => {}, state: 'live', done: undefined, failure: undefined, early: false };
}

/** What the owner does at the end of a release: mark released, then unlink. */
function finish(e: Entry): void {
  e.state = 'released';
  e.stack.unlink(e);
}

function names(it: Iterable<Entry>): string[] {
  return [...it].map((e) => e.name);
}

describe('Stack', () => {
  it('push/find by identity; the entry knows its stack', () => {
    const s = new Stack('explicit');
    const a = {};
    const b = {};
    const ea = s.push(input(a, 'a'));
    expect(s.kind).toBe('explicit');
    expect(ea.stack).toBe(s);
    expect(ea.target).toBe(a);
    expect(s.find(a)).toBe(ea);
    expect(s.find(b)).toBeUndefined();
    expect(s.find({})).toBeUndefined();
    expect(s.size).toBe(1);
    const eb = s.push(input(b, 'b'));
    expect(s.find(b)).toBe(eb);
    expect(s.size).toBe(2);
  });

  it('an empty stack has nothing pending', () => {
    const s = new Stack('provided');
    expect(s.size).toBe(0);
    expect(s.topPending()).toBeUndefined();
    expect(s.hasPending()).toBe(false);
    expect(s.snapshotTopDown()).toEqual([]);
    expect([...s]).toEqual([]);
  });

  it('topPending is LIFO', () => {
    const s = new Stack('explicit');
    s.push(input({}, 'a'));
    s.push(input({}, 'b'));
    s.push(input({}, 'c'));
    const order: string[] = [];
    while (s.hasPending()) {
      const e = s.topPending()!;
      order.push(e.name);
      finish(e);
    }
    expect(order).toEqual(['c', 'b', 'a']);
    expect(s.size).toBe(0);
  });

  it('an entry pushed during the release loop is the next topPending (DESIGN.md §2.4)', () => {
    const s = new Stack('provided');
    s.push(input({}, 'a'));
    s.push(input({}, 'b'));
    s.push(input({}, 'c'));
    const order: string[] = [];
    while (s.hasPending()) {
      const e = s.topPending()!;
      order.push(e.name);
      if (e.name === 'b') s.push(input({}, 'pushed-during-b'));
      finish(e);
    }
    expect(order).toEqual(['c', 'b', 'pushed-during-b', 'a']);
  });

  it("a 'releasing' entry is still returned by topPending (the loop waits on it)", () => {
    const s = new Stack('explicit');
    s.push(input({}, 'a'));
    const b = s.push(input({}, 'b'));
    b.state = 'releasing';
    expect(s.topPending()).toBe(b);
    expect(s.hasPending()).toBe(true);
    expect(s.find(b.target)).toBe(b);
    expect(s.size).toBe(2);
    expect(s.snapshotTopDown().map((e) => e.name)).toEqual(['b', 'a']);
  });

  it("a 'released' entry that is still linked is skipped by topPending, find and snapshotTopDown", () => {
    const s = new Stack('explicit');
    const a = s.push(input({}, 'a'));
    const b = s.push(input({}, 'b'));
    b.state = 'released';
    expect(s.topPending()).toBe(a);
    expect(s.find(b.target)).toBeUndefined();
    expect(s.snapshotTopDown()).toEqual([a]);
    a.state = 'released';
    expect(s.hasPending()).toBe(false);
  });

  it("topPendingNode passes passive and 'released' entries and returns a 'releasing' node entry (DESIGN.md §2.4)", () => {
    const s = new Stack('explicit');
    const node = (name: string): Entry => s.push({ ...input({}, name), node: {} as unknown as NodeImpl });
    expect(s.topPendingNode()).toBeUndefined();
    const n1 = node('n1');
    s.push(input({}, 'passive-1'));
    const n2 = node('n2');
    s.push(input({}, 'passive-2'));
    expect(s.topPending()?.name).toBe('passive-2'); // the plain loop still takes the top
    expect(s.topPendingNode()).toBe(n2);
    n2.state = 'releasing';
    expect(s.topPendingNode()).toBe(n2); // the loop waits on it
    n2.state = 'released';
    expect(s.topPendingNode()).toBe(n1);
    finish(n1);
    expect(s.topPendingNode()).toBeUndefined();
    expect(s.hasPending()).toBe(true); // passive entries remain
  });

  it('a duplicate target throws AlreadyOwnedError; after unlink the target can be pushed again', () => {
    const s = new Stack('explicit');
    const x = {};
    const e = s.push(input(x, 'x'));
    expect(() => s.push(input(x, 'x'))).toThrow(AlreadyOwnedError);
    expect(() => s.push(input(x, 'x'))).toThrow(/already owned/);
    expect(s.size).toBe(1);
    finish(e);
    const again = s.push(input(x, 'x'));
    expect(again).not.toBe(e);
    expect(s.find(x)).toBe(again);
  });

  it("a target pushed again while its old entry is 'released' but linked: both stay removable", () => {
    for (const order of ['old first', 'new first'] as const) {
      const s = new Stack('explicit');
      const x = {};
      const a = s.push(input({}, 'a'));
      const e1 = s.push(input(x, 'e1'));
      e1.state = 'released'; // marked, not yet unlinked
      const e2 = s.push(input(x, 'e2'));
      expect(s.find(x)).toBe(e2);
      expect(s.size).toBe(3);
      expect(names(s)).toEqual(['a', 'e1', 'e2']);
      if (order === 'old first') {
        s.unlink(e1);
        expect(s.find(x)).toBe(e2);
        expect(names(s)).toEqual(['a', 'e2']);
        finish(e2);
      } else {
        finish(e2);
        expect(s.find(x)).toBeUndefined();
        expect(names(s)).toEqual(['a', 'e1']);
        s.unlink(e1);
      }
      expect(s.size).toBe(1);
      expect(names(s)).toEqual(['a']);
      expect(s.find(x)).toBeUndefined();
      expect([e1.prev, e1.next, e2.prev, e2.next]).toEqual([undefined, undefined, undefined, undefined]);
      expect(a.next).toBeUndefined();
      finish(a);
      expect(s.size).toBe(0);
    }
  });

  it('unlink is physical: the data structure retains nothing', () => {
    const s = new Stack('explicit');
    for (let i = 0; i < 10_000; i++) {
      const target = { i };
      const e = s.push(input(target, `e${i}`));
      expect(s.find(target)).toBe(e);
      finish(e);
      expect(s.find(target)).toBeUndefined();
      expect(e.prev).toBeUndefined();
      expect(e.next).toBeUndefined();
    }
    expect(s.size).toBe(0);
    expect(s.hasPending()).toBe(false);
    expect([...s]).toEqual([]);
  });

  // `find` skips 'released' entries, so the checks above cannot see the identity index: only a collection can.
  it.skipIf(!hasGc)('after unlink the stack retains neither the target nor the entry, the index included', async () => {
    const s = new Stack('explicit');
    const keep = s.push(input({}, 'keep')); // the stack stays alive and non-empty throughout
    const refs = ((): WeakRef<object>[] => {
      const out: WeakRef<object>[] = [];
      for (let i = 0; i < 100; i++) {
        const target = { i };
        const e = s.push(input(target, `e${i}`));
        finish(e);
        out.push(new WeakRef(target), new WeakRef(e), new WeakRef(e.dispose));
      }
      // A target pushed again while its old entry is 'released' but linked; the index slot changes hands.
      for (const order of ['old first', 'new first'] as const) {
        const x = {};
        const e1 = s.push(input(x, 'e1'));
        e1.state = 'released';
        const e2 = s.push(input(x, 'e2'));
        if (order === 'old first') {
          s.unlink(e1);
          finish(e2);
        } else {
          finish(e2);
          s.unlink(e1);
        }
        out.push(new WeakRef(x), new WeakRef(e1), new WeakRef(e2));
      }
      return out;
    })();
    await gcUntil(() => refs.every((r) => r.deref() === undefined));
    expect(s.size).toBe(1);
    expect(s.topPending()).toBe(keep);
  });

  it('unlinking a middle entry leaves the others in order (I5); unlink is idempotent', () => {
    const s = new Stack('explicit');
    const a = s.push(input({}, 'a'));
    const b = s.push(input({}, 'b'));
    const c = s.push(input({}, 'c'));
    finish(b);
    expect(names(s)).toEqual(['a', 'c']);
    expect(s.snapshotTopDown()).toEqual([c, a]);
    expect(a.next).toBe(c);
    expect(c.prev).toBe(a);
    expect(b.prev).toBeUndefined();
    expect(b.next).toBeUndefined();
    s.unlink(b);
    expect(s.size).toBe(2);
    finish(a);
    expect(names(s)).toEqual(['c']);
    expect(c.prev).toBeUndefined();
    finish(c);
    expect(s.size).toBe(0);
    s.unlink(c);
    expect(s.size).toBe(0);
  });

  it('moveToTail moves a head or middle entry to the tail, keeps its identity, and is a no-op on the tail or a foreign entry (DESIGN.md §3.3)', () => {
    const s = new Stack('provided');
    const ta = {};
    const a = s.push(input(ta, 'a'));
    const b = s.push(input({}, 'b'));
    const c = s.push(input({}, 'c'));
    s.moveToTail(a); // the head
    expect(names(s)).toEqual(['b', 'c', 'a']);
    expect(s.snapshotTopDown()).toEqual([a, c, b]);
    expect([b.prev, c.next, a.prev, a.next]).toEqual([undefined, a, c, undefined]);
    expect(s.find(ta)).toBe(a);
    s.moveToTail(c); // a middle entry
    expect(names(s)).toEqual(['b', 'a', 'c']);
    s.moveToTail(c); // the tail
    expect(names(s)).toEqual(['b', 'a', 'c']);
    const other = new Stack('provided');
    const x = other.push(input({}, 'x'));
    const y = other.push(input({}, 'y'));
    // Not linked here. `y` is not the other stack's head, so its links alone would look linked: the
    // membership check must be this stack's.
    s.moveToTail(y);
    s.moveToTail(x);
    expect(names(s)).toEqual(['b', 'a', 'c']);
    expect(s.size).toBe(3);
    expect(names(other)).toEqual(['x', 'y']);
    expect(other.size).toBe(2);
    expect([y.prev, x.next, y.next]).toEqual([x, y, undefined]);
    expect(other.topPending()).toBe(y);
    finish(a);
    s.moveToTail(a); // unlinked
    expect(names(s)).toEqual(['b', 'c']);
    expect(s.size).toBe(2);
    const order: string[] = [];
    while (s.hasPending()) {
      const e = s.topPending()!;
      order.push(e.name);
      finish(e);
    }
    expect(order).toEqual(['c', 'b']);
  });

  it('unlink of an entry from another stack is a no-op', () => {
    const s1 = new Stack('explicit');
    const s2 = new Stack('provided');
    const x = {};
    const x1 = s1.push(input(x, 'x1'));
    const y = s2.push(input({}, 'y'));
    const e2 = s2.push(input(x, 'x2')); // not s2's head: its own links say "linked", so only the stack check refuses it
    s1.unlink(e2);
    s1.unlink(y); // s2's head
    expect(s1.size).toBe(1);
    expect(s1.topPending()).toBe(x1);
    expect(s1.find(x)).toBe(x1);
    expect(names(s1)).toEqual(['x1']);
    expect(s2.size).toBe(2);
    expect(names(s2)).toEqual(['y', 'x2']);
    expect(s2.find(x)).toBe(e2);
    expect(s2.topPending()).toBe(e2);
    expect([y.next, e2.prev]).toEqual([e2, y]);
  });

  it('iterates head → tail; snapshotTopDown is tail → head', () => {
    const s = new Stack('provided');
    for (const n of ['a', 'b', 'c', 'd']) s.push(input({}, n));
    expect(names(s)).toEqual(['a', 'b', 'c', 'd']);
    expect(s.snapshotTopDown().map((e) => e.name)).toEqual(['d', 'c', 'b', 'a']);
  });

  it('iteration survives unlinking the yielded entry and visits entries pushed meanwhile', () => {
    const s = new Stack('explicit');
    for (const n of ['a', 'b', 'c']) s.push(input({}, n));
    const seen: string[] = [];
    for (const e of s) {
      seen.push(e.name);
      if (e.name === 'b') finish(e);
      if (e.name === 'c') s.push(input({}, 'd'));
    }
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(names(s)).toEqual(['a', 'c', 'd']);
  });

  it('iteration visits an entry pushed while the yielded tail is unlinked, in either order', () => {
    for (const order of ['push, then unlink', 'unlink, then push'] as const) {
      for (const initial of [['a', 'b'], ['b']]) {
        const s = new Stack('explicit');
        for (const n of initial) s.push(input({}, n));
        const seen: string[] = [];
        for (const e of s) {
          seen.push(e.name);
          if (e.name !== 'b') continue;
          if (order === 'push, then unlink') {
            s.push(input({}, 'c'));
            finish(e);
          } else {
            finish(e);
            s.push(input({}, 'c'));
          }
        }
        expect(seen).toEqual([...initial, 'c']);
        expect(names(s)).toEqual([...initial.filter((n) => n !== 'b'), 'c']);
      }
    }
  });

  it('the snapshot is not affected by later pushes or unlinks', () => {
    const s = new Stack('explicit');
    const a = s.push(input({}, 'a'));
    s.push(input({}, 'b'));
    const snap = s.snapshotTopDown();
    s.push(input({}, 'c'));
    finish(a);
    expect(snap.map((e) => e.name)).toEqual(['b', 'a']);
  });
});
