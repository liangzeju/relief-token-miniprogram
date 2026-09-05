# 前后台与商城验收

## 页面入口

运行根目录 `start.ps1`，使用脚本打印的地址。默认前台 `/mobile/`，管理端 `/admin/`。商城 `/mobile/#market`，任务 `/mobile/#tasks`，订单 `/mobile/#account`。`/`、`/mobile`、`/mobile/`、`/mobile/index.html` 均可进入前台。

后端默认端口 8787。需要独立部署前端时，在加载 `/shared/api.js` 前设置 `window.RELIEF_API_BASE`，并将后端 `CORS_ORIGIN` 配置为对应的前端 Origin。前端资源仍需要按 `/mobile`、`/admin`、`/shared` 路径发布。

## API 与数据

| 接口 | 作用 | 演示身份 |
| --- | --- | --- |
| `GET /v1/public/overview` | 资金池、任务、公开合同、新闻、商品目录 | 公开 |
| `GET /v1/overview` | 管理总览及全部物资申领 | 管理员 |
| `GET /v1/marketplace` | 统一物资及服务目录 | 公开 |
| `POST /v1/market-orders` | 提交物资申领 | 捐赠者 |
| `GET /v1/market-orders` | 我的申请或全部申请 | 捐赠者/管理员 |
| `POST /v1/market-orders/{id}/approve` | 审核、扣库存、创建待审批合同 | 管理员 |
| `POST /v1/market-orders/{id}/reject` | 驳回申请 | 管理员 |
| `POST /v1/donations` | 登记 MON 意向 | 捐赠者 |
| `GET /v1/donations` | 查询当前身份可见的捐赠 | 捐赠者/管理员 |

物资申领请求为 `{ "itemId": "MAT-WATER", "taskId": "TASK-001", "quantity": 2 }`。价格和总额由后端计算，不接受浏览器自报价格。写请求必须包含唯一 `Idempotency-Key`。演示身份为 `Bearer demo-donor` 与 `Bearer demo-platform-admin`。

MON 意向请求使用 `monIntentAmount`，进入 `MON_REVIEW_PENDING`。管理端合规核验后提交 MON 存入，再推进演示链确认。该路径没有人民币到账确认步骤。

## 手工闭环

1. 前台首页确认余额、参与人数、物资折合及项目缺口显示；点击新闻查看正文、出处和日期。
2. 进入商城，切换分类、搜索、打开商品详情；选择救援任务，填写数量，提交申领。
3. 管理端打开“物资申领审核”，确认品名、数量、总额与前台一致，点击“批准并生成合同”。
4. 前台“我的订单”在刷新后显示批准及合同编号；商城库存扣减；管理端合同台账出现同一合同。
5. 刷新浏览器或重启后端，订单、库存和合同保持。后端停机时前台显示连接失败，资金与人数不自行变化。

## 自动回归

在 `backend` 目录运行 `node test/smoke.js` 和 `node test/integration.js`。回归覆盖共享目录、订单审核、库存校验、幂等、角色权限、数据持久化与零值保留。

浏览器回归需要安装开发依赖和 Microsoft Edge，使用独立演示数据启动测试服务。设置 `TEST_BASE_URL` 为测试服务地址（默认 `http://localhost:18787`）后运行 `npm run test:browser`。会在测试服务中创建申领和合同，请勿对真实业务环境运行。截图输出在根目录 `test-output`。

## 本次修复范围

这是可联调的本地演示应用。真实邮箱验证码、钱包签名认证、Monad RPC/合约部署与真实供应方库存需要各自服务配置。当前不可将演示 token、合约地址、估价或库存当作生产服务。商品图生成说明位于 `web/shared/assets/README.md`。
