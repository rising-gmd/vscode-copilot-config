/**
 * Pure pipe used for expensive calculations
 */
import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'expensive', pure: true })
export class ExpensivePipe implements PipeTransform {
  transform(value: number[]): number { return value.reduce((s, v) => s + v, 0); }
}
