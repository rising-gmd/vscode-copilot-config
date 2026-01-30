/**
 * Simple directive template
 */
import { Directive, ElementRef, HostListener } from '@angular/core';

@Directive({ selector: '[appFocusHighlight]' })
export class FocusHighlightDirective {
  constructor(private el: ElementRef<HTMLElement>) {}
  @HostListener('focus') onFocus() { this.el.nativeElement.classList.add('focus'); }
  @HostListener('blur') onBlur() { this.el.nativeElement.classList.remove('focus'); }
}
