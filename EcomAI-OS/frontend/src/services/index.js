// Service layer entry point.
//
// The UI only ever talks through these modules. Each one has two
// implementations behind the same signature: the deterministic in-browser mock
// store (`mock/`, the default) and the tenant API. `VITE_DATA_MODE` selects
// which one serves a given call, and the pages cannot tell the difference
// because the shapes are the same.
//
// In `api` mode nothing falls back to demo data: a request that fails raises,
// so a page either shows real numbers or shows the error. That is the whole
// point of the toggle.

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

export { DATA_MODE, usingApi } from './api/mode';
export { getDB, subscribe } from './mock/db';
