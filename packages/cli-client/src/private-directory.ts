import { mkdir, lstat, realpath } from "node:fs/promises";

export async function ownedDirectory(dir: string) {
  const created = await mkdir(dir, { mode: 0o700, recursive: true });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("Expected a private state directory");
  if (process.platform === "win32") {
    const script = `$ErrorActionPreference='Stop'
      $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $dir=$env:KRAKA_ACCESS_DIRECTORY
      $acl=Get-Acl -LiteralPath $dir
      if($env:KRAKA_ACCESS_NEW -eq '1'){$acl.SetOwner($owner)}
      if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $owner.Value){throw 'State directory belongs to another user'}
      if($env:KRAKA_ACCESS_NEW -eq '1'){
        $acl.SetAccessRuleProtection($true,$false)
        $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($owner,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
        Set-Acl -LiteralPath $dir -AclObject $acl
      }
      foreach($ace in (Get-Acl -LiteralPath $dir).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){
        if($ace.AccessControlType -eq 'Allow' -and $ace.IdentityReference.Value -notin @($owner.Value,'S-1-5-18','S-1-5-32-544')){throw 'State directory must be private'}
      }`;
    const result = Bun.spawnSync(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        env: { ...process.env, KRAKA_ACCESS_DIRECTORY: dir, KRAKA_ACCESS_NEW: created ? "1" : "0" },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    if (result.exitCode !== 0)
      throw Error("Local account could not verify the private state directory");
  } else if (!process.geteuid || stat.uid !== process.geteuid() || (stat.mode & 0o077) !== 0)
    throw Error("State directory must belong to this OS user and have mode 0700");
  return realpath(dir);
}
