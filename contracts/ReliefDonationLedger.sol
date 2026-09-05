// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Funding ledger foundation, not a deployable pool. The final contract
/// must implement the approved fee policy and procurement/payment lifecycle.
/// Identity commitments must be salted opaque references, never personal data.
abstract contract ReliefDonationLedger is AccessControlDefaultAdminRules, Pausable, ReentrancyGuard {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant TASK_OPERATOR_ROLE = keccak256("TASK_OPERATOR_ROLE");
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    uint256 public constant MAX_ACTIVE_TASKS = 32;
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 public constant DONATION_PERMIT_TYPEHASH = keccak256(
        "DonationPermit(bytes32 donationId,address donor,uint8 purpose,bytes32 projectId,uint256 amountWei,uint256 gasReservedWei,bytes32 registrationHash,uint256 nonce,uint256 deadline,uint256 authorizationEpoch,bytes32 feePolicyHash,address registrar)"
    );

    struct DonationPermit {
        bytes32 donationId;
        address donor;
        uint8 purpose;
        bytes32 projectId;
        uint256 amountWei;
        uint256 gasReservedWei;
        bytes32 registrationHash;
        uint256 nonce;
        uint256 deadline;
        uint256 authorizationEpoch;
        bytes32 feePolicyHash;
        address registrar;
    }
    struct Donation {
        address donor;
        uint8 purpose;
        bytes32 projectId;
        uint256 amountWei;
        uint256 gasReservedWei;
        uint256 availableWei;
        uint256 refundedWei;
        bytes32 registrationHash;
        bytes32 feePolicyHash;
        uint256 sequence;
    }
    struct Task {
        bytes32 id;
        uint8 purpose;
        bytes32 projectId;
        uint8 urgency;
        uint256 targetWei;
        uint256 allocatedWei;
        uint256 sequence;
        bool active;
        bool closed;
    }

    mapping(bytes32 => Donation) public donations;
    mapping(bytes32 => Task) public tasks;
    mapping(bytes32 => mapping(bytes32 => uint256)) public allocationWei;
    mapping(address => mapping(uint256 => bool)) public usedDonationNonces;
    mapping(address => uint256) public authorizationEpochs;
    mapping(bytes32 => bool) public refundIds;
    bytes32[] internal _donationIds;
    bytes32[MAX_ACTIVE_TASKS] internal _activeTaskIds;
    uint256 internal _taskSequence;

    uint256 public totalDonatedWei;
    uint256 public totalGasReservedWei;
    uint256 public totalAvailableWei;
    uint256 public totalAllocatedWei;
    uint256 public totalRefundedWei;

    error InvalidId();
    error InvalidAmount();
    error InvalidPurpose();
    error InvalidUrgency();
    error InvalidProject();
    error InvalidRegistration();
    error InvalidFeePolicy();
    error DuplicateDonation();
    error UnknownDonation();
    error NotDonor();
    error InvalidAuthorization();
    error AuthorizationExpired();
    error NonceAlreadyUsed();
    error DuplicateTask();
    error UnknownTask();
    error TaskClosed();
    error ActiveTaskLimitReached();
    error AllocationNotAuthorized();
    error DuplicateRefund();
    error TransferFailed();
    error DirectPaymentUnsupported();

    event DonationReceived(bytes32 indexed donationId, address indexed donor, uint8 purpose, bytes32 projectId,
        uint256 amountWei, uint256 gasReservedWei, bytes32 registrationHash, bytes32 feePolicyHash);
    event TaskRegistered(bytes32 indexed taskId, uint8 purpose, bytes32 projectId, uint8 urgency, uint256 targetWei);
    event TaskActivityChanged(bytes32 indexed taskId, bool active);
    event DonationAllocated(bytes32 indexed donationId, bytes32 indexed taskId, uint256 amountWei);
    event DonationRefunded(bytes32 indexed refundId, bytes32 indexed donationId, address indexed recipient, uint256 amountWei);
    event DonationNonceCancelled(address indexed donor, uint256 nonce);
    event AuthorizationEpochChanged(address indexed registrar, uint256 epoch);

    constructor(address admin) AccessControlDefaultAdminRules(2 days, admin) {}

    function donationPermitHash(DonationPermit calldata permit) public view returns (bytes32) {
        // Fixed EIP-712 domain. Compute chainId and address for every signature so
        // neither a fork nor another deployment can reuse its domain separator.
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("ReliefFunding"), keccak256("2"), block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(DONATION_PERMIT_TYPEHASH, permit))));
    }

    function eip712Domain() external view returns (bytes1 fields, string memory name, string memory version,
        uint256 chainId, address verifyingContract, bytes32 salt, uint256[] memory extensions)
    {
        return (hex"0f", "ReliefFunding", "2", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function donate(DonationPermit calldata permit, address registrar, bytes calldata signature)
        external payable nonReentrant whenNotPaused
    {
        if (permit.donationId == bytes32(0)) revert InvalidId();
        if (permit.donor != msg.sender) revert NotDonor();
        if (permit.purpose > 5) revert InvalidPurpose();
        if (permit.amountWei == 0 || msg.value != permit.amountWei || permit.gasReservedWei > permit.amountWei) revert InvalidAmount();
        if (permit.registrationHash == bytes32(0)) revert InvalidRegistration();
        if (permit.feePolicyHash == bytes32(0)) revert InvalidFeePolicy();
        if (donations[permit.donationId].donor != address(0)) revert DuplicateDonation();
        if (usedDonationNonces[msg.sender][permit.nonce]) revert NonceAlreadyUsed();
        if (block.timestamp >= permit.deadline) revert AuthorizationExpired();
        if (permit.registrar != registrar || !hasRole(REGISTRAR_ROLE, registrar) || permit.authorizationEpoch != authorizationEpochs[registrar] ||
            !_validSignature(registrar, donationPermitHash(permit), signature)) revert InvalidAuthorization();
        _validateDonationFees(permit);

        usedDonationNonces[msg.sender][permit.nonce] = true;
        uint256 available = permit.amountWei - permit.gasReservedWei;
        _donationIds.push(permit.donationId);
        donations[permit.donationId] = Donation(msg.sender, permit.purpose, permit.projectId, permit.amountWei,
            permit.gasReservedWei, available, 0, permit.registrationHash, permit.feePolicyHash, _donationIds.length);
        totalDonatedWei += permit.amountWei;
        totalGasReservedWei += permit.gasReservedWei;
        totalAvailableWei += available;
        emit DonationReceived(permit.donationId, msg.sender, permit.purpose, permit.projectId, permit.amountWei,
            permit.gasReservedWei, permit.registrationHash, permit.feePolicyHash);
        _allocate(permit.donationId);
    }

    function cancelDonationNonce(uint256 nonce) external {
        if (usedDonationNonces[msg.sender][nonce]) revert NonceAlreadyUsed();
        usedDonationNonces[msg.sender][nonce] = true;
        emit DonationNonceCancelled(msg.sender, nonce);
    }

    function registerTask(bytes32 taskId, uint8 purpose, bytes32 projectId, uint8 urgency, uint256 targetWei)
        external onlyRole(TASK_OPERATOR_ROLE) whenNotPaused
    {
        if (taskId == bytes32(0)) revert InvalidId();
        if (tasks[taskId].id != bytes32(0)) revert DuplicateTask();
        if (purpose < 1 || purpose > 5) revert InvalidPurpose();
        if (projectId == bytes32(0)) revert InvalidProject();
        if (urgency < 1 || urgency > 3) revert InvalidUrgency();
        if (targetWei == 0) revert InvalidAmount();
        tasks[taskId] = Task(taskId, purpose, projectId, urgency, targetWei, 0, ++_taskSequence, false, false);
        emit TaskRegistered(taskId, purpose, projectId, urgency, targetWei);
        _setTaskActive(taskId, true);
    }

    function setTaskActive(bytes32 taskId, bool active) external onlyRole(TASK_OPERATOR_ROLE) whenNotPaused {
        _setTaskActive(taskId, active);
    }

    function allocateRemaining(bytes32 donationId) external nonReentrant whenNotPaused {
        Donation storage donation = donations[donationId];
        if (donation.donor == address(0)) revert UnknownDonation();
        if (msg.sender != donation.donor && !hasRole(ALLOCATOR_ROLE, msg.sender)) revert AllocationNotAuthorized();
        _allocate(donationId);
    }

    function refundUnallocated(bytes32 refundId, bytes32 donationId, uint256 amountWei)
        external nonReentrant whenNotPaused
    {
        if (refundId == bytes32(0)) revert InvalidId();
        if (refundIds[refundId]) revert DuplicateRefund();
        Donation storage donation = donations[donationId];
        if (donation.donor == address(0)) revert UnknownDonation();
        if (msg.sender != donation.donor) revert NotDonor();
        if (amountWei == 0 || amountWei > donation.availableWei) revert InvalidAmount();
        refundIds[refundId] = true;
        donation.availableWei -= amountWei;
        donation.refundedWei += amountWei;
        totalAvailableWei -= amountWei;
        totalRefundedWei += amountWei;
        emit DonationRefunded(refundId, donationId, msg.sender, amountWei);
        (bool success,) = payable(msg.sender).call{value: amountWei}("");
        if (!success) revert TransferFailed();
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }
    function donationCount() external view returns (uint256) { return _donationIds.length; }
    function donationIdAt(uint256 index) external view returns (bytes32) { return _donationIds[index]; }
    function activeTaskIds() external view returns (bytes32[MAX_ACTIVE_TASKS] memory) { return _activeTaskIds; }

    /// @notice Actual balance can be larger after a forced transfer. Such surplus
    /// is not a registered donation and cannot be allocated or refunded here.
    function accountedBalanceWei() public view virtual returns (uint256) { return totalDonatedWei - totalRefundedWei; }

    function _setTaskActive(bytes32 taskId, bool active) internal {
        Task storage task = tasks[taskId];
        if (task.id == bytes32(0)) revert UnknownTask();
        if (task.closed) revert TaskClosed();
        if (task.active == active) return;
        for (uint256 i; i < MAX_ACTIVE_TASKS; ++i) {
            if ((active && _activeTaskIds[i] == bytes32(0)) || (!active && _activeTaskIds[i] == taskId)) {
                _activeTaskIds[i] = active ? taskId : bytes32(0);
                task.active = active;
                emit TaskActivityChanged(taskId, active);
                return;
            }
        }
        revert ActiveTaskLimitReached();
    }

    function _allocate(bytes32 donationId) internal {
        Donation storage donation = donations[donationId];
        uint256 remaining = donation.availableWei;
        // The active window is bounded. Priority uses registration sequence, not
        // reusable slot order, so pausing/reactivating cannot jump a priority tie.
        for (uint256 n; n < MAX_ACTIVE_TASKS && remaining > 0; ++n) {
            bytes32 best;
            for (uint256 i; i < MAX_ACTIVE_TASKS; ++i) {
                bytes32 taskId = _activeTaskIds[i];
                if (taskId == bytes32(0)) continue;
                Task storage candidate = tasks[taskId];
                if (!candidate.active || candidate.closed || candidate.allocatedWei >= candidate.targetWei ||
                    (donation.purpose != 0 && donation.purpose != candidate.purpose) ||
                    (donation.projectId != bytes32(0) && donation.projectId != candidate.projectId)) continue;
                if (best == bytes32(0) || candidate.urgency > tasks[best].urgency ||
                    (candidate.urgency == tasks[best].urgency && candidate.sequence < tasks[best].sequence)) best = taskId;
            }
            if (best == bytes32(0)) break;
            Task storage selected = tasks[best];
            uint256 needed = selected.targetWei - selected.allocatedWei;
            uint256 amount = remaining < needed ? remaining : needed;
            selected.allocatedWei += amount;
            allocationWei[best][donationId] += amount;
            remaining -= amount;
            emit DonationAllocated(donationId, best, amount);
        }
        uint256 moved = donation.availableWei - remaining;
        donation.availableWei = remaining;
        totalAvailableWei -= moved;
        totalAllocatedWei += moved;
    }

    function _revokeRole(bytes32 role, address account) internal virtual override returns (bool) {
        bool removed = super._revokeRole(role, account);
        if (removed && role == REGISTRAR_ROLE) emit AuthorizationEpochChanged(account, ++authorizationEpochs[account]);
        return removed;
    }

    function _validSignature(address signer, bytes32 digest, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(digest, signature);
            return error == ECDSA.RecoverError.NoError && recovered == signer;
        }
        // Keep the standard ERC-1271 check without the Cancun-only MCOPY used by
        // SignatureChecker 5.6; local and deployment builds share the Paris target.
        (bool success, bytes memory result) = signer.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        return success && result.length >= 32 && abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector);
    }

    // No default zero-fee or unlimited-reimbursement policy. This unresolved hook
    // keeps the base abstract until the user-approved policy is implemented.
    function _validateDonationFees(DonationPermit calldata permit) internal view virtual;

    receive() external payable { revert DirectPaymentUnsupported(); }
    fallback() external payable { revert DirectPaymentUnsupported(); }
}
