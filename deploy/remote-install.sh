#!/usr/bin/env bash
# managed-by: jobop/mind
set -Eeuo pipefail
umask 022
archive=${1:?release archive required}
domain=${2:?domain required}
sha=${3:?commit SHA required}
[[ $EUID == 0 ]] || { echo 'Deployment requires root to configure systemd and Nginx.'; exit 1; }
[[ $sha =~ ^[a-f0-9]{40}$ && $domain =~ ^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo 'Invalid deployment arguments'; exit 1; }
incoming=$(dirname "$archive")
[[ $incoming =~ ^/tmp/mind-deploy\.[A-Za-z0-9]{8}$ && -f $archive && ! -L $archive ]] || { echo 'Invalid release archive location'; exit 1; }
base=/opt/mind
release="$base/releases/$sha"
staging="$base/releases/.staging-$sha-$$"
nginx_conf="/etc/nginx/conf.d/$domain.conf"
unit=/etc/systemd/system/mind.service
envfile=/etc/mind/mind.env
old_release=''
transaction=0
success=0
backup=''
restore_file() {
  local name=$1 target=$2
  if [[ -f $backup/$name ]]; then cp -p "$backup/$name" "$target"; else rm -f "$target"; fi
}
finish() {
  local status=$?
  set +e
  if (( ! success && transaction )); then
    echo 'Deployment failed. Restoring the previous application and Nginx configuration.'
    restore_file nginx.conf "$nginx_conf"
    restore_file mind.env "$envfile"
    restore_file mind.service "$unit"
    if [[ -n $old_release ]]; then
      ln -s "$old_release" "$base/.restore-$$"; mv -Tf "$base/.restore-$$" "$base/current"
      systemctl daemon-reload; systemctl restart mind.service
    else
      systemctl stop mind.service; systemctl disable mind.service
      rm -f "$base/current"; systemctl daemon-reload
    fi
    nginx -t && systemctl reload nginx
  fi
  rm -rf "$staging" "$incoming"
  exit "$status"
}
trap finish EXIT
source /etc/os-release
if [[ $ID == centos && ${VERSION_ID%%.*} == 7 && -f /etc/caddy/Caddyfile ]]; then
  compat="$incoming/remote-install-centos7.sh"
  tar -xOf "$archive" ./deploy/remote-install-centos7.sh > "$compat"
  exec bash "$compat" "$archive" "$domain" "$sha"
fi
case "$ID" in ubuntu|debian) ;; *) echo 'Automatic host setup currently supports Ubuntu/Debian with systemd. No application was changed.'; exit 1;; esac
command -v systemctl >/dev/null || { echo 'systemd is required'; exit 1; }
if [[ -e $unit ]] && ! grep -q 'managed-by: jobop/mind' "$unit"; then echo 'An unrelated mind.service exists; refusing to overwrite it.'; exit 1; fi
if [[ -e $nginx_conf || -L $nginx_conf ]]; then
  [[ ! -L $nginx_conf ]] && grep -q 'managed-by: jobop/mind' "$nginx_conf" || { echo 'An unmanaged Nginx file exists at the target path; merge it before deploying.'; exit 1; }
fi
export DEBIAN_FRONTEND=noninteractive
missing=0
for binary in nginx certbot python3 curl openssl ss; do command -v "$binary" >/dev/null || missing=1; done
if (( missing )); then
  apt-get update -qq
  apt-get install -y nginx certbot python3 curl ca-certificates openssl iproute2
fi
python3 - "$domain" "$nginx_conf" <<'PY'
import pathlib,re,sys
domain,target=sys.argv[1:]
for directory in ['/etc/nginx/conf.d','/etc/nginx/sites-enabled']:
 for p in pathlib.Path(directory).glob('*'):
  if not p.is_file() or p.resolve()==pathlib.Path(target).resolve(): continue
  text=re.sub(r'#[^\n]*','',p.read_text(errors='replace'))
  if any(domain in names.split() for names in re.findall(r'\bserver_name\s+([^;]+);',text)):
   raise SystemExit('This domain is already configured in '+str(p)+'. Merge or remove only that domain configuration before deploying.')
PY
if [[ -e $base/current && ! -L $base/current ]]; then echo '/opt/mind/current is not an application symlink; refusing to overwrite it.'; exit 1; fi
if [[ -L $base/current ]]; then old_release=$(readlink -f "$base/current"); fi
install -d -m 755 "$base/releases"
install -d -m 700 "$base/backups"
install -d -m 755 "$staging"
python3 - "$archive" <<'PY'
import tarfile,sys,posixpath
with tarfile.open(sys.argv[1]) as tar:
 for member in tar:
  path=posixpath.normpath(member.name)
  if path.startswith('/') or path=='..' or path.startswith('../'): raise SystemExit('Unsafe archive path')
  if not (member.isfile() or member.isdir() or member.issym() or member.islnk()): raise SystemExit('Unsupported archive entry')
  if member.issym() or member.islnk():
   link=posixpath.normpath(posixpath.join(posixpath.dirname(path),member.linkname) if member.issym() else member.linkname)
   if link.startswith('/') or link=='..' or link.startswith('../'): raise SystemExit('Unsafe archive link')
PY
tar -xzf "$archive" -C "$staging" --no-same-owner
[[ $(cat "$staging/RELEASE") == "$sha" && -f $staging/scripts/local-server.mjs ]] || { echo 'Release identity mismatch'; exit 1; }
case $(uname -m) in x86_64) machine=x64;; aarch64|arm64) machine=arm64;; *) echo 'Unsupported server CPU architecture'; exit 1;; esac
[[ $(cat "$staging/NODE_ARCH") == "$machine" ]] || { echo 'CPU mismatch: rerun the workflow with the correct architecture.'; exit 1; }
find "$staging" -type d -exec chmod 755 {} +
find "$staging" -type f -exec chmod 644 {} +
chmod 755 "$staging/bin/node"
"$staging/bin/node" -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<22||(a===22&&b<19))process.exit(1)'
if [[ -e $release ]]; then
  [[ -f $release/RELEASE && $(cat "$release/RELEASE") == "$sha" ]] || { echo 'Existing release is not managed by this deployment'; exit 1; }
  rm -rf "$staging"
else
  mv "$staging" "$release"
fi
if ! id mind-app >/dev/null 2>&1; then useradd --system --home-dir /var/lib/mind --create-home --shell /usr/sbin/nologin mind-app; fi
install -d -o mind-app -g mind-app -m 700 /var/lib/mind
if [[ -f /var/lib/mind/encryption-key ]]; then chown mind-app:mind-app /var/lib/mind/encryption-key; chmod 600 /var/lib/mind/encryption-key; fi
install -d -m 700 /etc/mind
install -d -m 755 /var/www/mind-acme
if ! systemctl is-active --quiet mind.service; then
  python3 - <<'PY'
import socket
s=socket.socket()
try:s.bind(('127.0.0.1',3180))
except OSError:raise SystemExit('Port 3180 is already used by a different application')
finally:s.close()
PY
fi
backup="$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-$sha-$$"
install -d -m 700 "$backup"
[[ ! -f $unit ]] || cp -p "$unit" "$backup/mind.service"
[[ ! -f $envfile ]] || cp -p "$envfile" "$backup/mind.env"
[[ ! -f $nginx_conf ]] || cp -p "$nginx_conf" "$backup/nginx.conf"
printf '%s\n' "$old_release" > "$backup/previous-release"
transaction=1
python3 - "$envfile" "$domain" <<'PY'
import pathlib,sys,os
p=pathlib.Path(sys.argv[1])
values={'PUBLIC_ORIGIN':'https://'+sys.argv[2],'PORT':'3180','DATA_DIR':'/var/lib/mind','NODE_ENV':'production'}
old=p.read_text().splitlines() if p.exists() else []
lines=[line for line in old if line.split('=',1)[0] not in values]
lines.extend(k+'='+v for k,v in values.items())
temp=p.with_suffix('.new');temp.write_text('\n'.join(lines)+'\n');os.chmod(temp,0o600);os.replace(temp,p)
PY
if [[ -f $incoming/e2b-settings.json ]]; then
  python3 - "$incoming/e2b-settings.json" "$envfile" <<'PYE2B'
import json,pathlib,sys,os,re
values=json.load(open(sys.argv[1]));p=pathlib.Path(sys.argv[2])
allowed={key:str(values[key]) for key in ['E2B_API_KEY','E2B_TEMPLATE_ID'] if key in values}
if any(len(v)>1000 or re.search(r'[^a-zA-Z0-9_./:@+-]',v) for v in allowed.values()):raise SystemExit('Invalid E2B environment values')
lines=[line for line in p.read_text().splitlines() if line.split('=',1)[0] not in allowed]
temp=p.with_suffix('.e2b-new');temp.write_text('\n'.join(lines+[key+'='+value for key,value in allowed.items()])+'\n');os.chmod(str(temp),0o600);os.replace(str(temp),str(p))
PYE2B
  rm -f "$incoming/e2b-settings.json"
fi
cat > "$unit" <<'UNIT'
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
ExecStart=/opt/mind/current/bin/node scripts/local-server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/mind
[Install]
WantedBy=multi-user.target
UNIT
ln -s "$release" "$base/.current-$$"; mv -Tf "$base/.current-$$" "$base/current"
systemctl daemon-reload
systemctl enable mind.service
systemctl restart mind.service
healthy=0
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 5 -H "Host: $domain" http://127.0.0.1:3180/healthz > "$backup/health.json"; then
    if python3 - "$backup/health.json" "$sha" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));assert d.get('agent') is True and d.get('release')==sys.argv[2]
PY
    then healthy=1; break; fi
  fi
  sleep 2
done
(( healthy )) || { echo 'New application failed its health check'; systemctl status mind.service --no-pager; exit 1; }
proxy_location() {
  cat <<'NGINX'
    location / {
        proxy_pass http://127.0.0.1:3180;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 240s;
        proxy_send_timeout 240s;
        client_max_body_size 1m;
    }
NGINX
}
if [[ ! -f /etc/letsencrypt/live/$domain/fullchain.pem ]]; then
  {
    printf '# managed-by: jobop/mind\nserver {\n    listen 80;\n    server_name %s;\n' "$domain"
    printf '    location /.well-known/acme-challenge/ { root /var/www/mind-acme; }\n'
    proxy_location
    printf '}\n'
  } > "$nginx_conf"
  nginx -t; systemctl enable --now nginx; systemctl reload nginx
  certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot -w /var/www/mind-acme --cert-name "$domain" -d "$domain"
fi
{
  printf '# managed-by: jobop/mind\nserver {\n    listen 80;\n    server_name %s;\n' "$domain"
  printf '    location /.well-known/acme-challenge/ { root /var/www/mind-acme; }\n    location / { return 301 https://$host$request_uri; }\n}\n'
  printf 'server {\n    listen 443 ssl;\n    server_name %s;\n' "$domain"
  printf '    ssl_certificate /etc/letsencrypt/live/%s/fullchain.pem;\n    ssl_certificate_key /etc/letsencrypt/live/%s/privkey.pem;\n' "$domain" "$domain"
  printf '    ssl_protocols TLSv1.2 TLSv1.3;\n'
  proxy_location
  printf '}\n'
} > "$nginx_conf"
nginx -t; systemctl enable --now nginx; systemctl reload nginx
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/mind-nginx-reload <<'HOOK'
#!/bin/sh
nginx -t && systemctl reload nginx
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/mind-nginx-reload
systemctl enable --now certbot.timer
curl -fsS --max-time 20 "https://$domain/healthz" > "$backup/https-health.json"
python3 - "$backup/https-health.json" "$sha" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]));assert d.get('status')=='ok' and d.get('agent') is True and d.get('release')==sys.argv[2]
PY
success=1
echo "Deployment healthy: https://$domain (commit $sha)"
