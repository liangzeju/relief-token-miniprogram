# 救灾资金与资源协同平台：链上优先后端架构

> 历史设计，非当前实施基线：本文人民币收款/兑付、组织无需钱包及旧费用模型已被最新用户决策替代。当前规则见 [决策记录](decision-log.md)，工作范围见 [修复实施清单](repair-roadmap.md)。保留原文追溯，不表示旧流程仍需实现。

> 版本：MVP 2.0 设计稿  
> 状态：核心业务已确认；运营主体资质、兑换规则参数和部署配置待复核  
> 适用范围：人民币捐赠到账、原生 MON 托管与水印、灾情任务、资源响应、合同托管、交付验收、结算兑付和 Monad 审计

## 1. 目标和边界

平台的业务目标是让捐赠者能够查询完整的资金去向：

```text
人民币到账
  → 合规审核
  → 平台取得/预存 MON，并在 Monad 托管合约登记 donation lot
  → 进入资金池
  → 分配到已批准的灾情任务
  → 锁定到合同托管
  → 物资交付/救援队进场
  → 现场验收
  → 按实际完成量结算
  → 组织按版本化兑换规则申请人民币
  → Monad 锁定待兑换 MON
  → 银行/支付机构兑付人民币
  → 兑付成功后 Monad 结算/释放 MON，标记 WatermarkFinished
```

Monad 的原生资产是 MON，平台不能铸造新的 MON。平台负责人民币收款、合规审核、通过合规渠道取得或预存 MON，并将真实 MON 存入 NativeMonEscrow；每笔存入与 donation lot、水印和用途政策关联。平台与组织签署合同，组织验收完成后按版本化兑换规则申请人民币。兑付后 MON 从 Escrow 结算/释放至平台流动性地址，并记录支付回执和最终水印。人民币支付、身份和原始证据保留在链下并通过哈希关联。移动端只负责展示和发起操作，管理端按角色提供审批与审计界面；两端都不能保存私钥、直接转账或直接修改业务状态。

## 2. 总体架构

```text
    移动 Web（HTML5）
    │ HTTPS + 登录态 + 幂等键
    ▼
API Gateway / BFF
    ├─ Identity & Access（用户、机构、角色、权限）
    ├─ Donation Service（捐赠订单、到账、KYC、用途政策）
    ├─ Disaster Service（灾情上报、核验、任务审批）
    ├─ Resource Service（供应商/救援队资质、响应方案、评审）
    ├─ Contract Service（合同、预算、交付批次、验收、结算）
    ├─ Compliance Service（制裁/AML、规则引擎、人工复核）
    ├─ Evidence Service（文件、图片、凭证、哈希）
    ├─ Ledger Service（链下双重记账和链上余额镜像）
    └─ Audit Service（不可变审计日志）
              │
              ├─ PostgreSQL：业务主数据
              ├─ Object Storage：合同和现场证据
              ├─ Queue/Event Bus：异步任务和回执
              └─ Chain Adapter
                    ├─ Relayer/HSM/Multi-sig
                    ├─ Monad Testnet/Mainnet
                    └─ Chain Indexer/Reconciler
```

### 数据真相边界

- 业务流程和审批真相：后端数据库，但每次关键状态变化必须有审计事件。
- MON 资产真相：Monad NativeMonEscrow。所有 MON 存入、预算分配、托管、释放、兑换锁定、退款和结算都必须产生 Monad 交易；后端只保存镜像、业务关联和交易状态，不能私自改写链上余额。
- 水印追踪真相：Monad WatermarkRegistry 事件日志和交易回执。Indexer 从 Monad 重建 donation lot 的父子血缘，捐赠者查询时优先展示链上交易哈希、区块和事件。
- MON 余额和 Gas：由平台 Relayer/多签钱包管理；业务人员不应被要求购买 MON 才能操作 Web 端。
- 人民币到账真相：银行/支付机构回调和财务对账文件。
- 合同、照片、身份证明：链下加密存储；链上只放内容哈希和业务 ID。
- 页面缓存：仅用于离线展示，绝不能作为正式账本。

### MON 钱包模型

平台需要为 Relayer/多签钱包准备 MON 支付 Gas，并通过受控地址或流动性渠道取得业务所需 MON。组织和捐赠者不必为了使用 Web 端而购买 MON。

首期建议采用平台托管模型：

```text
捐赠者/组织不直接持有 MON 私钥
        ↓
平台受控地址 / NativeMonEscrow 合约持有链上 MON
        ↓
后端按组织、捐赠单和合同维护可审计的子账
        ↓
组织验收后提交人民币兑换申请
```

这样符合“MON 仅在平台业务托管范围内流转”和“平台负责托管”的定位。MON 是可替代资产，水印由 lot 账本维护；MON 离开 Escrow 后不能仅凭余额证明其来源。若未来要求组织自持 MON，则需要增加钱包白名单、签名、Gas 代付、密钥恢复和转账监管。

## 3. 角色和权限模型

权限采用“机构 + 角色 + 资源范围”三维模型。所有写操作由后端鉴权，前端隐藏按钮不算权限控制。

| 角色 | 核心权限 | 禁止事项 |
|---|---|---|
| 捐赠者 | 创建捐赠订单；查看本人/本机构资金、合同和审计流 | 不能铸币、分配预算、验收或结算 |
| 上报员 | 创建灾情上报；上传现场证据；补充任务信息 | 不能正式批准任务 |
| 官方核验员 | 核验、驳回、临时批准或正式批准任务 | 不能审批自己上报的任务 |
| 调度员 | 发布资源需求；查看认证资源；提出中选方案 | 不能单独完成最终付款 |
| 采购/合同审批员 | 审批中选方案和合同；确认预算锁定 | 不能验收自己审批的合同 |
| 供应商/救援队组织 | 维护本机构资料；提交响应；上传履约材料；验收后按规则申请人民币兑换 | 不能修改审核结果、验收结果或直接转移 MON |
| 现场验收员 | 创建交付批次；验收数量、质量和凭证 | 不能修改合同单价或释放资金 |
| 财务结算员 | 复核验收；按兑换规则发起人民币兑付；确认 MON 结算/释放 | 不能代替现场验收 |
| 合规员 | KYC/KYB、AML、冻结/解冻、人工复核 | 不能绕过审批直接签约 |
| 审计/监管只读 | 查看脱敏业务、审计日志、链上交易和证据哈希 | 不能写业务数据 |
| 平台管理员 | 配置字典、角色授权、系统运维 | 不能单独使用资金管理权限 |
| 链上运营员 | 提交已批准的链上交易、查看回执 | 不能改变业务审批结论 |

### 必须实现的权限约束

1. 同一人员不能同时担任任务审批人和该任务的验收人。
2. 同一人员不能同时担任合同审批人和最终结算复核人。
3. 供应方只能读取本机构的响应、合同和付款状态。
4. 捐赠者只能读取归属于本人/本机构的资金；公开透明页只能展示脱敏数据。
5. 紧急临时批准必须设置审批理由、有效期和事后复核任务。
6. 资金冻结、解冻、MON 存入、结算和释放均要求双人复核或多签策略。

## 4. 端到端业务流程

### 4.1 捐赠到账和 MON 存入

```text
POST /v1/donations
  创建捐赠订单，状态 PAYMENT_PENDING
        ↓
支付机构/银行回调到账（必须验签、去重）
        ↓
KYC/AML/用途审核
        ├─ REJECTED：拒绝并原路退款/人工处理
        ├─ MANUAL_REVIEW：进入合规人工复核
        └─ APPROVED：生成 MON acquisition/deposit intent
                    ↓
平台通过合规渠道取得 MON，Relayer 调用 NativeMonEscrow.depositMon(...)
                    ↓
等待 Monad receipt + confirmations
                    ↓
状态 MON_DEPOSIT_CONFIRMED，记录 depositTxHash、区块号、amountMon 和事件索引
```

禁止“提交表单后立即显示已获得 MON”。只有人民币到账、合规通过、MON 取得/存入交易确认、价格快照和数量对账完成后，才显示为可调度 MON 余额。MON/CNY 价格、来源、滑点和风险准备金必须留痕。

### 4.2 灾情任务

```text
REPORTED → VERIFYING → TEMPORARY_APPROVED / APPROVED / REJECTED
                         ↓
                      DISPATCHING
                         ↓
                      EXECUTING
                         ↓
                      COMPLETED / CANCELLED
```

任务应保存紧急等级、位置、需求数量、来源、核验机构、审批理由、有效期和证据哈希。生命救援允许临时批准，但必须生成事后复核待办。

### 4.3 资源响应和中选

```text
认证资源池
    ↓
供应商/救援队提交响应方案（RESPONSE_SUBMITTED）
    ↓
系统计算推荐分（仅推荐，不自动中标）
    ↓
调度员提出候选方案（SHORTLISTED）
    ↓
采购/合同审批员确认并填写理由（AWARDED）
    ↓
生成合同和预算锁定意图
```

供应商和救援队的认证状态来自后台/KYB 结果，不允许由移动端开关伪造。响应方案需要保存版本，截止时间后不可修改。

### 4.4 合同、交付和结算

```text
DRAFT
  → PENDING_APPROVAL
  → APPROVED
  → FUNDS_RESERVED（Monad EscrowCreated 已确认）
  → IN_PROGRESS
  → PARTIALLY_DELIVERED
  → PENDING_ACCEPTANCE
  → ACCEPTED / REJECTED / DISPUTED
  → PENDING_SETTLEMENT
  → PARTIALLY_SETTLED / SETTLED
  → REDEMPTION_REQUESTED
  → MON_REDEMPTION_LOCKED
  → PAYOUT_PENDING
  → PAYOUT_CONFIRMED
  → MON_SETTLED
```

旁路状态：`CANCELLED`、`DEFAULTED`、`REFUNDED`。

合同不能只保存一个百分比。每次交付都要创建 `delivery_batch`，保存计划数量、交付数量、验收数量、不合格数量、凭证哈希和验收人。

结算公式默认是：

```text
实际验收数量 × 合同单价
+ 经批准的运输/服务附加费
- 质量扣款/违约扣款
= 本批可结算金额
```

## 5. 核心数据模型

以下是后端必须存在的聚合，不要求一开始就拆成微服务，但表和领域边界要先按此设计。

| 聚合 | 关键字段 |
|---|---|
| `users` | user_id、微信 openid、实名状态、风险状态 |
| `organizations` | org_id、名称、统一社会信用代码、机构类型、认证状态 |
| `memberships` | user_id、org_id、role、scope、有效期 |
| `donations` | donation_id、donor_org_id、fiat_amount、currency、payment_ref、status |
| `fund_policies` | donation_id、允许任务类型/物资/地区、有效期、policy_hash |
| `fund_accounts` | fund_id、donation_id、deposited_mon、available_mon、reserved_mon、settled_mon、refunded_mon、onchain_account |
| `ledger_entries` | entry_id、fund_id、contract_id、type、amount、balance_after、operator |
| `tasks` | task_id、来源、灾情、位置、等级、需求、verification_status、status |
| `resource_profiles` | org_id、供应商/救援队类型、资质、证书哈希、有效期 |
| `resource_responses` | response_id、task_id、org_id、数量、价格、ETA、版本、status |
| `awards` | award_id、response_id、理由、审批人、审批时间 |
| `contracts` | contract_id、task_id、award_id、fund_id、amount、status、contract_hash |
| `delivery_batches` | batch_id、contract_id、计划/交付/验收/拒收数量、evidence_hash |
| `acceptances` | acceptance_id、batch_id、结果、验收人、凭证哈希 |
| `settlements` | settlement_id、contract_id、accepted_amount、payout_ref |
| `exchange_rules` | rule_id、version、MON/CNY 价格来源与比例、费率、滑点、限额、生效期、rule_hash |
| `payout_accounts` | account_id、organization_id、支付机构账户引用、验证状态、账户名哈希 |
| `redemption_requests` | redemption_id、contract_id、organization_id、rule_id、payout_account_id、MON 金额、人民币金额、价格快照、payout_ref、settlement_tx_hash、status |
| `chain_transactions` | tx_id、purpose、business_id、chain_id、tx_hash、status、confirmations |
| `audit_events` | event_id、entity_type、entity_id、action、actor、payload_hash、prev_hash |
| `idempotency_keys` | key、actor、request_hash、response_snapshot、expires_at |

所有金额使用整数最小单位保存，不使用浮点数。MON wei、人民币分和数量单位必须分别标明；MON/CNY 价格快照必须记录来源和有效期。

## 6. Monad 合约和事件

### 合约边界

1. `NativeMonEscrow`：接收 MON，按资金 lot 锁定、分配、释放、退款、兑换锁定和结算。
2. `WatermarkRegistry`：登记捐赠根水印、父子 lot、步骤和 FINISHED 终态。
3. `DonationRegistry`：登记捐赠、人民币到账证明、MON 存入和用途政策关联。
4. `TaskRegistry`：登记获批准任务、预算和证据哈希。
5. `AuditRegistry`：写入业务事件哈希、私有批次 Merkle root、操作者机构和前序哈希。

### 关键事件

```text
DonationApproved(donationId, policyHash)
MonDeposit(donationId, watermarkId, amountMon, acquisitionHash)
TaskApproved(taskId, approvalHash)
BudgetReserved(fundId, taskId, contractId, amount)
EscrowCreated(contractId, amount, termsHash)
DeliveryRecorded(contractId, batchId, deliveryHash)
DeliveryAccepted(contractId, batchId, acceptedAmount, acceptanceHash)
EscrowReleased(contractId, batchId, amount)
PayoutRecorded(contractId, payoutRefHash)
MonSettled(redemptionId, amountMon, settlementAddress, settlementHash)
AuditRecorded(eventId, entityId, action, payloadHash, previousEventHash)
```

### 链上交易原则

- 只有后端 Relayer/HSM/多签账户能发起管理交易。
- 每笔交易都要有 `business_id`、`idempotency_key` 和本地 outbox 记录。
- 后端先写待提交记录，再提交交易；收到 receipt 后更新确认数。
- 交易失败不能直接把业务状态改成成功，必须可重试或进入人工处理。
- Monad 确认数、交易状态和事件日志由 Indexer 回写；定时 Reconciler 对账数据库和链上余额。
- 主网前先在 Testnet 完成合约审计、权限演练、暂停演练和灾备演练。

## 7. API 草案

所有写接口要求：登录态、角色权限、`Idempotency-Key`、请求签名/风控上下文和审计日志。

```text
POST /v1/donations
GET  /v1/donations/:id
POST /v1/donations/:id/compliance-review
GET  /v1/funds/:id/ledger

POST /v1/tasks
POST /v1/tasks/:id/verify
POST /v1/tasks/:id/approve
POST /v1/tasks/:id/temporary-approve

POST /v1/resources/:orgId/certification
POST /v1/tasks/:id/responses
POST /v1/awards
POST /v1/contracts
POST /v1/contracts/:id/approve

POST /v1/contracts/:id/deliveries
POST /v1/deliveries/:id/accept
POST /v1/contracts/:id/settlements
POST /v1/settlements/:id/redemptions
POST /v1/redemptions/:id/approve
POST /v1/redemptions/:id/payout
POST /v1/redemptions/:id/settle

GET  /v1/audit-events?entityId=...
GET  /v1/chain-transactions/:id
GET  /v1/public/trace/:publicRef
```

接口返回必须区分业务状态和链上状态，例如：

```json
{
  "businessId": "DON-001",
  "status": "MON_DEPOSIT_PENDING",
  "chain": {
    "network": "monad-testnet",
    "txHash": "0x...",
    "confirmations": 2,
    "finalityStatus": "pending"
  }
}
```

## 8. 审计、风控和对账

- 所有写操作记录操作者、机构、角色、IP/设备、前后值和理由。
- 文件上传后立即计算内容哈希；下载和查看也记录审计事件。
- 后台每天核对：银行到账总额、MON 取得/存入总额、链上托管余额、链下资金流水、已兑付和已结算数量。
- 出现以下情况自动冻结并进入人工复核：重复支付回调、超用途分配、异常高价、同一机构循环交易、钱包变更、链上余额不一致、交易长期 pending。
- 个人身份证、银行卡、联系方式不上链；公开查询只返回脱敏信息和证据哈希。

## 9. Web 端实现边界

旧的 `pages/` 和 `utils/store.js` 仅作为历史演示，不是生产业务层。移动 Web 与管理 Web 都必须调用统一 API：

```text
store.addFund              → api.createDonation / api.getDonation
store.addTask              → api.createTask / api.submitVerification
store.addMaterialBid       → api.submitResourceResponse
store.sign*Contract        → api.createAward / api.approveContract
store.progressContract     → api.createDelivery / api.acceptDelivery / api.settle
store.attachTraceTx        → api.getChainTransaction / api.getAuditTrail
wx.setStorageSync          → 仅缓存 token、列表快照和草稿
```

页面中的 `certified`、`official`、`connectWallet` 和“提交后立即生成哈希”都必须改成服务端返回的真实状态。链上追踪页应展示交易生命周期，而不是允许用户随意填写 Relayer 地址作为生产配置。

## 10. 实施顺序

### 阶段 A：链上基础

- 固化 Native MON Escrow、平台收款托管和组织兑换模型；补齐资质与参数配置。
- 编写并测试 NativeMonEscrow、WatermarkRegistry、DonationRegistry、AuditRegistry。
- 在 Monad Testnet 部署；建立多签/HSM 和暂停方案。
- 固化事件 ABI、业务 ID 规则和交易状态机。

### 阶段 B：后端和合规

- 身份、机构、角色和审批流。
- 人民币到账回调、KYC/KYB、AML、资金政策。
- PostgreSQL、对象存储、审计日志、队列、Relayer、Indexer、Reconciler。
- 用集成测试证明“MON 存入数量 = 可用/托管/结算/退款余额之和 = 可追踪资金流”。

### 阶段 C：双 Web 端接入

- 移动 Web 显示订单、合规审核、MON 取得与存入回执及价格快照。
- 管理 Web 提供资金台账、审批队列、角色权限和对账面板。
- 任务页增加核验、正式批准和临时批准。
- 资源页改为认证资源响应、候选和审批。
- 合同页改为交付批次、验收、争议和分批结算。
- 我的页面显示从捐赠到兑付的链下记录、链上交易和证据哈希。

### 阶段 D：主网前审查

- 智能合约第三方审计。
- 权限、密钥、暂停、恢复和灾备演练。
- 财务、公益、数据保护和支付/虚拟资产法律审查。
- Testnet 全链路压测和账实链三方对账。

## 11. 需要产品/合规负责人拍板的事项

以下事项不拍板，后端和合约接口就不应冻结。括号内是我建议的默认值。

| 决策项 | 推荐默认 | 影响 |
|---|---|---|
| MON 业务性质 | 平台托管的原生 MON 资产，不开放任意地址自由转账 | 已确认技术边界；仍需法律意见确认表述 |
| Monad 原生代币 MON | 仅用于 Gas，不作为捐赠额度或兑换资产 | 已确认的技术边界 |
| 运营主体 | 平台负责收款、MON 取得/存入、托管和兑付 | 业务已确认；需复核实际法人/牌照 |
| 人民币入口 | 银行/持牌支付机构到账回调，不在 Web 端直接收款（推荐） | 决定支付合规、对账和退款 |
| MON 兑付 | 组织验收后按兑换规则申请人民币，平台兑付后结算/释放 MON 并标记水印完成 | 影响兑换规则、支付和资金释放时序 |
| 资金托管 | NativeMonEscrow + 链下按捐赠单分账（推荐） | 决定合约复杂度和资金隔离模型 |
| MON 存入/结算权限 | 2-of-3 多签或 HSM，不使用小程序私钥（推荐） | 决定密钥安全和操作流程 |
| KYC 范围 | 个人小额分级、机构强 KYB、大额人工复核（推荐） | 决定用户体验和合规成本 |
| 任务批准 | 官方审核；生命救援允许临时批准并强制事后复核（推荐） | 决定应急速度和责任留痕 |
| 资源选择 | 系统评分只做推荐，人工审批决定中选（推荐） | 决定采购责任和争议处理 |
| 验收与结算 | 分批验收、按实际完成量结算（推荐） | 决定合同、托管和数据模型 |
| 链上隐私 | 仅上链 ID、哈希、机构和时间，原文链下保存（推荐） | 决定数据保护和交易成本 |
| 主网切换条件 | Testnet 全链路通过 + 合约审计 + 财务三方对账 | 决定是否允许真实资金进入主网 |
| 首期范围 | 按原有项目保留多灾种、多物资、多类救援服务 | 已确认；需要分阶段控制额度 |

### 当前仍需确认的 5 个问题

1. 平台负责收款和兑付的具体法人、支付通道和资金托管资质是什么？
2. 兑换规则按 MON/CNY 哪个价格时点和数据源确定，是否允许服务费、运输费、税费、滑点和风险准备金？
3. 组织兑换人民币前是否需要再次 KYC/KYB、发票、收款账户白名单和额度审批？
4. 默认机构角色对应的真实机构名单、审批限额和多签成员是谁？
5. 多灾种、多物资范围下，首期是否仍只在 Testnet 使用模拟人民币兑付，主网按额度灰度？
