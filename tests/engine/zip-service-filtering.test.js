import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { readZipArchive } from "../../src/services/zipService.js";

describe("ZIP source filtering and cap accounting", () => {
  it("counts every eligible source file omitted by the cap", async () => {
    const entries = {
      "repo/package.json": strToU8('{"name":"fixture"}'),
      "repo/README.md": strToU8("fixture repository"),
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `repo/src/file-${index}.js`,
          strToU8(`export const value${index} = ${index};`)
        ])
      )
    };
    const bytes = zipSync(entries);
    const file = {
      name: "fixture.zip",
      size: bytes.byteLength,
      arrayBuffer: async () => bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      )
    };

    const result = await readZipArchive(file, { maxFiles: 2 });

    expect(result.files).toHaveLength(2);
    expect(result.candidateCount).toBe(5);
    expect(result.capApplied).toBe(true);
    expect(result.skippedByReason["file-cap"]).toBe(3);
    expect(result.skippedByReason["unsupported-extension"]).toBe(2);
    expect(result.skippedCount).toBe(5);
  });
});
