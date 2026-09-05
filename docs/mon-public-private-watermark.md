# MON 双层网络与捐赠水印设计

## 1. 结论

这个方案技术上可以实现，但必须把公开链和私有层定义为两层：

```text
公开层：Monad 公共 L1，使用真实 MON，记录可公开验证的资产动作和水印
私有层：许可式业务网络或后端账本，记录竞价细节、身份、合同原文和内部审批
```

Monad 官方文档将 Monad 定义为公开的 EVM 兼容 Layer-1，并给出主网 Chain ID 143、测试网 Chain ID 10143，网络原生货币为 MON。Monad 主网不是私链；另建许可式 EVM 链后，它是平台/联盟运营的独立网络，不能称为 Monad 公链的私有模式。

## 2. MON 的关键限制

MON 是 Monad 网络原生资产，平台不能像发行 ERC-20 一样铸造新的 MON。人民币到账后，平台只能通过合规交易/流动性渠道取得 MON、接收捐赠者直接转入的 MON，或由平台预存 MON 后建立业务额度。

因此不能简单实现“到账 1 元，合约自动 mint 1 MON”。真实流程必须记录：

```text
CNY 已到账 → 合规批准 → MON 取得/存入交易
→ 交易价格、时间、数量和流动性来源
→ Monad 托管合约登记 donation lot
```

MON 价格会波动，兑换人民币时必须有价格快照、有效期、限额、滑点和损失承担规则。若业务必须严格保持 1 元价值稳定，MON 不适合作为唯一价值单位；可以用 MON 作为链上资产，同时用 CNY 计价并配置风险准备金。

## 3. 水印的正确实现

MON 是可替代的原生资产。某个 MON 不会永久携带“来自哪个捐赠者”的物理标签。水印应由平台托管合约维护为资金 lot 的来源和血缘：

```text
DONATION-001 / rootWatermark
  → TASK-001 / allocationWatermark
  → CONTRACT-001 / escrowWatermark
  → DELIVERY-001 / acceptanceWatermark
  → REDEMPTION-001 / payoutWatermark
  → FINISHED
```

每次拆分生成子 lot，每次合并保留父 lot 集合。只要 MON 一直留在托管合约内，资金血缘就可验证；MON 直接转出后，链上仍能看到转账，但不能仅凭原生余额证明其中哪一部分来自某位捐赠者。

水印字段建议包括：`watermarkId`、`parentWatermark`、`eventId`、`eventType`、`amountMon`、`donationRef`、`taskRef`、`contractRef`、`privateEventHash`、`previousHash`、`status`。

## 4. 公开 Monad 层

所有 MON 资产动作必须在公开 Monad 层完成：MON 存入和 donation lot 建立、合规摘要、预算分配、合同 Escrow、交付/验收凭证哈希、兑换锁定、人民币支付回执哈希、MON 结算、最终 `FINISHED` 水印，以及私有批次 Merkle root 锚定。

建议事件：

```solidity
event MonDeposit(bytes32 indexed donationId, bytes32 indexed watermarkId, uint256 amountMon, bytes32 acquisitionHash);
event BudgetAllocated(bytes32 indexed watermarkId, bytes32 indexed taskId, uint256 amountMon, bytes32 policyHash);
event EscrowCreated(bytes32 indexed contractId, bytes32 indexed watermarkId, uint256 amountMon, bytes32 termsHash);
event DeliveryAccepted(bytes32 indexed contractId, bytes32 indexed batchId, uint256 acceptedQuantity, bytes32 evidenceHash);
event MonLockedForRedemption(bytes32 indexed redemptionId, bytes32 indexed watermarkId, uint256 amountMon, uint256 ruleVersion);
event PayoutRecorded(bytes32 indexed redemptionId, bytes32 payoutReferenceHash, uint256 cnyAmount);
event MonSettled(bytes32 indexed redemptionId, uint256 amountMon, bytes32 settlementHash);
event WatermarkFinished(bytes32 indexed watermarkId, bytes32 finalHash);
event PrivateBatchAnchored(bytes32 indexed batchId, bytes32 merkleRoot, bytes32 disclosureHash);
```

公开链不应放身份证、银行卡、手机号、合同原文、图片视频、未截止报价和非中选组织的敏感商业数据。公开的“详细交易”应是业务 ID、MON 数量、时间、状态、脱敏机构标识、证据哈希和交易链接。

## 5. 私有业务层

私有层记录供应商/救援队 KYB、联系方式、完整竞价方案、截止前报价、内部评审、合同原文、运输单、发票和验收原件。首期推荐使用 PostgreSQL + 加密对象存储；需要多机构共同维护时，再引入许可式 EVM 网络。

私有层不得发行或转移第二份代表真实 MON 的资产，也不得成为 MON 余额的最终真相源。每个私有批次必须生成 `payloadHash` 或 Merkle root，并通过 `PrivateBatchAnchored` 锚定到 Monad。

需要特别注意：公开 Monad 会公开交易发起地址、接收地址、金额和时间。若要求外部只能知道“有一笔 MON 业务发生”，而不知道组织之间的真实对手方，组织不能直接互转 MON；所有 MON 只在平台控制的 Escrow、运营多签和结算/流动性地址之间流转，组织的合同对手方和人民币收款账户留在私有层。这样公开链仍能审计资产动作，私有层负责身份和商业隐私。

## 6. 竞价和前 3 公示

```text
竞价开始：完整报价在私有层保存，提交 commitmentHash
截止封标：冻结报价版本，生成 Merkle root
评审完成：前 3 候选的脱敏摘要发布到 Monad
前 3 公示：公开排名、评分组成、MON/CNY 报价摘要和证据哈希
最终中选：审批通过后在 Monad 创建正式 Escrow
未中选方案：留在私有层，公开链只保留 commitment/审计根
```

是否公开前 3 的真实组织名称、完整报价和联系方式，必须由产品与合规负责人确认；不应默认把所有细节公开。

## 7. 兑换和结束状态

```text
验收通过
→ 组织提交兑换规则版本和已验证收款账户
→ Monad 锁定待兑换 MON
→ 银行/支付机构兑付 CNY
→ Monad 记录 payout reference
→ Monad 结算/释放 MON
→ WatermarkFinished
```

原生 MON 没有通用业务 `burn()` 接口。兑付后应记录 MON 从 Escrow 释放到平台结算/流动性地址、对应 CNY 支付回执和最终水印完成状态；如果平台实际销毁 MON，必须另定义可验证的销毁地址和会计规则。

## 8. PDF 捐赠凭证

人民币到账并完成 MON 存入确认后，后端生成 PDF，不由小程序伪造。PDF 包含凭证编号、捐赠者脱敏 ID、CNY 到账金额、MON 数量、价格快照、存入交易哈希、Monad 网络/Chain ID/合约地址、根水印 ID、用途政策、公开查询二维码、平台签章和 PDF SHA-256。PDF 哈希再通过 `AuditRecorded` 或 `EvidenceAnchored` 锚定到 Monad。

## 9. 可行性边界

可以实现：MON 托管、公开链水印、lot 拆分/锁定/释放、私有竞价、前 3 公示、私有证据哈希锚定、捐赠者全链路查询和 PDF 凭证。

不能按字面实现：平台合约铸造原生 MON；同一笔原生 MON 同时完全公开和完全私密；原生 MON 离开托管后仍天然携带不可分割的个人水印；把独立许可式 EVM 网络称为 Monad 公链私链。

## 10. 官方资料

- [Monad 官方介绍](https://docs.monad.xyz/)
- [Monad 网络信息](https://docs.monad.xyz/developer-essentials/network-information)
- [Monad 测试网信息](https://docs.monad.xyz/developer-essentials/testnet)
- [Monad 交易格式](https://docs.monad.xyz/developer-essentials/transactions)
- [Monad 隐私基础设施](https://docs.monad.xyz/tooling-and-infra/privacy)
