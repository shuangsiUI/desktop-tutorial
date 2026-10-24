# 初始化、迁移与部署

## 本机运行

使用Node.js 24+，在项目根目录执行：

```bash
npm run user:create -- --username your-admin --role admin
npm run dev
```

初始化命令会要求两次输入密码（不回显，至少15个字符），无默认账号密码。客户账号必须由管理员绑定已建档且启用的客户。管理端“系统 → 账号权限”可创建员工或客户账号、调整角色及停用账号。

客户端与后台都先登录，入口为`http://127.0.0.1:4188/login`。退出或修改密码会撤销会话。密码遗忘目前需服务器运维处理，不提供匿名重置接口。

自动化环境可通过短期`FBA_INITIAL_PASSWORD`环境变量给初始化命令传值。不要写入版本控制、命令示例或长期服务环境文件。

## 旧数据迁移

首次安全升级遇到已有业务数据时，在原数据库旁创建`*.before-security-时间.sqlite`快照，再执行版本化迁移。备份仍含敏感业务资料，权限为600，不提供Web下载。迁移幂等，失败事务回滚；不会清空订单。

旧记录不会自动授权给客户。0.8.1增加关联组原子分配：关联旧运单与账单使用“客户管理 → 分配旧数据”（POST /api/admin/record/assign-group），携带完整关联组、版本和原因；遗漏关联则整组回滚。无关联记录可按原流程处理。管理员先建客户资料，再分配归属：运单使用操作录入，账单使用分配客户；资料可通过`POST /api/admin/record/assign`提交`module,id,version,customerId`，预约地址需要先归属同一客户。

## 备份与恢复

```bash
npm run db:backup
```

生成`data/backups/`下SQLite一致性快照。备份目录应在服务器上使用独立的访问控制、加密及异地备份策略。仅复制正在写入的SQLite主文件可能遗漏WAL内容，因此使用上述快照。

恢复必须由运维停服务、保留当前数据库及WAL/SHM文件、核对备份后再替换；先在隔离环境验证完整性、账号与租户归属，再恢复流量。本项目不会自动执行覆盖恢复。

## HTTPS服务器部署

1. 创建单独的低权限运行用户，将代码放到`/opt/fba-logistics`，只有`data/`允许服务写入。
2. 用实际域名填写`.env.example`所示配置，保存到权限受限的`/etc/fba-logistics.env`。程序不自动读取工作区`.env`文件，由服务管理器提供环境变量。
3. 安装有效TLS证书，按`deploy/nginx.conf.example`配置反向代理。必须覆盖转发头，不能信任任意来源的`X-Forwarded-For`或`X-Forwarded-Proto`。
4. 后端保持监听127.0.0.1，`PUBLIC_ORIGIN`设置为外部HTTPS域名，`TRUSTED_PROXY_IPS`只填反向代理的真实来源IP。生产模式直接HTTP访问会被拒绝，Cookie带Secure属性。
5. 核对Node可执行文件位置与版本，使用`deploy/fba-logistics.service.example`作为systemd示例；安装前按服务器路径调整。
6. 创建管理员、完成客户归属分配，运行`npm test`；验证匿名401、客户越权404、缺少CSRF的写入403、退出后会话失效，以及备份恢复。

这些是部署模板，当前没有实际部署到任何公网服务器，也不包含TLS证书、外部接口密钥或生产账号。

## 0.8 升级与生产验收

商业关系迁移前另存 `*.before-commercial-时间.sqlite`。若旧数据客户归属不一致或关联不存在，商业迁移回滚；保留原库及快照，由有权限人员核对数据。不要删库重建来绕过检查。历史未收只记期初应收，不生成虚假的到账记录。

1. 通过密钥管理器分别生成两个独立的随机32字节Base64密钥，配置 `MFA_ENCRYPTION_KEY` 与 `BACKUP_ENCRYPTION_KEY`。不要使用示例密码、不要复用密钥，离线保管恢复材料。生产缺少MFA密钥时拒绝启动。
2. 为每位员工绑定本人验证器，CLI环境需要由运维安全注入对应MFA密钥（不自动加载.env）。至少两名不同员工，商业申请不能自审：

```bash
npm run user:mfa -- --username your-admin --reason 首次绑定本人验证器
```

遗失设备时，运维核验身份后用 `--replace --reason 重置原因` 重新绑定。会话立即撤销，没有匿名MFA绕过接口。服务器应保持时钟同步。备份恢复时必须同时恢复对应密钥，否则无法解密验证器密钥。

3. 配置 `BACKUP_REMOTE_DIR` 为独立主机/对象存储挂载目录。把 `deploy/fba-backup.service.example`、`.timer.example`、`fba-monitor` 和 `fba-alert@` 模板按实际路径安装。模板每天备份、每15分钟检查。调整权限和挂载路径后由运维启用服务；代码交付不代表已经安装定时器。
4. 备份任务先做数据完整性及应收对账，再生成一致性快照，以流式AES-GCM加密，恢复到独立临时文件验证，复制并校验副本后才写成功标记。生产任务缺少加密或副本配置会失败。本地保留期默认30天，异地保留由存储生命周期独立管理。
5. 将 systemd 失败日志转到实际有人接收的告警渠道，并做一次失败告警演练。默认 `logger` 示例只写系统日志，不等于已发微信/短信通知。

```bash
npm run db:check
npm run db:backup
npm run db:restore-check -- /path/to/backup.enc
npm run ops:check
# 只导出到独立的新文件，拒绝覆盖运行库或已有文件
npm run db:restore-export -- /path/to/backup.enc /path/to/restored-new.sqlite
```

导出的恢复库含敏感数据，权限600；输出后由运维停止流量和服务，保留原数据库及WAL/SHM，再按恢复预案切换并验证。工具不会替你覆盖运行库。记录实际RPO/RTO，确认旧会话、账号、租户和账务一致性后再恢复流量。

本轮支持单实例部署；不要让多个容器各自使用独立SQLite副本处理同一业务。跨主机高可用需另做数据库及共享会话/限流设计。最终放行标准见[0.8交付说明](RELEASE-0.8.md)。

0.8.1的归属外键迁移另存 `*.before-ownership-时间.sqlite`，采用事务提交时检查的组合外键，让旧关联组能够原子分配，同时拒绝单条越过归属约束。
