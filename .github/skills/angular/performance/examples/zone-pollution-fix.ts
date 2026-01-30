/**
 * Example of removing zone pollution by using runOutsideAngular
 */
import { Component, NgZone } from '@angular/core';

@Component({ selector: 'zone-fix', standalone: true, template: `<div>{{counter}}</div>` })
export class ZoneFixComponent {
  counter = 0;
  constructor(private readonly ngZone: NgZone) {}
  ngOnInit() {
    this.ngZone.runOutsideAngular(() => setInterval(() => this.counter++, 1000));
  }
}
