// Service layer entry point.
//
// The UI only ever talks through these modules. Today every call is backed by
// the deterministic in-browser mock store (`mock/`), which is scoped per user.
// When the real API is ready, swap the implementation in each module or point
// `USE_REMOTE_API` at the HTTP client — no page needs to change.

export * as authService from './authService';
export * as dashboardService from './dashboardService';
export * as inventoryService from './inventoryService';
export * as productsService from './productsService';
export * as salesService from './salesService';
export * as forecastService from './forecastService';
export * as recommendationService from './recommendationService';
export * as simulationService from './simulationService';
export * as notificationsService from './notificationsService';
export * as settingsService from './settingsService';

export const USE_REMOTE_API = false;

export { getDB, subscribe } from './mock/db';