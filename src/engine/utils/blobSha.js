/**
 * Git-compatible blob hashing utilities.
 *
 * WHY: A source file fetched from GitHub and the same file from a ZIP
 * should use an identical cache key, regardless of where it came from.
 */

/**
 * Calculate a Git blob SHA-1 hash using the standard blob header.
 *
 * @param {string|Uint8Array|ArrayBuffer} input
 * @returns {Promise<string>}
 */
export async function computeGitBlobSha(input) {
  let content;

  if (typeof input === "string") {
    content = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    content = input;
  } else if (input instanceof ArrayBuffer) {
    content = new Uint8Array(input);
  } else {
    throw new TypeError(
      "Blob content must be a string, Uint8Array, or ArrayBuffer."
    );
  }

  if (!globalThis.crypto?.subtle) {
    throw new Error(
      "Secure SHA-1 hashing is unavailable in this browser context. Open Astral Atlas on localhost or HTTPS."
    );
  }

  const header = new TextEncoder().encode(
    `blob ${content.byteLength}\0`
  );

  const payload = new Uint8Array(
    header.byteLength + content.byteLength
  );

  payload.set(header, 0);
  payload.set(content, header.byteLength);

  const digest = await globalThis.crypto.subtle.digest(
    "SHA-1",
    payload
  );

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}