#!/usr/bin/env bash
set -uo pipefail
python3 - <<'PY'
import os,json,subprocess,urllib.request,re
def command(args):
 try:
  p=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,universal_newlines=True,timeout=10)
  return {'code':p.returncode,'out':p.stdout.strip()[:2500],'error':p.stderr.strip()[:500]}
 except Exception as e:return {'error':str(e)}
result={'kernel':command(['uname','-r']),'node':command(['node','--version']),'docker':command(['docker','--version']),'docker_service':command(['systemctl','is-active','docker']),'caddy_version':command(['caddy','version'])}
pids=command(['pgrep','-x','node']).get('out','').splitlines()
result['active_node_runtimes']=[]
for pid in pids[:10]:
 try:
  path=os.readlink('/proc/'+pid+'/exe')
  result['active_node_runtimes'].append({'path':path,'version':command([path,'--version'])})
 except Exception:pass
start=command(['systemctl','show','caddy','--property=ExecStart']).get('out','')
match=re.search(r'--config(?:=|\s+)([^ ;}]+)',start)
result['caddy_config_path']=match.group(1) if match else None
try:
 data=json.load(urllib.request.urlopen('http://127.0.0.1:2019/config/',timeout=10))
 servers=data.get('apps',{}).get('http',{}).get('servers',{})
 result['caddy_servers']={name:{'listen':v.get('listen',[]),'routes':len(v.get('routes',[]))} for name,v in servers.items()}
 matches=[]
 def walk(value,path):
  if isinstance(value,dict):
   if any('mind.made-world.link' in m.get('host',[]) for m in value.get('match',[]) if isinstance(m,dict)):
    upstreams=[]
    def collect(v):
     if isinstance(v,dict):
      if v.get('handler')=='reverse_proxy':upstreams.extend(u.get('dial') for u in v.get('upstreams',[]))
      for child in v.values():collect(child)
     elif isinstance(v,list):
      for child in v:collect(child)
    collect(value);matches.append({'path':path,'upstreams':upstreams})
   for key,child in value.items():walk(child,path+'/'+str(key))
  elif isinstance(value,list):
   for i,child in enumerate(value):walk(child,path+'/'+str(i))
 walk(servers,'/apps/http/servers')
 result['target_domain_routes']=matches
except Exception as e:result['caddy_admin_error']=str(e)
print(json.dumps(result,ensure_ascii=False,indent=2))
PY
