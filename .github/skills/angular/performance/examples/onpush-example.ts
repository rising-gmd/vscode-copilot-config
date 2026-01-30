/**
 * Example of OnPush component with trackBy for ngFor
 */
import { Component, signal } from '@angular/core';

@Component({
  selector: 'onpush-list',
  standalone: true,
  template: `
    <div *ngFor="let item of items(); trackBy: trackById">{{item.name}}</div>
  `,
  changeDetection: 0
})
export class OnPushListComponent {
  readonly items = signal([{ id: 1, name: 'A' }, { id: 2, name: 'B' }]);
  trackById(index: number, item: { id: number }) { return item.id; }
}
