#!/usr/bin/env bash
set -Eeuo pipefail
host=${DEPLOY_HOST:-47.90.84.89}
port=${DEPLOY_PORT:-22}
user=${DEPLOY_USER:-root}
domain=${DEPLOY_DOMAIN:-mind.made-world.link}
sha=${GITHUB_SHA:?GITHUB_SHA is required}
[[ $host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo 'Invalid SSH host'; exit 1; }
[[ $user =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo 'Invalid SSH user'; exit 1; }
[[ $port =~ ^[0-9]+$ ]] && (( port > 0 && port < 65536 )) || { echo 'Invalid SSH port'; exit 1; }
[[ $domain =~ ^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo 'Invalid domain'; exit 1; }
[[ $sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA'; exit 1; }
if [[ -z ${DEPLOY_SSH_PRIVATE_KEY:-} && -z ${DEPLOY_SSH_PASSWORD:-} ]]; then
  echo '::error::Add ALIYUN_SSH_PRIVATE_KEY or ALIYUN_SSH_PASSWORD in repository Settings > Secrets and variables > Actions.'
  exit 1
fi
work=$(mktemp -d)
cleanup() { rm -rf "$work"; if [[ -n ${SSH_AGENT_PID:-} ]]; then ssh-agent -k >/dev/null; fi; }
trap cleanup EXIT
chmod 700 "$work"
if [[ -n ${DEPLOY_KNOWN_HOSTS:-} ]]; then
  printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$work/known_hosts"
else
  ssh-keyscan -T 15 -p "$port" "$host" > "$work/known_hosts"
fi
[[ -s $work/known_hosts ]] || { echo '::error::SSH host key could not be retrieved. Check port 22 and the Alibaba Cloud security group.'; exit 1; }
ssh_options=(-o "UserKnownHostsFile=$work/known_hosts" -o StrictHostKeyChecking=yes -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=6)
auth=()
if [[ -n ${DEPLOY_SSH_PRIVATE_KEY:-} ]]; then
  eval "$(ssh-agent -s)" >/dev/null
  ssh-add - <<< "$DEPLOY_SSH_PRIVATE_KEY"
  ssh_options+=(-o BatchMode=yes)
else
  if ! command -v sshpass >/dev/null; then sudo apt-get update -qq; sudo apt-get install -y sshpass; fi
  export SSHPASS=$DEPLOY_SSH_PASSWORD
  auth=(sshpass -e)
  ssh_options+=(-o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no)
fi
if [[ ${DEPLOY_MODE:-deploy} == inspect ]]; then
  "${auth[@]}" ssh "${ssh_options[@]}" -p "$port" "$user@$host" 'bash -s' < deploy/inspect-host.sh
  exit 0
fi
cd .release
sha256sum -c mind-release.sha256
remote_dir=$("${auth[@]}" ssh "${ssh_options[@]}" -p "$port" "$user@$host" 'mktemp -d /tmp/mind-deploy.XXXXXXXX')
[[ $remote_dir =~ ^/tmp/mind-deploy\.[A-Za-z0-9]{8}$ ]] || { echo 'Invalid remote temporary directory'; exit 1; }
remote_archive="$remote_dir/mind-release.tar.gz"
remote_script="$remote_dir/remote-install.sh"
"${auth[@]}" scp "${ssh_options[@]}" -P "$port" mind-release.tar.gz "$user@$host:$remote_archive"
"${auth[@]}" scp "${ssh_options[@]}" -P "$port" ../deploy/remote-install.sh "$user@$host:$remote_script"
if [[ -n ${E2B_API_KEY:-} ]]; then
  python3 - "$work/e2b-settings.json" <<'PYCONFIG'
import os,sys,json
value=os.environ['E2B_API_KEY']
if not value or len(value)>1000 or any(c.isspace() for c in value):raise SystemExit('Invalid E2B credential format')
with open(sys.argv[1],'w') as file:json.dump({'E2B_API_KEY':value,'E2B_TEMPLATE_ID':os.environ.get('E2B_TEMPLATE_ID','')},file)
os.chmod(sys.argv[1],0o600)
PYCONFIG
  "${auth[@]}" scp "${ssh_options[@]}" -P "$port" "$work/e2b-settings.json" "$user@$host:$remote_dir/e2b-settings.json"
fi
printf -v command '%q ' bash "$remote_script" "$remote_archive" "$domain" "$sha"
"${auth[@]}" ssh "${ssh_options[@]}" -p "$port" "$user@$host" "$command"
curl --fail --silent --show-error --retry 5 --retry-delay 5 --max-time 20 "https://$domain/healthz" > "$work/health.json"
python3 - "$work/health.json" "$sha" <<'PY'
import json,sys
data=json.load(open(sys.argv[1]))
assert data.get('status')=='ok' and data.get('agent') is True and data.get('release')==sys.argv[2], 'Live release verification failed'
print('Verified HTTPS release:',data['release'])
PY
printf '### Deployment succeeded\n\nURL: https://%s\n\nCommit: `%s`\n' "$domain" "$sha" >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
