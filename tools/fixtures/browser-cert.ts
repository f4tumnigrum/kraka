import { join } from "node:path";
import { writeFile } from "node:fs/promises";
export async function certificate(
  dir: string,
  name = "loopback",
  san = "IP:127.0.0.1,DNS:localhost",
) {
  const cert = join(dir, `${name}.crt`),
    key = join(dir, `${name}.key`),
    config = join(dir, `${name}.cnf`);
  await writeFile(
    config,
    "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=localhost\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=" +
      san +
      "\n",
  );
  const r = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-config",
      config,
      "-keyout",
      key,
      "-out",
      cert,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw Error("Fixture certificate issuance failed");
  return { cert, key, ca: await Bun.file(cert).text() };
}
