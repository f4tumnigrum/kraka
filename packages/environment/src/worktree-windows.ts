import { dlopen, ptr } from "bun:ffi";

const { symbols: kernel } = dlopen("kernel32.dll", {
  CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
  AssignProcessToJobObject: { args: ["u64", "i64"], returns: "i32" },
  SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
  QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
  TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
  OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
  GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
});
function failed(api: string): never {
  throw Error(`${api} failed (${kernel.GetLastError()})`);
}
export function windowsProcessStart(pid: number) {
  const handle = kernel.OpenProcess(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (!handle) failed("OpenProcess");
  try {
    const times = new BigUint64Array(4);
    if (!kernel.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24)))
      failed("GetProcessTimes");
    return Number(((times[0] ?? 0n) - 116444736000000000n) / 10000n);
  } finally {
    kernel.CloseHandle(handle);
  }
}
export function ownWindowsJob() {
  const job = kernel.CreateJobObjectW(null, null);
  if (!job) failed("CreateJobObjectW");
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows. The handle is
  // non-inheritable. The system closes it when this helper exits.
  const limits = Buffer.alloc(144);
  limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  if (!kernel.SetInformationJobObject(job, 9, ptr(limits), limits.length))
    failed("SetInformationJobObject");
  if (!kernel.AssignProcessToJobObject(job, -1n)) failed("AssignProcessToJobObject");
  return {
    alone() {
      const accounting = Buffer.alloc(48); // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
      if (!kernel.QueryInformationJobObject(job, 1, ptr(accounting), accounting.length, null))
        failed("QueryInformationJobObject");
      return accounting.readUInt32LE(40) === 1;
    },
    force() {
      if (!kernel.TerminateJobObject(job, 1)) failed("TerminateJobObject");
    },
  };
}
