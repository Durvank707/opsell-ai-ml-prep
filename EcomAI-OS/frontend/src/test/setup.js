// Shared setup for the component and service tests.
//
// Several browser APIs the app uses are missing or inert under jsdom, and they
// are stubbed here rather than in each test:
//
//   matchMedia      the layout and chart components read it;
//   ResizeObserver  recharts observes its container, and a missing observer
//                   throws during commit, which takes the whole tree down rather
//                   than failing one assertion;
//   scrollIntoView  the sales page scrolls to the records table after an import.
//
// The chart keeps its zero-size container here, so nothing below asserts
// through pixels: these tests read the DOM the components produce.

import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

if (!window.matchMedia) {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}

    unobserve() {}

    disconnect() {}
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
