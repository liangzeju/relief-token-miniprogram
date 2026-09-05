# ReliefPool deployment and integration

Status: compiled and tested locally; no public deployment or signer keys are created by these scripts. Public deployment is for Monad Testnet, chain ID 10143, only.

## Build and test

From `backend`, with the project dependencies already installed:

```sh
node scripts/compile-contract.cjs
node --test test/contract.cjs
```

The compiler reads `contracts/ReliefPool.sol` and the installed OpenZeppelin sources, enables the optimizer (200 runs), and targets `paris`. It writes `web/shared/contracts/ReliefPool.json`, shared by browser and backend. The artifact contains `abi`, `bytecode`, `deployedBytecode`, compiler settings and Solidity metadata. Both bytecode values are standard `0x` hex strings. Compilation rejects immutable references and unresolved library links. Rebuilding after a dependency/compiler change may change runtime metadata and its hash; deploy and verify using the same artifact.

## Wallet deployment

The administrator connects MetaMask on chain 10143 and uses the admin page deployment button. The backend prepares creation calldata from the artifact; MetaMask signs and broadcasts, and the backend needs no signing key. The webpage requires `initialOwner` to be the deploying wallet and verifies that constructor value. The underlying contract also supports a separate nonzero initial owner when deployed outside this page, but such deployments are not accepted by the page's deployment-confirm endpoint. There is no public deployment or testnet broadcast in the supplied scripts.

After confirmation, backend verification should check the RPC chain ID, successful deployment receipt, contract creation transaction, receipt contract address, nonempty `eth_getCode`, and exact runtime equality (or `keccak256` equality) against `artifact.deployedBytecode`. Also check `owner()` against the intended initial owner before saving the deployment configuration. Ownable stores its owner in storage, so the deployed runtime is identical for different constructor owner addresses. Local tests verify that property against two real deployments.

## Frozen ABI and behavior

`constructor(address initialOwner)`

`configureTask(bytes32 taskId,uint8 purpose,uint8 urgency,uint256 targetWei,address recipient,bool active)` is owner-only. Up to 32 distinct, nonzero task IDs exist in permanent insertion order. Purpose is 1..5; urgency is 1..3, with 3 highest. A nonzero recipient is required. A zero target is allowed. Updates preserve allocated/released counters; targets cannot fall below lifetime allocations, and recipients cannot change after any allocation, including after full release. Owner may change purpose, urgency and active status; prior allocation events remain the historical record.

`getTasks()` returns `tuple[]` with fields in this exact order:

```text
bytes32 id
uint8 purpose
uint8 urgency
uint256 targetWei
uint256 allocatedWei
uint256 releasedWei
address recipient
bool active
```

`donate(bytes32 donationId,uint8 purpose)` is payable. IDs must be unique and nonzero, value positive, purpose 0..5. Purpose 0 accepts all task purposes. Allocation fills active matching tasks by descending urgency, then insertion order, without exceeding each task's remaining lifetime budget. Funds stay in the contract until release or refund.

`donations(bytes32)` returns `(address donor,uint8 purpose,uint256 amountWei,uint256 unallocatedWei)`. `amountWei` remains the original donation amount after refund. IDs cannot be reused after refund.

`allocateRemaining(bytes32 donationId)` is permissionless and only allocates that donation's current leftover using its original purpose and current task configuration. Unknown IDs revert; zero leftovers are a successful no-op. It emits `DonationAllocated` for new allocations. `DonationUnallocated` is emitted only for a positive initial leftover during `donate`; query `donations` for the current leftover after reallocation.

`releaseTask(bytes32 taskId,uint256 amountWei)` is owner-only and transfers a positive amount up to `allocatedWei - releasedWei` to the task's fixed recipient. Inactive tasks may still release existing allocations. Release does not replenish the lifetime allocation budget.

`refundUnallocated(bytes32 donationId)` refunds the full positive leftover only to the original donor. Failed transfers revert all accounting. OpenZeppelin ReentrancyGuard protects donation, reallocation, release and refund.

Events have the exact requested indexed fields:

```solidity
event DonationReceived(bytes32 indexed donationId,address indexed donor,uint8 purpose,uint256 amountWei);
event DonationAllocated(bytes32 indexed donationId,bytes32 indexed taskId,uint256 amountWei);
event DonationUnallocated(bytes32 indexed donationId,uint256 amountWei);
event TaskReleased(bytes32 indexed taskId,address indexed recipient,uint256 amountWei);
event DonationRefunded(bytes32 indexed donationId,address indexed donor,uint256 amountWei);
```

The cumulative counters are `totalDonatedWei`, `totalAllocatedWei`, `totalReleasedWei`, `totalRefundedWei`. With no forced native transfers, the pool balance equals `totalDonatedWei - totalReleasedWei - totalRefundedWei`; allocations only move internal ledger balances. EVM-forced native transfers can increase the actual balance without executing receive/fallback, and are not attributed to donations. Both ordinary direct payments (including zero value) and unknown calldata revert.

Only opaque task/donation IDs, public wallet addresses, enums, amounts and flags belong on chain. This contract has no private identity or document fields. Inherited Ownable ownership transfer/renunciation functions remain available; renouncing ownership permanently prevents task configuration and fund release.
