import { describe, it, expect } from 'vitest';
import { splitRef } from '../web/src/connstr';

describe('splitRef', () => {
  it('splits a normal "nodeId:pin"', () => {
    expect(splitRef('mul1:A')).toEqual(['mul1', 'A']);
  });

  it('splits on the FIRST colon, keeping the remainder as the pin', () => {
    // A plain split(':') destructure would drop ":Pin"; splitRef keeps it whole.
    expect(splitRef('node1:Weird:Pin')).toEqual(['node1', 'Weird:Pin']);
  });

  it('returns an empty pin when there is no colon', () => {
    expect(splitRef('node1')).toEqual(['node1', '']);
  });

  it('handles an empty pin after a trailing colon', () => {
    expect(splitRef('node1:')).toEqual(['node1', '']);
  });
});
