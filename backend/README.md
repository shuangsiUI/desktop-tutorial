# 后端工程

进程入口为仓库根目录`server.mjs`，实际实现都在本目录。根目录原`.mjs`文件保留兼容导出，客户端资源在`public/`，不是后端代码。

- `application.mjs`：HTTP应用组合、请求安全边界、静态资源白名单与生命周期。
- `config.mjs`：环境配置及生产HTTPS、MFA密钥校验。
- `http/`：管理员、客户、旧版接口适配与受限JSON读取。
- `security/`：角色策略、scrypt密码哈希、会话、CSRF及加密TOTP。
- `persistence/`：关系约束迁移、客户范围仓储、SQL分页、事务和审计上下文。
- `modules/`：运单、资料、财务、运营及商业审批实现。
- `cli/`：账号/MFA初始化、加密备份、恢复导出、完整性/运维检查和隔离容量验证。

运行、验证与限制见根目录README和docs/ARCHITECTURE.md。没有单独运行的Java后端，也没有把敏感数据库逻辑放到浏览器执行。

`modules/commercial/ledger.mjs`写入不可变借贷凭证，`guards.mjs`处理信用放行与锁单，`service.mjs`处理锁价、收退款及双人审核。`operations/`负责完整性对账、流式备份和运行状态。具体默认规则见[业务规则](../docs/COMMERCIAL-RULES.md)。
