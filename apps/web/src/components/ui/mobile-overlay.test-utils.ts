import { vi } from "vitest";

import { MOBILE_OVERLAY_QUERY } from "@/components/ui/mobile-overlay";

export function mockMobileOverlayMatch(matches = true) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === MOBILE_OVERLAY_QUERY ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

export function resetMobileOverlayTestEnvironment() {
  document.body.removeAttribute("data-mobile-overlay-open");
  Reflect.deleteProperty(window, "matchMedia");
}
