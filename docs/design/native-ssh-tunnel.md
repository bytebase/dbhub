# Native SSH Tunnel 设计方案

> 状态：已实现（Phase 1）  
> 日期：2026-06-26  
> 目标：当 `ssh_host` 为本机 `~/.ssh/config` 中可解析的别名时，**自动**委托 OpenSSH 客户端建立隧道。

## 1. 模式选择（纯自动，无 `ssh_mode` 配置项）

```
ssh_host 已设置?
  └─ DBHUB_SSH_FORCE_SSH2=1? ──yes──► ssh2
  └─ looksLikeSSHAlias + parseSSHConfig 有匹配
     且 无 ssh_password 且 无 ssh_proxy_jump?
        ├─ 是 → Native SSH（别名原样传给 ssh）
        └─ 否 → ssh2（现有 ssh2 实现）
```

| ssh_host | ~/.ssh/config | ssh_password | ssh_proxy_jump | 结果 |
|----------|---------------|--------------|----------------|------|
| `mtn03` | 有匹配 | 无 | 无 | **native** |
| `mtn03` | 有匹配 | 有 | 无 | ssh2 |
| `mtn03` | 无匹配 | - | - | ssh2 |
| `18.1.2.3` | - | - | - | ssh2 |
| `mtn03` | 有匹配 | 无 | 有 | ssh2 |

排障用环境变量（非用户常规配置）：

| 变量 | 作用 |
|------|------|
| `DBHUB_SSH_BIN` | 指定 `ssh` 可执行文件 |
| `DBHUB_SSH_CONFIG` | 指定 SSH config 路径 |
| `DBHUB_SSH_FORCE_SSH2` | 强制 ssh2 |

## 2. Native SSH 命令

```bash
ssh -N -F ~/.ssh/config \
  -L 127.0.0.1:{port}:{db_host}:{db_port} \
  -o ExitOnForwardFailure=yes -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  {hostAlias}
```

TOML 显式设置的 `ssh_user` / `ssh_key` / `ssh_port` / keepalive 作为 `-l` / `-i` / `-p` / `-o` 覆盖项传入。

## 3. 架构

```
ConnectorManager.connectSource()
    └─ resolveTunnelPlan(source)
           ├─ native → NativeSSHTunnel (spawn ssh)
           └─ ssh2   → SSHTunnel (ssh2 库)
```

公共接口：`SSHTunnelBackend`（`establish` / `close` / `getTunnelInfo` / `getIsConnected` / `getMode`）

## 4. 用户配置示例

```toml
[[sources]]
id = "mtn03_db"
dsn = "postgres://user:pass@10.100.100.100:5432/mydb"
ssh_host = "mtn03"
```

## 5. 实现文件

| 文件 | 说明 |
|------|------|
| `src/utils/ssh-tunnel-resolver.ts` | 自动模式决策 |
| `src/utils/native-ssh-tunnel.ts` | Native 隧道 |
| `src/utils/get-free-port.ts` | 本地端口分配 |
| `src/utils/wait-for-port.ts` | 端口就绪检测 |
| `src/connectors/manager.ts` | 接入 |

## 6. 限制

- Native 模式不支持 `ssh_password`（BatchMode）
- 加密私钥需 `ssh-agent` 或 `ssh-add`
- 依赖系统 OpenSSH 客户端
