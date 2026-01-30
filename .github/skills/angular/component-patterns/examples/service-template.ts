/**
 * Service template using inject() and providedIn root
 */
import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class ExampleService {
  private readonly http = inject(HttpClient);

  async fetch<T>(url: string) { return this.http.get<T>(url).toPromise(); }
}
