/**
 * XSRF setup example for HttpClient (provider snippet)
 */
import { provideHttpClient, withXsrf } from '@angular/common/http';

export const httpProviders = [ provideHttpClient(withXsrf({ cookieName: 'XSRF-TOKEN', headerName: 'X-XSRF-TOKEN' })) ];
