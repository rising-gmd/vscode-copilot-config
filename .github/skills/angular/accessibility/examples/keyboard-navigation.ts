/**
 * Keyboard navigation helper sample
 */
import { Directive, HostListener } from '@angular/core';

@Directive({ selector: '[appEnterActivate]' })
export class EnterActivateDirective {
  @HostListener('keydown.enter') onEnter() { /* trigger action */ }
}
