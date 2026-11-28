import { closeSync } from "node:fs";

// The peer stays alive on its control connection after giving up its last RPC writer.
export async function closePeerOutput() {
  if (process.platform !== "win32") {
    closeSync(1);
    return "closed stdout fd 1";
  }
  const { dlopen, ptr } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: "u64" },
    GetStdHandle: { args: ["i32"], returns: "u64" },
    SetStdHandle: { args: ["i32", "u64"], returns: "i32" },
    DuplicateHandle: { args: ["u64", "u64", "u64", "ptr", "u32", "i32", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
    PssCaptureSnapshot: { args: ["u64", "u32", "u32", "ptr"], returns: "u32" },
    PssFreeSnapshot: { args: ["u64", "u64"], returns: "u32" },
    PssWalkMarkerCreate: { args: ["ptr", "ptr"], returns: "u32" },
    PssWalkMarkerFree: { args: ["u64"], returns: "u32" },
    PssWalkSnapshot: { args: ["u64", "u32", "u64", "ptr", "u32"], returns: "u32" },
  });
  const base = dlopen("kernelbase.dll", {
    CompareObjectHandles: { args: ["u64", "u64"], returns: "i32" },
  });
  const k = kernel.symbols;
  const self = k.GetCurrentProcess(),
    stdout = k.GetStdHandle(-11); // STD_OUTPUT_HANDLE
  const reference = new BigUint64Array(1),
    snapshot = new BigUint64Array(1),
    marker = new BigUint64Array(1);
  function check(status: number, operation: string) {
    if (status !== 0) throw Error(`${operation} failed (${status})`);
  }
  let remaining = 0;
  try {
    if (!k.DuplicateHandle(self, stdout, self, ptr(reference), 0, 0, 2))
      check(k.GetLastError(), "DuplicateHandle(stdout)");
    const [pipe] = reference;
    if (!pipe) throw Error("Missing pipe reference");
    closeSync(1);
    if (!k.SetStdHandle(-11, 0n)) check(k.GetLastError(), "SetStdHandle(stdout)");
    check(k.PssCaptureSnapshot(self, 4, 0, ptr(snapshot)), "PssCaptureSnapshot"); // PSS_CAPTURE_HANDLES
    check(k.PssWalkMarkerCreate(null, ptr(marker)), "PssWalkMarkerCreate");
    // PSS_HANDLE_ENTRY on win32-x64/arm64 begins with the handle value.
    const entry = Buffer.alloc(136);
    for (;;) {
      const status = k.PssWalkSnapshot(
        snapshot[0] ?? 0n,
        2,
        marker[0] ?? 0n,
        ptr(entry),
        entry.length,
      );
      if (status === 259) break; // ERROR_NO_MORE_ITEMS
      check(status, "PssWalkSnapshot");
      const handle = entry.readBigUInt64LE(0);
      if (handle === pipe || !base.symbols.CompareObjectHandles(handle, pipe)) continue;
      if (!k.CloseHandle(handle)) check(k.GetLastError(), "CloseHandle(pipe writer)");
      remaining++;
    }
    return `after closeSync(1), closed ${remaining} remaining stdout pipe handle(s)`;
  } finally {
    if (marker[0]) k.PssWalkMarkerFree(marker[0]);
    if (snapshot[0]) k.PssFreeSnapshot(self, snapshot[0]);
    if (reference[0]) k.CloseHandle(reference[0]);
    base.close();
    kernel.close();
  }
}
