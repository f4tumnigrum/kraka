import {appendFileSync} from "node:fs";
import { mkdir, lstat, realpath } from "node:fs/promises";

const windowsDirectory = `
$ErrorActionPreference = 'Stop'
try {
  $path = $env:KRAKA_ACCESS_DIRECTORY
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  if (-not [System.IO.Directory]::Exists($path)) {
    $private = New-Object System.Security.AccessControl.DirectorySecurity
    $private.SetOwner($user)
    $private.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $private.AddAccessRule($rule)
    [void][System.IO.Directory]::CreateDirectory($path, $private)
  }
  $acl = [System.IO.Directory]::GetAccessControl($path, 'Owner, Access')
  $sidType = [System.Security.Principal.SecurityIdentifier]
  if ($acl.GetOwner($sidType).Value -ne $user.Value) { throw 'State directory belongs to another user' }
  foreach ($ace in $acl.GetAccessRules($true, $true, $sidType)) {
    if ($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      throw 'State directory permits another account'
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export async function ownedDirectory(dir: string) {
  if (process.platform === "win32") {
    const t=performance.now();
    const result = Bun.spawnSync(
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsDirectory, "utf16le").toString("base64"),
      ],
      { env: { ...process.env, KRAKA_ACCESS_DIRECTORY: dir }, stdout: "ignore", stderr: "pipe" },
    );
    if(process.env.D009H_CASE && process.env.D009H_ACL)appendFileSync(process.env.D009H_ACL,JSON.stringify({pid:process.pid,ms:performance.now()-t,dir:dir.split(/[\\/]/).at(-1)})+"\n");
    if (result.exitCode !== 0)
      throw Error(`Private state directory check failed: ${result.stderr.toString().trim()}`);
  } else {
    await mkdir(dir, { mode: 0o700, recursive: true });
  }
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Expected a private state directory");
  if (
    process.platform !== "win32" &&
    (!process.geteuid || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0)
  )
    throw Error("State directory must belong to this OS user and have mode 0700");
  return realpath(dir);
}
