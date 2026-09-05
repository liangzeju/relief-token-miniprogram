# 后端实现契约

这份文件把 [backend-architecture.md](./backend-architecture.md) 转成工程团队可以直接实现的约束。它不依赖具体语言或框架；Node/Nest、Go、Java 等都可以按同一契约实现。

## 1. 请求和响应约定

### 必填请求上下文

```http
Authorization: Bearer <wechat-session-token>
Idempotency-Key: <uuid-v4>
X-Request-Id: <uuid-v4>
X-Client-Version: <app-version>
```

写接口必须从服务端会话解析 `userId`、`orgId`、`roles`，不能信任小程序提交的操作者 ID、机构 ID 或认证标记。

### 统一响应

```json
{
  "requestId": "req_01...",
  "data": {},
  "error": null
}
```

错误格式：

```json
{
  "requestId": "req_01...",
  "data": null,
  "error": {
    "code": "FUNDS_POLICY_MISMATCH",
    "message": "该资金用途不允许分配给当前任务",
    "retryable": false,
    "details": {}
  }
}
```

同一个 `Idempotency-Key` 重复请求必须返回第一次请求的结果；如果请求体不同，返回 `IDEMPOTENCY_KEY_REUSED`。

### 链上状态统一格式

所有会触发链上交易的接口都返回业务状态和交易状态：

```json
{
  "businessId": "CTR-001",
  "status": "FUNDS_RESERVATION_PENDING",
  "chain": {
    "network": "monad-testnet",
    "chainId": 10143,
    "txId": "chtx_01...",
    "txHash": null,
    "status": "QUEUED",
    "confirmations": 0,
    "requiredConfirmations": 2,
    "blockNumber": null,
    "lastError": null
  }
}
```

## 2. 状态机和守卫

### 捐赠/资金

```text
CREATED → PAYMENT_PENDING → PAYMENT_CONFIRMED → COMPLIANCE_REVIEW
        → APPROVED → MON_DEPOSIT_PENDING → MON_DEPOSIT_CONFIRMED → AVAILABLE
```

异常状态：`PAYMENT_FAILED`、`COMPLIANCE_REJECTED`、`MON_ACQUISITION_FAILED`、`MON_DEPOSIT_FAILED`、`FROZEN`、`CLOSED`。

- `PAYMENT_CONFIRMED` 只能由验签后的银行/支付回调或人工财务对账产生。
- `APPROVED` 要求 KYC/KYB、AML、用途政策和风险规则通过。
- `MON_DEPOSIT_PENDING` 要求批准记录、MON 取得来源/价格快照、amountMon、唯一 donation ID 和未使用的幂等键。
- `AVAILABLE` 要求 Monad receipt 达到确认数，并完成链下链上数量校验。

### 任务

```text
REPORTED → VERIFYING → APPROVED → DISPATCHING → EXECUTING → COMPLETED
```

旁路：`TEMPORARY_APPROVED`、`REJECTED`、`CANCELLED`、`EXPIRED`。

- `APPROVED` 需要官方核验员，且不能是上报人本人。
- `TEMPORARY_APPROVED` 必须有 `reason`、`expiresAt` 和 `postReviewDueAt`。
- `DISPATCHING` 前必须存在资源需求和预算上限。
- `COMPLETED` 前必须所有必要合同达到结算或关闭状态。

### 资源响应和中选

```text
OPEN → RESPONSE_SUBMITTED → SHORTLISTED → AWARD_PENDING_APPROVAL
     → AWARDED → EXPIRED / WITHDRAWN
```

- 只有认证有效期内的供应商/救援队可以提交响应。
- 截止时间后不能创建或修改响应版本。
- 系统评分是推荐数据，必须保存评分快照和人工中选理由。
- 中选审批人不能属于中选资源机构，也不能是调度员本人（由产品决定是否允许例外）。

### 合同、交付和结算

```text
DRAFT → PENDING_APPROVAL → APPROVED
      → FUNDS_RESERVATION_PENDING → FUNDS_RESERVED → IN_PROGRESS
      → PENDING_ACCEPTANCE → ACCEPTED → SETTLEMENT_PENDING → SETTLED
      → REDEMPTION_REQUESTED → MON_REDEMPTION_LOCKED
      → PAYOUT_PENDING → PAYOUT_CONFIRMED
      → MON_SETTLEMENT_PENDING → MON_SETTLED
```

旁路：`PARTIALLY_DELIVERED`、`PARTIALLY_ACCEPTED`、`REJECTED`、`DISPUTED`、`CANCELLED`、`DEFAULTED`、`REFUNDED`。

- 合同审批前必须有已中选响应、有效资质、用途匹配和预算校验。
- `FUNDS_RESERVED` 只能在 `EscrowCreated` 链上事件确认后产生。
- 验收数量不能超过交付数量，结算金额不能超过验收金额和合同上限。
- 验收员不能是合同审批员，也不能属于供应方机构。
- `REDEMPTION_REQUESTED` 必须引用已验收结算、有效兑换规则版本、组织收款账户和额度检查。
- `MON_REDEMPTION_LOCKED` 先锁定待兑换 MON，防止重复申请；兑付失败时只允许按规则解锁一次或进入人工复核。
- `PAYOUT_CONFIRMED` 必须有银行/支付机构回执；随后才允许在 Monad 结算/释放 MON，并写入 `WatermarkFinished`。
- 链上交易失败、超时或对账不一致时，业务状态保持 pending/exception，不能人工直接改为成功。

## 3. 权限检查顺序

每个写请求按以下顺序执行，任何一步失败都不写业务主表：

```text
身份有效
  → 机构成员关系有效
  → 角色具有动作权限
  → 资源范围允许访问该对象
  → 职责冲突检查通过
  → 状态转换合法
  → 合规规则通过
  → 幂等键未消费
  → 数据库事务写入 outbox/audit
  → 异步提交链上交易
```

### 动作权限键

```text
donation:create
donation:approve
donation:freeze
task:create
task:verify
task:temporary_approve
task:approve
resource:submit
resource:certify
award:propose
award:approve
contract:create
contract:approve
delivery:create
delivery:accept
settlement:review
settlement:payout
chain:submit
chain:pause
audit:read
```

权限判断必须是后端集中策略，不能散落在小程序页面中。

## 4. 链上交易 Outbox/Indexer 流程

```text
业务事务写入：business row + audit_event + chain_outbox(status=READY)
  → Chain Worker 抢占 outbox（带 lease）
  → Relayer/HSM 签名并广播
  → 保存 txHash，状态 BROADCAST
  → Indexer 监听 receipt/log
  → 达到确认数，状态 CONFIRMED
  → 业务状态机消费链上事件
  → Reconciler 定期检查余额、事件和业务关联
```

交易状态至少包括：`READY`、`SUBMITTING`、`BROADCAST`、`CONFIRMED`、`REVERTED`、`TIMEOUT`、`MANUAL_REVIEW`。

同一个业务动作必须使用稳定的 `businessId + action + version` 生成链上关联键，避免网络重试造成重复存入、重复锁定、重复释放或重复结算。

## 5. 资金流水不变量

后端和对账服务必须持续验证：

```text
每个资金账户：
deposited = available + reserved + settled + refunded + pending

每个托管合同：
reservedAmount >= releasedAmount + refundedAmount

每个交付批次：
acceptedQuantity <= deliveredQuantity <= plannedQuantity

所有结算：
settledAmount <= acceptedAmount <= contractAmount
```

发生不变量失败时，相关资金账户和合同自动进入 `FROZEN`/`MANUAL_REVIEW`，只允许合规和财务角色处理。

## 6. 最小可观测性要求

- 每个请求、数据库事务、链上交易和审计事件共享 `requestId` 或 `correlationId`。
- 监控支付回调延迟、MON 取得/存入 pending、托管对账差异、交易失败率、验收待办、兑付失败率。
- 告警覆盖重复回调、余额不守恒、权限拒绝激增、Relayer 钱包余额不足、RPC 不可用、合约暂停。
- 人工重试、解冻或改状态必须写入不可删除的审计日志，并要求理由和复核人。

## 7. 演示过程与详情投影

管理端演示流程只展示服务端确认后的 Monad 入账、托管、锁定和结算状态；不得在管理端模拟“人民币入账即成功铸造 MON”。后端提供以下只读投影供管理端和审计页使用：

- `GET /v1/demo/process`：需要内部角色，返回 `steps`、`moneyFlow`、`visualization.nodes`、`visualization.edges`、`visualization.timeline`，用于流程看板和图形化资金流。
- `GET /v1/details/{type}/{id}`：需要角色和对象 scope 双重校验，返回主对象、关联链上交易、审计事件、trace、水印血缘和相关业务对象。`type` 首期包括 `donation`、`task`、`response`、`award`、`contract`、`delivery`、`settlement`、`redemption`。
- `GET /v1/public/trace/{donationId|watermarkId}`：公开接口只返回脱敏水印摘要、公开事件、tx/hash/attestation 和二维码目标，不返回供应方报价、合同原文、收款账户或完整私有血缘。

PDF 捐赠凭证必须由后端生成，并包含 `depositTxHash`、`rootWatermarkId`、`contractAddress`、`publicTraceUrl`、`qrCode`、`attestation.payloadHash` 和 `pdfSha256`。PDF 文件响应应同时带 `X-PDF-SHA256` 与 `X-Attestation-Hash`，便于前端下载后校验。
