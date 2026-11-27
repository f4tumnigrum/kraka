#!/usr/bin/env bash
set -euo pipefail
cd /fixture
ip route del default 2>/dev/null || true
case "$1" in
router)
  for prefix in trusted other; do
    openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$prefix-ca.key" -out "$prefix-ca.pem" -subj "/CN=Kraka fixture $prefix" >/dev/null 2>&1
    openssl req -newkey rsa:2048 -nodes -keyout "$prefix-leaf.key" -out "$prefix.csr" -subj /CN=kraka.test >/dev/null 2>&1
    openssl x509 -req -in "$prefix.csr" -CA "$prefix-ca.pem" -CAkey "$prefix-ca.key" -CAcreateserial -days 1 -extfile <(printf 'subjectAltName=DNS:kraka.test\nextendedKeyUsage=serverAuth\n') -out "$prefix-leaf.pem" >/dev/null 2>&1
    rm "$prefix-ca.key" "$prefix.csr"
  done
  mv trusted-ca.pem root.pem
  mv trusted-leaf.pem leaf.pem
  mv trusted-leaf.key leaf.key
  touch /tmp/ready
  exec dnsmasq --keep-in-foreground --no-resolv --address=/kraka.test/10.78.41.10 --user=root
  ;;
desktop)
  printf "nameserver 10.78.41.2\n" > /etc/resolv.conf
  ip route replace 10.78.42.0/24 via 10.78.41.2
  touch /tmp/ready
  exec sleep infinity
  ;;
mobile)
  printf "nameserver 10.78.42.2\n" > /etc/resolv.conf
  mkdir -p /home/pwuser/.pki/nssdb /fixture/profiles
  chown -R pwuser:pwuser /home/pwuser/.pki /fixture/profiles
  runuser -u pwuser -- certutil -N -d sql:/home/pwuser/.pki/nssdb --empty-password
  runuser -u pwuser -- certutil -A -d sql:/home/pwuser/.pki/nssdb -t C,, -n kraka-fixture -i root.pem
  cd /app
  exec bun tools/fixtures/browser-mobile.ts
  ;;
esac
