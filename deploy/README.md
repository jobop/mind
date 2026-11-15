# GitHub Actions → 阿里云

项目仓库：`jobop/mind`。部署域名：`https://mind.made-world.link`，服务器 `47.90.84.89`，SSH 默认端口 22。

## 首次设置

在仓库 **Settings → Secrets and variables → Actions → New repository secret** 中配置下面一种凭据：

- `ALIYUN_SSH_PASSWORD`：服务器 SSH 密码；或
- `ALIYUN_SSH_PRIVATE_KEY`：已被服务器授权的 OpenSSH 私钥。两者都设置时优先使用私钥。

凭据仅通过 GitHub Secrets 注入，仓库和产物不包含服务器密码、模型 Key、部署私钥或加密数据目录。工作流使用密码时通过 sshpass 的环境变量/标准输入认证，不把密码写进 SSH 参数。可选 `ALIYUN_KNOWN_HOSTS` 存放从可信连接获得的 SSH known_hosts 行；未提供时会在运行期间获取主机公钥，并在该次连接中启用严格主机校验。

可选 Repository Variables（不设置时使用本项目默认值）：

| 名称 | 默认值 |
| --- | --- |
| ALIYUN_HOST | 47.90.84.89 |
| ALIYUN_USER | root |
| ALIYUN_PORT | 22 |
| MIND_DOMAIN | mind.made-world.link |

服务器初始化支持 **Ubuntu/Debian + systemd + Nginx**；当前实际服务器为 **CentOS 7 + Caddy**，会自动沿用已有 `/opt/node22/bin/node`（已确认 v22.20.0）及 Caddy，不升级系统 Node 或替换其他站点。SSH 账户需要 root，或由运维调整为等价的受限部署方式。阿里云安全组和服务器防火墙需允许 22、80、443；业务进程仅监听本机 3180。

## 执行

进入 **Actions → CI and deploy to Alibaba Cloud → Run workflow**，选择 `main` 和服务器架构（通常为 `x64`；ARM 机器选择 `arm64`）。

推送 main 或创建 PR 只执行测试；**手动 Run workflow 才部署**。非 main 分支不会获得部署步骤。工作流在同一个 Runner 中安装锁定依赖、构建和执行测试，再打包 Node.js、Pi SDK 及全部运行依赖，经 SCP 直接传包并使用 SSH 部署，不占用 GitHub Artifacts 存储。服务器不需要自行访问 npm 或 GitHub 下载应用依赖。

Ubuntu/Debian 首次部署会安装 Nginx、Certbot；当前 CentOS 7 分支直接使用现有 Caddy 的证书管理。两者均创建专用服务账户 `mind-app` 并配置 systemd。域名 DNS 和公网 80/443 可达是证书签发的前提。若目标域名已有另一份 Nginx 配置或已有非本项目的 mind.service，部署会停止，保留原配置供人工合并。

## 服务器布局

- `/opt/mind/releases/<commit-sha>`：不可变发布文件，含 Node.js 和依赖。
- `/opt/mind/current`：当前发布软链接。
- `/opt/mind/backups/`：每次部署前的应用服务和 Nginx 配置备份。
- `/var/lib/mind/encryption-key`：跨发布持久保存的连接加密密钥，归专用服务账户所有。
- `/etc/mind/mind.env`：生产环境设置；追加的其他配置会在升级时保留。
- `/etc/systemd/system/mind.service`：自动启动与失败重启。
- 当前服务器：`/etc/caddy/mind-sites/mind.made-world.link.caddy` 为专用路由，并从现有 Caddyfile 导入；保留其他站点，使用 100ms 正向刷新间隔以兼顾进度和取消。
- Ubuntu/Debian：`/etc/nginx/conf.d/mind.made-world.link.conf` 为专用 HTTPS 反向代理。

发布过程先验证新服务的 `/healthz` 与提交 SHA，再配置和验证 HTTPS。失败时恢复上一发布软链接、服务配置和 Nginx 文件；应用的持久加密密钥不会被发布包覆盖。历史发布保留，便于排查或回退；本脚本不自动清理历史版本。

最终健康接口 `https://mind.made-world.link/healthz` 返回 `status: ok`、`agent: true` 和部署提交 SHA。Actions 只有在核对这些值后才报告部署成功。

## 运维

```sh
systemctl status mind.service
journalctl -u mind.service -n 100 --no-pager
nginx -t
systemctl status certbot.timer
```

生产模式通过 `PUBLIC_ORIGIN=https://mind.made-world.link` 校验 Host 和请求来源，保留 Secure、HttpOnly Cookie。导图仍保存在使用者浏览器，模型凭据由使用者在页面自行配置；从 localhost 切换到线上域名时需通过 JSON 导入原导图。
