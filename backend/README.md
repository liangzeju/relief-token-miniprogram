# Relief MON Backend

Relief MON Web 双端后端，新增 ethers 驱动的真实 Monad 测试网钱包服务。首次启动前执行 `pnpm install --prod --ignore-scripts` 或 `npm install --omit=dev`。真实钱包账户、管理员令牌及资金账本位于 `DATA_DIR/wallet`，不与旧演示数据混合。

钱包接入、测试网部署及安全边界见 [钱包接入说明](../docs/wallet-testnet.md)。以下旧业务接口、固定 Bearer token 和 DemoChainAdapter 仅供业务演示，不代表真实链上入账或完整 KYC。

```powershell
cd backend
npm start
```

运行后端闭环冒烟测试（会使用临时数据目录，不会修改本地演示数据）：

```powershell
npm test
```

默认监听 `http://localhost:8787`。本地开发使用 Bearer token 模拟身份（仅限演示）：

```http
Authorization: Bearer demo-platform-admin
```

可用演示身份：`demo-donor`、`demo-reporter`、`demo-platform-admin`、`demo-compliance`、`demo-finance`、`demo-verifier`、`demo-dispatcher`、`demo-approver`、`demo-supplier`、`demo-acceptance`。所有写请求都必须带 `Idempotency-Key`；重复使用同一 key 会返回首次结果，复用到不同请求会返回 409。

本实现默认使用 `backend/data/state.json` 保存业务数据，并使用 DemoChainAdapter 生成演示交易。生产环境必须替换为 PostgreSQL、Monad Relayer/HSM、真实银行回调和 KYC/KYB/AML 适配器；演示适配器不会转移真实 MON。

核心流程：人民币到账确认 → 合规审核 → MON 取得/存入 → 水印 lot → 任务/资源/合同 → Escrow → 交付验收 → 结算 → MON 锁定 → 人民币兑付 → MON 结算 → FINISHED。
