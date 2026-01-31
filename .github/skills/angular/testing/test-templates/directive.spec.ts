import { TestBed } from '@angular/core/testing';
import { FocusHighlightDirective } from '../../component-patterns/examples/directive-template';

describe('FocusHighlightDirective', () => {
  beforeEach(() => TestBed.configureTestingModule({ declarations: [FocusHighlightDirective] }));
  it('directive exists', () => expect(FocusHighlightDirective).toBeDefined());
});
