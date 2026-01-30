/**
 * Router lazy-loading example (routes)
 */
import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: 'feature', loadComponent: () => import('./feature/feature.component').then(m => m.FeatureComponent) }
];
