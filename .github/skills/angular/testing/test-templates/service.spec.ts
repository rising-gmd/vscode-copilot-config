import { TestBed } from '@angular/core/testing';
import { ExampleService } from '../../component-patterns/examples/service-template';

describe('ExampleService', () => {
  beforeEach(() => TestBed.configureTestingModule({ providers: [ExampleService] }));
  it('instantiates', () => expect(TestBed.inject(ExampleService)).toBeTruthy());
});
