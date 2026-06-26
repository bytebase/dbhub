# Native SSH Tunnel Design

> Status: implemented (Phase 1)

When `ssh_host` matches a `Host` alias in `~/.ssh/config`, DBHub automatically delegates tunnel setup to the system `ssh` client instead of re-implementing ProxyJump chains in `ssh2`.

## Mode selection (automatic, no `ssh_mode` flag)

```
ssh_host set?
  └─ DBHUB_SSH_FORCE_SSH2=1? ──yes──► ssh2
  └─ looksLikeSSHAlias + parseSSHConfig match
     and no ssh_password and no ssh_proxy_jump?
        ├─ yes → native OpenSSH
        └─ no  → ssh2 (existing implementation)
```

| ssh_host | ~/.ssh/config | ssh_password | ssh_proxy_jump | Result |
|----------|---------------|--------------|----------------|--------|
| `mybastion` | match | no | no | **native** |
| `target-with-jump` | match | no | no | **native** |
| `mybastion` | match | yes | no | ssh2 |
| `mybastion` | no match | - | - | ssh2 |
| `bastion.example.com` | - | - | - | ssh2 |
| `target-with-jump` | match | no | yes | ssh2 |

Troubleshooting environment variables:

| Variable | Purpose |
|----------|---------|
| `DBHUB_SSH_BIN` | Path to `ssh` executable |
| `DBHUB_SSH_CONFIG` | Path to SSH config file |
| `DBHUB_SSH_FORCE_SSH2` | Force ssh2 mode |

## Example `~/.ssh/config`

```sshconfig
Host mybastion
    HostName bastion.example.com
    User ubuntu
    IdentityFile ~/.ssh/id_rsa

Host target-with-jump
    HostName 10.0.0.5
    User admin
    ProxyJump mybastion
```

## Example `dbhub.toml`

```toml
[[sources]]
id = "prod_pg"
dsn = "postgres://app_user:secure_password@10.0.1.100:5432/myapp_prod?sslmode=require"
ssh_host = "target-with-jump"
```

Equivalent to: `ssh -N -L 127.0.0.1:<port>:10.0.1.100:5432 target-with-jump`

OpenSSH resolves `ProxyJump mybastion` (including nested alias → `bastion.example.com`) and per-hop credentials.

## Limitations

- Native mode does not support `ssh_password` (BatchMode)
- Encrypted private keys require `ssh-agent` or `ssh-add`
- Requires the system OpenSSH client
