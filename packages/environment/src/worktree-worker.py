"""A leased group leader. Only this process grants the OS a command to execute."""
import ctypes
import datetime
import json
import os
import queue
import signal
import sqlite3
import subprocess
import sys
import threading
import time


def process_start(pid):
    if os.name == "nt":
        from ctypes import wintypes as wt
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.restype = wt.HANDLE
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            raise OSError(ctypes.get_last_error())
        stamps = [wt.FILETIME() for _ in range(4)]
        try:
            if not kernel.GetProcessTimes(wt.HANDLE(handle), *map(ctypes.byref, stamps)):
                raise OSError(ctypes.get_last_error())
            created = stamps[0]
            return ((created.dwHighDateTime << 32 | created.dwLowDateTime) - 116444736000000000) // 10000
        finally:
            kernel.CloseHandle(wt.HANDLE(handle))
    if sys.platform.startswith("linux"):
        with open("/proc/%d/stat" % pid) as f:
            ticks = int(f.read().rsplit(")", 1)[1].split()[19])
        with open("/proc/stat") as f:
            boot = next(int(s.split()[1]) for s in f if s.startswith("btime "))
        return boot * 1000 + ticks * 1000 // os.sysconf("SC_CLK_TCK")
    env = dict(os.environ, LC_ALL="C", TZ="UTC")
    stamp = subprocess.check_output(["ps", "-o", "lstart=", "-p", str(pid)], env=env).decode().strip()
    return int(datetime.datetime.strptime(stamp, "%a %b %d %H:%M:%S %Y").replace(tzinfo=datetime.timezone.utc).timestamp()) * 1000


def manage_group():
    if os.name != "nt":
        if os.getsid(0) != os.getpid():
            os.setsid()
        signal.signal(signal.SIGTERM, lambda *_: None)
        def alone():
            # ps itself inherits this group, so launch the observer in a different session.
            rows = subprocess.check_output(["ps", "-A", "-o", "pid=", "-o", "pgid="], start_new_session=True)
            return not any(int(pid) != os.getpid() and int(group) == os.getpgrp()
                           for pid, group in (line.split() for line in rows.splitlines()))
        return alone, lambda force: os.killpg(os.getpgrp(), signal.SIGKILL if force else signal.SIGTERM)

    from ctypes import wintypes as wt
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.restype = wt.HANDLE
    job = wt.HANDLE(kernel.CreateJobObjectW(None, None))
    if not job or not kernel.AssignProcessToJobObject(job, wt.HANDLE(-1)):
        raise OSError(ctypes.get_last_error())
    # BASIC_ACCOUNTING_INFORMATION has four LARGE_INTEGERs followed by four DWORDs.
    def alone():
        info = ctypes.create_string_buffer(48)
        if not kernel.QueryInformationJobObject(job, 1, info, len(info), None):
            raise OSError(ctypes.get_last_error())
        return int.from_bytes(info.raw[40:44], "little") == 1
    return alone, lambda force: kernel.TerminateJobObject(job, 1) if force else None


def run(task):
    alone, stop = manage_group()
    with sqlite3.connect(task["lease"], timeout=0) as lease:
        lease.execute("BEGIN EXCLUSIVE")
        deadline = time.monotonic() + 5
        gate = queue.Queue()
        threading.Thread(target=lambda: gate.put(sys.stdin.readline()), daemon=True).start()
        identity = {"pid": os.getpid(), "startedAt": process_start(os.getpid())}
        print(json.dumps(identity), flush=True)
        if gate.get(timeout=max(0, deadline-time.monotonic())).strip() != task["token"]:
            return 1
        with subprocess.Popen(task["argv"], cwd=task["cwd"], stdin=subprocess.PIPE,
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) as child:
            try:
                child.communicate(bytes.fromhex(sys.stdin.readline().strip()), timeout=task["seconds"])
            except subprocess.TimeoutExpired:
                stop(False)
                try:
                    child.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    stop(True)
                    child.wait(timeout=2)
            if not alone():
                stop(False)
                time.sleep(2)
                if not alone():
                    stop(True)
                    return 1
            record = dict(identity, token=task["token"], code=child.returncode)
            with open(task["result"]+".tmp", "x", encoding="utf-8") as f:
                json.dump(record, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(task["result"]+".tmp", task["result"])
            return 0


if sys.argv[1] == "probe":
    print(process_start(int(sys.argv[2])))
else:
    sys.exit(run(json.loads(sys.argv[1])))
