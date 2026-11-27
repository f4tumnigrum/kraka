import { gunzipSync } from "node:zlib";

const block = 512;
const zeros = (bytes: Buffer) => bytes.every((byte) => byte === 0);

function octal(field: Buffer) {
  const digits = field
    .toString("latin1")
    .replace(/[\0 ]+$/, "")
    .trimStart();
  if (!/^[0-7]+$/.test(digits)) throw Error("Invalid tar numeric field");
  return Number.parseInt(digits, 8);
}

// Earlier macOS builds included timestamps and extended attributes in a per-file PAX header.
function checkFileMetadata(data: Buffer) {
  for (let start = 0; start < data.length; ) {
    const space = data.indexOf(32, start);
    if (space < 0) throw Error("Invalid tar metadata");
    const length = data.toString("latin1", start, space);
    const end = start + Number(length);
    const equals = data.indexOf(61, space + 1);
    if (
      !/^[1-9][0-9]*$/.test(length) ||
      end > data.length ||
      equals <= space ||
      equals >= end - 1 ||
      data[end - 1] !== 10
    )
      throw Error("Invalid tar metadata");
    const key = data.toString("latin1", space + 1, equals);
    if (!/^(?:[amc]time|(?:LIBARCHIVE|SCHILY)\.xattr\..+)$/.test(key))
      throw Error("Unexpected tar metadata");
    start = end;
  }
}

/** Read the one program from a release tar.gz. Archive paths are never used for filesystem writes. */
export function releaseExecutable(compressed: Buffer, name: string, size: number) {
  // Allow tar headers, optional macOS metadata and the writer's final block padding.
  const tar = gunzipSync(compressed, { maxOutputLength: size + compressed.length + 10240 });
  let executable: Buffer | undefined;
  let offset = 0;
  let appleDouble = false;
  while (offset + block <= tar.length) {
    const header = tar.subarray(offset, offset + block);
    if (zeros(header)) break;
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (octal(header.subarray(148, 156)) !== checksum) throw Error("Invalid tar header checksum");
    const length = octal(header.subarray(124, 136));
    const start = offset + block;
    offset = start + Math.ceil(length / block) * block;
    if (offset > tar.length) throw Error("Truncated tar entry");
    const data = tar.subarray(start, start + length);
    const entry = header.toString("latin1", 0, 100).replace(/\0+$/, "");
    if (header[156] === 120) {
      checkFileMetadata(data);
      continue;
    }
    if (
      (header[156] !== 48 && header[156] !== 0) ||
      (header.toString("latin1", 257, 263) === "ustar\0" && header[345] !== 0)
    )
      throw Error("Expected one regular executable");
    if (
      !appleDouble &&
      entry === "._" + name &&
      data.length >= 4 &&
      data.readUInt32BE(0) === 0x00051607
    ) {
      appleDouble = true;
    } else if (!executable && entry === name && data.length === size) {
      executable = data;
    } else throw Error("Expected one regular executable");
  }
  if (!executable || tar.length - offset < 2 * block || !zeros(tar.subarray(offset)))
    throw Error("Incomplete release archive");
  return executable;
}
