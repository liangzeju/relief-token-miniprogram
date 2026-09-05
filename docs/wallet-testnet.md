# MetaMask 与 Monad 测试网资金池

## Monad Blitz 测试网演示模式

比赛演示使用 `NODE_ENV=staging`，不是生产模式。后端只允许连接 Monad Testnet（Chain ID 10143），并通过显式配置打开钱包原型写操作：

```text
RELIEF_ENABLE_LEGACY_DEMO=false
RELIEF_ENABLE_WALLET_PROTOTYPE=true
MONAD_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_WALLET_RPC_URL=https://testnet-rpc.monad.xyz
MONAD_CONFIRMATIONS=2
PUBLIC_BASE_URL=https://<public-host>
CORS_ORIGIN=https://<public-host>
```

不要设置伪造的 `MONAD_CONTRACT_ADDRESS`。合约部署完成后，以 `MONAD_POOL_ADDRESS` 和 `MONAD_START_BLOCK` 保存经过字节码、运行时代码和确认数核验的真实地址与部署区块。管理端的“释放已分配任务资金”会生成 `releaseTask(bytes32,uint256)` 交易，收款地址以链上任务配置为准，后端不会接受客户端传入的收款地址。

## 一次性设置

1. 安装后端依赖并运行根目录 `start.ps1`。前台和后台必须使用同一服务地址，例如 `http://localhost:8787`。
2. 在安装了 MetaMask 扩展的 Chrome 或 Edge 中打开 `/admin/#wallet-admin`。内置预览浏览器不一定注入扩展，未检测到钱包时应改用上述浏览器。
3. 管理员访问令牌由后端首次启动时自动生成，文件为 `backend/data/wallet/admin-access-token.txt`；配置 `DATA_DIR` 时位于该目录下的 `wallet` 子目录。只在管理端令牌框中使用，不公开、不放到前端源码、不发送私钥或助记词。可用至少 32 字符的 `RELIEF_ADMIN_TOKEN` 环境变量替代。
4. 验证管理权限，连接 MetaMask。钱包会请求切换或添加 Monad Testnet：chain ID `10143`，原生币 `MON`，RPC `https://testnet-rpc.monad.xyz`。
5. 使用测试网水龙头获取测试币，然后点击“部署救灾资金池合约”，在 MetaMask 中检查并确认交易。交易 Gas 由当前钱包支付；本项目不保存私钥，不代替用户签名。
6. 后端等待至少 2 个确认，核验创建交易、owner、运行字节码后保存合约地址。刷新中断时可通过已保存的部署交易哈希恢复核验，不需要重复部署。
7. 在“链上救援任务配置”选择已核验任务，填写用途、紧急程度、目标 MON、实际测试收款钱包，签名保存。配置交易确认后可在两端看到该任务的链上资金需求。

所有地址和交易都属于测试网，不用于真实救灾资金。尚未部署时余额为 0，页面明确显示“尚未部署”；不能用旧演示合约地址或伪交易哈希启用资金池。

## 用户捐赠

1. 前台首页点击 MetaMask 入口，注册或登录，签名绑定钱包。签名包含站点、账户、钱包、chain ID、一次性 nonce 和过期时间，不是转账授权。
2. 选择 MON 数量与捐赠用途，查看预计任务分配，再主动确认钱包交易。金额最多支持 18 位小数，不使用浮点数进行账本计算。
3. 钱包返回交易哈希后只登记交易，不增加资金池余额。后端扫描已确认合约事件后，才增加前台资金池、个人捐赠记录和后台捐赠台账。
4. 后台按合约地址从部署区块持续补扫事件；即使浏览器关闭、提交哈希请求失败，已发送且匹配登记的钱包交易仍能被发现。重复提交或服务重启不会重复入账。
5. 我的捐赠中显示具体任务去向及区块浏览器交易链接。未分配部分保留在池内，捐赠人可签名退回；有新的匹配任务时可签名继续分配。已分配部分不可按未分配退款接口取回。

## 分配规则与链上记录

用途枚举：0 不限用途、1 饮水食品、2 医疗物资、3 安置装备、4 救援服务、5 灾后重建。任务用途必须是 1 至 5，紧急程度为 3 紧急、2 优先、1 常规。

捐赠仅匹配启用且存在资金缺口的任务。限定用途只匹配同类任务；不限用途可匹配全部。按紧急程度降序、同级按链上任务登记顺序分配，填满一个缺口后继续下一个，最多支持 32 个任务。预览仅供检查，最终以交易执行时的任务状态与事件为准。

`donate` 在同一交易中托管原生 MON 并发出 `DonationReceived`、`DonationAllocated`、`DonationUnallocated`。每笔分配包含捐赠 ID、任务 ID 和 wei 金额；任务 ID 为业务任务编号的 keccak256。后端保留注册资料快照，与捐赠 ID 关联；公共 API 不含姓名或邮箱。

资金分配是链上记账与托管，不等于线下物资已采购或救援服务已履约。合约 `releaseTask` 只允许 owner 向任务预先配置的钱包拨付已分配余额，发出 `TaskReleased`；后台索引拨付后同步减少余额。当前自动化只负责按规则分配，不自动把款转给外部收款方。履约验收、商城付款及 PDF 项目证书的旧演示流程未与本合约完成生产级整合。

## 实时性和故障

- 后端每约 2 秒拉取确认区块，浏览器使用 SSE 变化通知并每 5 秒轮询兜底。显示的是已确认数据，不是钱包中的 pending 余额。
- RPC 故障会保留上次确认的记录并提示失联，超过可用状态时停止生成新捐赠交易；不会用演示数据兜底。
- 检测链重组后从部署区块重建账本，撤销不再存在的入账与分配。捐赠事件按交易哈希及日志索引去重。
- 用户账户、管理员令牌与账本分文件持久化到 `DATA_DIR/wallet`；会话在内存中保存，重启后需要重新登录。
- 数据目录必须由单个后端进程独占。生产部署前应迁移事务数据库、持久会话、备份和监控，并完成智能合约独立审计。不可直接以本地 JSON 服务承载生产资金。
- 当前注册邮箱标记为“未验证”。邮箱认证、身份核验及完整 KYC 需另接邮件和身份服务。

## 可选环境变量

| 变量 | 作用 |
| --- | --- |
| `PORT` | 默认 8787 |
| `PUBLIC_BASE_URL` | 浏览器实际访问源，例如 `http://localhost:8787`；用于挑战和 Origin 校验 |
| `DATA_DIR` | 业务数据目录；钱包数据放在其 `wallet` 子目录 |
| `RELIEF_ADMIN_TOKEN` | 至少 32 字符的管理员访问令牌；不设置则自动生成文件 |
| `MONAD_RPC_URL` | 后端 RPC，必须返回 chain ID 10143；可含服务商凭证，仅后端使用 |
| `MONAD_WALLET_RPC_URL` | 可公开的 MetaMask RPC URL；默认官方测试网地址 |
| `MONAD_CONFIRMATIONS` | 确认数，至少 2，默认 2 |
| `MONAD_POOL_ADDRESS` | 可选，已部署且与本项目字节码一致的合约地址；禁止替换已有账本的合约 |
| `MONAD_START_BLOCK` | 手动配置合约时必须指定其部署区块；网页部署会自动记录 |

环境变量由进程传入，不自动读取 `.env`。PowerShell 示例：`$env:PUBLIC_BASE_URL = 'http://localhost:8787'`。

仓库根目录提供 `render.yaml`。通过 Render Blueprint 创建服务时，平台会自动生成管理员令牌、挂载持久磁盘，并使用 Render 提供的 `RENDER_EXTERNAL_URL` 作为未显式配置时的公开站点地址和同源校验地址。管理员令牌只在 Render 密钥配置和管理端登录框中使用，不提交到 GitHub。

## 验证

在 `backend` 执行 `pnpm install --ignore-scripts` 安装开发依赖，然后执行：

```text
pnpm compile:contract
pnpm test:wallet
pnpm test:wallet-browser
pnpm test
```

合约及全链路测试在本地 Ganache EVM 上部署真实字节码并运行签名交易；浏览器测试使用测试钱包提供器。它们不表示已向公开 Monad 测试网部署，也不代替独立合约审计。公开测试网部署及交易必须由用户在 MetaMask 中确认。

官方参考：[Monad 网络资料](https://docs.monad.xyz/developer-essentials/network-information)、[MetaMask Provider API](https://docs.metamask.io/metamask-connect/evm/reference/provider-api/)、[EIP-6963](https://eips.ethereum.org/EIPS/eip-6963)。
