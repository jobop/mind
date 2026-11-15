#!/usr/bin/env bash
# managed-by: jobop/mind
set -Eeuo pipefail
umask 022
archive=${1:?release archive required}
domain=${2:?domain required}
sha=${3:?commit SHA required}
[[ $EUID == 0 && $sha =~ ^[a-f0-9]{40}$ && $domain =~ ^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo 'Invalid deployment arguments'; exit 1; }
incoming=$(dirname "$archive")
[[ $incoming =~ ^/tmp/mind-deploy\.[A-Za-z0-9]{8}$ && -f $archive && ! -L $archive ]] || { echo 'Invalid archive location'; exit 1; }
base=/opt/mind
release="$base/releases/$sha"
staging="$base/releases/.staging-$sha-$$"
unit=/etc/systemd/system/mind.service
envfile=/etc/mind/mind.env
caddyfile=/etc/caddy/Caddyfile
sitefile="/etc/caddy/mind-sites/$domain.caddy"
old_release=''
backup=''
transaction=0
success=0
restore() { if [[ -f $backup/$1 ]]; then cp -p "$backup/$1" "$2"; else rm -f "$2"; fi; }
finish() {
  local status=$?
  set +e
  if (( ! success && transaction )); then
    echo 'Restoring the previous application and Caddy configuration.'
    restore Caddyfile "$caddyfile"; restore site.caddy "$sitefile"; restore mind.env "$envfile"; restore mind.service "$unit"
    if [[ -n $old_release ]]; then
      ln -s "$old_release" "$base/.restore-$$"; mv -Tf "$base/.restore-$$" "$base/current"
      systemctl daemon-reload; systemctl restart mind.service
    else
      systemctl stop mind.service; systemctl disable mind.service; rm -f "$base/current"; systemctl daemon-reload
    fi
    caddy validate --config "$caddyfile" --adapter caddyfile && caddy reload --config "$caddyfile" --adapter caddyfile
  fi
  rm -rf "$staging" "$incoming"
  exit "$status"
}
trap finish EXIT
for binary in caddy python3 curl systemctl useradd runuser; do command -v "$binary" >/dev/null || { echo "Required command missing: $binary"; exit 1; }; done
[[ -f $caddyfile ]] || { echo 'Expected existing /etc/caddy/Caddyfile'; exit 1; }
if [[ -f $unit ]] && ! grep -q 'managed-by: jobop/mind' "$unit"; then echo 'An unrelated mind.service exists'; exit 1; fi
if [[ -e $sitefile ]] && ! grep -q 'managed-by: jobop/mind' "$sitefile"; then echo 'An unmanaged domain configuration exists'; exit 1; fi
node_runtime=''
for candidate in /opt/node22/bin/node /opt/node/bin/node /usr/local/bin/node /usr/bin/node; do
  if [[ -x $candidate ]] && env -i PATH=/usr/bin:/bin "$candidate" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' 2>/dev/null; then node_runtime=$candidate; break; fi
done
[[ -n $node_runtime ]] || { echo 'A compatible existing Node.js >=22.19 is required on this legacy host'; exit 1; }
echo "Using existing compatible runtime: $node_runtime"
if [[ -e $base/current && ! -L $base/current ]]; then echo '/opt/mind/current is not an application symlink'; exit 1; fi
if [[ -L $base/current ]]; then old_release=$(readlink -f "$base/current"); fi
install -d -m 755 "$base/releases" /etc/caddy/mind-sites
install -d -m 700 "$base/backups" /etc/mind
install -d -m 755 "$staging"
python3 - "$archive" <<'PY'
import tarfile,sys,posixpath
with tarfile.open(sys.argv[1]) as tar:
 for m in tar:
  path=posixpath.normpath(m.name)
  if path.startswith('/') or path=='..' or path.startswith('../'):raise SystemExit('Unsafe archive path')
  if not(m.isfile() or m.isdir() or m.issym() or m.islnk()):raise SystemExit('Unsupported archive entry')
  if m.issym() or m.islnk():
   target=posixpath.normpath(posixpath.join(posixpath.dirname(path),m.linkname) if m.issym() else m.linkname)
   if target.startswith('/') or target=='..' or target.startswith('../'):raise SystemExit('Unsafe archive link')
PY
tar -xzf "$archive" -C "$staging" --no-same-owner
[[ $(cat "$staging/RELEASE") == "$sha" && -f $staging/scripts/local-server.mjs ]] || { echo 'Release identity mismatch'; exit 1; }
[[ $(uname -m) == x86_64 && $(cat "$staging/NODE_ARCH") == x64 ]] || { echo 'Legacy host architecture mismatch'; exit 1; }
# The official bundled runtime requires a newer glibc. Keep the existing runtime unchanged.
rm -f "$staging/bin/node"
printf '%s\n' "$node_runtime" > "$staging/NODE_RUNTIME"
find "$staging" -type d -exec chmod 755 {} +
find "$staging" -type f -exec chmod 644 {} +
if [[ -e $release ]]; then
  [[ -f $release/RELEASE && $(cat "$release/RELEASE") == "$sha" ]] || { echo 'Unmanaged existing release'; exit 1; }
  rm -rf "$staging"
else mv "$staging" "$release"; fi
if ! id mind-app >/dev/null 2>&1; then useradd --system --home-dir /var/lib/mind --create-home --shell /sbin/nologin mind-app; fi
runuser -u mind-app -- env -i PATH=/usr/bin:/bin "$node_runtime" --version
install -d -o mind-app -g mind-app -m 700 /var/lib/mind
if [[ -f /var/lib/mind/encryption-key ]]; then chown mind-app:mind-app /var/lib/mind/encryption-key; chmod 600 /var/lib/mind/encryption-key; fi
if ! systemctl is-active --quiet mind.service; then
  python3 - <<'PY'
import socket
s=socket.socket()
try:s.bind(('127.0.0.1',3180))
except OSError:raise SystemExit('Port 3180 is used by another service')
finally:s.close()
PY
fi
backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-$sha-$$"
install -d -m 700 "$backup"
cp -p "$caddyfile" "$backup/Caddyfile"
[[ ! -f $sitefile ]] || cp -p "$sitefile" "$backup/site.caddy"
[[ ! -f $unit ]] || cp -p "$unit" "$backup/mind.service"
[[ ! -f $envfile ]] || cp -p "$envfile" "$backup/mind.env"
printf '%s\n' "$old_release" > "$backup/previous-release"
if systemctl is-active --quiet mind.service; then python3 "$release/deploy/wait-for-jobs.py" /var/lib/mind/projects.sqlite; fi
transaction=1
python3 - "$envfile" "$domain" <<'PY'
import pathlib,sys,os
p=pathlib.Path(sys.argv[1]);values={'PUBLIC_ORIGIN':'https://'+sys.argv[2],'PORT':'3180','DATA_DIR':'/var/lib/mind','NODE_ENV':'production'}
old=p.read_text(encoding='utf-8').splitlines() if p.exists() else []
lines=[line for line in old if line.split('=',1)[0] not in values]+[k+'='+v for k,v in values.items()]
temp=p.with_suffix('.new');temp.write_text('\n'.join(lines)+'\n',encoding='utf-8');os.chmod(str(temp),0o600);os.replace(str(temp),str(p))
PY
if [[ -f $incoming/e2b-settings.json ]]; then
  python3 - "$incoming/e2b-settings.json" "$envfile" <<'PYE2B'
import json,pathlib,sys,os,re
values=json.load(open(sys.argv[1]));p=pathlib.Path(sys.argv[2])
allowed={key:str(values[key]) for key in ['E2B_API_KEY','E2B_TEMPLATE_ID'] if key in values}
if any(len(v)>1000 or re.search(r'[^a-zA-Z0-9_./:@+=-]',v) for v in allowed.values()):raise SystemExit('Invalid E2B environment values')
lines=[line for line in p.read_text().splitlines() if line.split('=',1)[0] not in allowed]
temp=p.with_suffix('.e2b-new');temp.write_text('\n'.join(lines+[key+'='+value for key,value in allowed.items()])+'\n');os.chmod(str(temp),0o600);os.replace(str(temp),str(p))
PYE2B
  rm -f "$incoming/e2b-settings.json"
fi
python3 - "$envfile" "$node_runtime" "$release" <<'PYCHECK'
import os,sys,subprocess
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin'}
for line in open(sys.argv[1]):
 key,sep,value=line.strip().partition('=')
 if sep and key in ['E2B_API_KEY','E2B_TEMPLATE_ID']:env[key]=value
if env.get('E2B_API_KEY'):
 subprocess.run(['runuser','-u','mind-app','--',sys.argv[2],'scripts/check-platform-e2b.mjs'],cwd=sys.argv[3],env=env,check=True,timeout=100)
PYCHECK
cat > "$unit" <<UNIT
# managed-by: jobop/mind
[Unit]
Description=Mind Pi Agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=mind-app
Group=mind-app
WorkingDirectory=/opt/mind/current
EnvironmentFile=/etc/mind/mind.env
ExecStart=$node_runtime scripts/local-server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWriteDirectories=/var/lib/mind
[Install]
WantedBy=multi-user.target
UNIT
ln -s "$release" "$base/.current-$$"; mv -Tf "$base/.current-$$" "$base/current"
systemctl daemon-reload; systemctl enable mind.service; systemctl restart mind.service
healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 -H "Host: $domain" http://127.0.0.1:3180/healthz > "$backup/health.json"; then
    if python3 - "$backup/health.json" "$sha" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));assert d.get('agent') is True and d.get('release')==sys.argv[2]
PY
    then healthy=1;break;fi
  fi
  sleep 2
done
(( healthy )) || { echo 'Application health check failed'; systemctl status mind.service --no-pager; exit 1; }
cat > "$sitefile" <<SITE
# managed-by: jobop/mind
$domain {
    reverse_proxy 127.0.0.1:3180 {
        header_up X-Real-IP {remote_host}
        flush_interval 100ms
        transport http {
            read_timeout 240s
            write_timeout 240s
        }
    }
}
SITE
python3 - "$caddyfile" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]);text=p.read_text(encoding='utf-8');line='import /etc/caddy/mind-sites/*.caddy'
if line not in [v.strip() for v in text.splitlines()]:p.write_text(text.rstrip()+'\n\n# managed-by: jobop/mind\n'+line+'\n',encoding='utf-8')
PY
caddy validate --config "$caddyfile" --adapter caddyfile
caddy reload --config "$caddyfile" --adapter caddyfile
https_ok=0
for attempt in $(seq 1 25); do
  if curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/healthz" > "$backup/https-health.json"; then
    if python3 - "$backup/https-health.json" "$sha" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));assert d.get('agent') is True and d.get('release')==sys.argv[2]
PY
    then https_ok=1;break;fi
  fi
  sleep 3
done
(( https_ok )) || { echo 'Caddy HTTPS verification failed'; exit 1; }
success=1
echo "Deployment healthy through existing Caddy: https://$domain (commit $sha)"
