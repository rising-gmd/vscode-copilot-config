import { ErrorHandler, Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class GlobalErrorHandler implements ErrorHandler {
  handleError(error: unknown) {
    // Send to telemetry here and show friendly UI
    console.error('Unhandled error', error);
  }
}
