/**
 * Simple pure pipe example
 */
import { Pipe, PipeTransform } from '@angular/core';

@Pipe({ name: 'truncate', pure: true })
export class TruncatePipe implements PipeTransform {
  transform(value: string, length = 50) { return value.length > length ? value.slice(0, length) + '...' : value; }
}
