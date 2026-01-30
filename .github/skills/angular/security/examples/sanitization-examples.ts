/**
 * DomSanitizer usage example
 */
import { Component } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';

@Component({ standalone: true, template: `<div [innerHtml]="trusted"></div>` })
export class SanitizedComponent {
  trusted: SafeHtml;
  constructor(private readonly ds: DomSanitizer) {
    const unsafe = '<b>untrusted</b>';
    this.trusted = this.ds.sanitize(1, unsafe) ?? '';
  }
}
