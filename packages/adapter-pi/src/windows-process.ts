import { dlopen } from "bun:ffi";

const { symbols: kernel } = dlopen("kernel32.dll", {
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
  WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
});

export function windowsProcessExited(pid: number) {
  const handle = kernel.OpenProcess(0x00100000, 0, pid); // SYNCHRONIZE
  if (handle === 0n) return kernel.GetLastError() === 87; // PID no longer exists.
  try {
    return kernel.WaitForSingleObject(handle, 0) === 0; // WAIT_OBJECT_0
  } finally {
    kernel.CloseHandle(handle);
  }
}
