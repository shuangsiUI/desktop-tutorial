# 安全说明

0.6及更早版本为无账号权限的本机原型，不应直接暴露到公网。0.7加入身份认证、角色授权、客户数据范围、CSRF、请求和登录限流、会话撤销、密码哈希、审计与HTTPS生产配置校验。

密码使用独立随机盐和scrypt（N=32768,r=8,p=3）；会话为256位随机值，数据库只保存会话令牌的SHA-256，不向浏览器localStorage存放令牌。Cookie使用HttpOnly、SameSite=Strict，HTTPS配置启用Secure。绝对有效期8小时，30分钟无活动过期，每账号最多保留5个会话。

Excel解析升级为官方SheetJS0.20.3，使用Worker隔离解析并限制执行时间，上传文件最大5MB，ZIP目录声明解压量最大32MB，最多2000行/100票，拒绝公式和异常容器。后端再次校验业务数据。它不等于完整恶意文件检测或病毒扫描。

发现漏洞请联系仓库维护者，勿在公开Issue贴真实密码、客户记录、会话Cookie或生产凭证。代码公开不代表线上环境应该公开数据。

参考：[OWASP密码存储](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)、[OWASP会话管理](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)、[SheetJS官方发行说明](https://docs.sheetjs.com/docs/getting-started/installation/standalone/)。

已实现与仍未覆盖的部分见[架构说明](docs/ARCHITECTURE.md)，部署前见[初始化与部署](docs/DEPLOYMENT.md)。未经独立渗透测试和实际服务器验收，不承诺“绝对安全”或“可直接生产上线”。

## 0.8新增控制

生产员工登录强制TOTP，密钥使用独立MFA_ENCRYPTION_KEY加密，验证码防重放；启用或重置由受控服务器CLI完成并撤销会话。默认开发模式不强制员工启用，但一旦绑定仍要求验证码。

核心客户归属及关联由数据库约束再次验证。收款凭证要求原银行流水，核销和退款关联原收款；过账分录不可更改，退款与锁定数据更正必须另一人审核。成功登录不再清除IP失败计数。生产环境停用旧版业务API。

备份支持独立密钥加密、校验副本与恢复检查；密钥不能放进代码仓库，副本目录须由运维确认真正异地。安全测试通过不构成独立渗透测试或生产认证；详见[0.8交付说明](docs/RELEASE-0.8.md)。
