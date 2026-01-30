/**
 * Component template example (standalone + OnPush + signals)
 */
import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'example-component',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div>
      <h3>{{ title }}</h3>
      <p>{{ counter() }}</p>
      <button (click)="increment()">Inc</button>
    </div>
  `,
  changeDetection: 0
})
export class ExampleComponent {
  protected readonly title = 'Example';
  readonly counter = signal(0);
  increment() { this.counter.update(v => v + 1); }
}
