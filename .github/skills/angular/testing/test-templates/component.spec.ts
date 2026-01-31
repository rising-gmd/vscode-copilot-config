import { TestBed } from '@angular/core/testing';
import { ExampleComponent } from '../../component-patterns/examples/component-template';

describe('ExampleComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ExampleComponent] }).compileComponents();
  });

  it('creates', () => {
    const fixture = TestBed.createComponent(ExampleComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
