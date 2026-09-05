# 后端实施拆分

> 历史任务拆分：人民币入口、兑付及普通用户申领不再是当前目标。请按 [当前实施清单](repair-roadmap.md) 和 [验收矩阵](acceptance-matrix.md) 开发；本文仅保留历史背景。

## Epic 0：拍板与合规基线

确认 MON 托管与兑换的法律性质、收款主体、MON 取得/预存方式、兑付方式、首期范围、机构清单、角色负责人、审批限额、KYC/KYB/AML 服务和证据保存年限。出口是已更新的 [decision-log.md](./decision-log.md)。

## Epic 1：Monad 合约

实现 `NativeMonEscrow`、`WatermarkRegistry`、`DonationRegistry`、`AuditRegistry`，完成权限、模糊、暂停和重放测试。出口是 Testnet 五条核心链路成功，重复调用不会重复记账，余额不变量通过。

## Epic 2：身份和权限

移动 Web/管理 Web 使用服务端 session；建立 users、organizations、memberships；集中实现动作权限、scope、职责冲突和审批限额。出口是所有写接口都能证明服务端授权，不能靠修改客户端绕过。

## Epic 3：捐赠、到账和合规

实现捐赠订单、支付回调验签、KYC/KYB/AML、人工复核、用途政策哈希、MON 取得/价格快照和 deposit intent。出口是同一到账只登记一次 MON 存入，拒绝、冻结、退款都有审计证据。

## Epic 4：任务和资源

实现任务上报、核验、临时/正式批准、过期处理、机构资质、响应版本、推荐评分快照、中选理由和审批。出口是不合规资源不能响应，中选决定可被审计复现。

## Epic 5：合同、托管和履约

实现中选方案到合同草案、用途/余额匹配、Escrow、交付批次、部分验收、争议、退款和实际完成量结算。出口是结算金额不能由客户端指定，每批结算都有验收证据和链上事件。

## Epic 6：兑付和 MON 结算

组织引用已验收结算和有效兑换规则提交兑换申请；财务/合规复核后锁定 MON，调用支付机构兑付并保存 payout reference；兑付确认后调用 `settleRedemption` 将 MON 释放到平台流动性地址并完成水印。出口是没有支付回执不能结算，捐赠者能查到兑换规则、价格快照、payout、settlement 和 FINISHED 水印。

## Epic 7：链上基础设施

实现 Outbox、Relayer/HSM、多签队列、nonce 管理、重试、Indexer、确认数、事件去重、Reconciler、监控、告警和死信队列。出口是 RPC 中断、revert、重复日志和进程重启不破坏资金不变量。

## Epic 8：双 Web 端接入

移动 Web 和管理 Web 各自新增 API client、session、错误码和链上状态组件；移动端显示捐赠、任务、MON 水印和 PDF 凭证，管理端显示审批、台账、竞价、合同和审计。出口是页面只调用 API，刷新后仍能恢复完整状态。

## 推荐第一条垂直切片

```text
实名捐赠者 → CNY 测试到账 → 合规批准 → 平台取得/预存 MON → Testnet 存入 Escrow
→ 一个饮用水任务 → 一个认证供应商 → 合同 Escrow
→ 一批交付与验收 → 锁定 MON → 模拟人民币兑付 → MON 结算/释放 → FINISHED 水印
→ 捐赠者查询完整链路
```
