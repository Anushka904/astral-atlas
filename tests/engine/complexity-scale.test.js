import { describe, expect, it } from "vitest";

import {
  COMPLEXITY_THRESHOLDS,
  getComplexityBand,
  countComplexityBands
} from "../../src/engine/ComplexityScale.js";

describe("complexity heatmap scale", () => {
  it("classifies low complexity at the lower and upper boundaries", () => {
    expect(getComplexityBand(1)).toBe("low");
    expect(getComplexityBand(6)).toBe("low");
  });

  it("classifies medium complexity at the lower and upper boundaries", () => {
    expect(getComplexityBand(7)).toBe("medium");
    expect(getComplexityBand(14)).toBe("medium");
  });

  it("classifies high complexity starting at 15", () => {
    expect(getComplexityBand(15)).toBe("high");
    expect(getComplexityBand(40)).toBe("high");
  });

  it("marks failed or invalid metrics as unavailable", () => {
    expect(
      getComplexityBand(1, { parseStatus: "error" })
    ).toBe("unavailable");

    expect(getComplexityBand(0)).toBe("unavailable");
    expect(getComplexityBand(Number.NaN)).toBe("unavailable");
    expect(getComplexityBand(Number.POSITIVE_INFINITY)).toBe(
      "unavailable"
    );
  });

  it("counts measured and unavailable nodes but skips folder clusters", () => {
    const counts = countComplexityBands([
      {
        id: "a.js",
        kind: "file",
        cyclomaticComplexity: 3,
        parseStatus: "ok"
      },
      {
        id: "b.js",
        kind: "file",
        cyclomaticComplexity: 8,
        parseStatus: "ok"
      },
      {
        id: "c.js",
        kind: "file",
        cyclomaticComplexity: 17,
        parseStatus: "ok"
      },
      {
        id: "broken.js",
        kind: "file",
        cyclomaticComplexity: 0,
        parseStatus: "error"
      },
      {
        id: "folder::src",
        kind: "folder",
        cyclomaticComplexity: 100
      }
    ]);

    expect(counts).toEqual({
      low: 1,
      medium: 1,
      high: 1,
      unavailable: 1,
      total: 4,
      measured: 3
    });
  });

  it("returns zero counts for an empty or invalid collection", () => {
    expect(countComplexityBands([])).toEqual({
      low: 0,
      medium: 0,
      high: 0,
      unavailable: 0,
      total: 0,
      measured: 0
    });

    expect(countComplexityBands(null).total).toBe(0);
  });

  it("keeps the documented threshold boundaries stable", () => {
    expect(COMPLEXITY_THRESHOLDS).toEqual({
      lowMaximum: 6,
      mediumMaximum: 14
    });
  });
});