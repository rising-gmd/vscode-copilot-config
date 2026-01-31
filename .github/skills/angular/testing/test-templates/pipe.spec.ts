import { TruncatePipe } from '../../component-patterns/examples/pipe-template';

describe('TruncatePipe', () => {
  it('truncates long strings', () => {
    const p = new TruncatePipe();
    expect(p.transform('abcdefghijklmnopqrstuvwxyz', 5)).toContain('...');
  });
});
