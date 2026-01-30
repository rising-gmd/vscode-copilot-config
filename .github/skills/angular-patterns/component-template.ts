import { Component, OnInit, OnDestroy, ChangeDetectionStrategy } from '@angular/core';
import { Subject } from 'rxjs';

/**
 * Example component template following project conventions.
 */
@Component({
  selector: 'app-sample',
  templateUrl: './sample.component.html',
  styleUrls: ['./sample.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SampleComponent implements OnInit, OnDestroy {
  private readonly destroy$ = new Subject<void>();

  constructor() {}

  ngOnInit(): void {
    // initialization logic
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }
}
