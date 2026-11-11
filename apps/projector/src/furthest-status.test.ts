import { describe, expect, it } from "vitest";
import { furthestStatus } from "./projector.js";

describe("furthestStatus", () => {
  it("is null with no lifecycle events", () => {
    expect(furthestStatus([])).toBeNull();
    expect(furthestStatus(["IntentOpened", "IntentResolved"])).toBeNull();
  });

  it("takes the furthest along, whatever order the events were recorded in", () => {
    expect(furthestStatus(["IntentFinalized", "IntentClaimed"])).toBe("finalized");
    expect(furthestStatus(["IntentClaimed", "IntentChallenged"])).toBe("challenged");
    expect(furthestStatus(["IntentRefunded", "IntentOpened"])).toBe("refunded");
  });
});
