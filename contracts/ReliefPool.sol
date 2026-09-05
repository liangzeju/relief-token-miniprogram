// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Native MON escrow. Identifiers must contain no personal information.
contract ReliefPool is Ownable, ReentrancyGuard {
    struct Task {
        bytes32 id;
        uint8 purpose;
        uint8 urgency;
        uint256 targetWei;
        uint256 allocatedWei;
        uint256 releasedWei;
        address recipient;
        bool active;
    }

    struct Donation {
        address donor;
        uint8 purpose;
        uint256 amountWei;
        uint256 unallocatedWei;
    }

    uint256 public constant MAX_TASKS = 32;
    Task[] private _tasks;
    mapping(bytes32 => uint256) private _taskIndexPlusOne;
    mapping(bytes32 => Donation) public donations;
    uint256 public totalDonatedWei;
    uint256 public totalAllocatedWei;
    uint256 public totalReleasedWei;
    uint256 public totalRefundedWei;

    error InvalidId();
    error InvalidPurpose();
    error InvalidUrgency();
    error InvalidRecipient();
    error TaskLimitReached();
    error UnknownTask();
    error TargetBelowAllocated();
    error RecipientLocked();
    error DuplicateDonation();
    error UnknownDonation();
    error InvalidAmount();
    error NotDonor();
    error TransferFailed();
    error DirectPaymentUnsupported();

    event DonationReceived(bytes32 indexed donationId, address indexed donor, uint8 purpose, uint256 amountWei);
    event DonationAllocated(bytes32 indexed donationId, bytes32 indexed taskId, uint256 amountWei);
    event DonationUnallocated(bytes32 indexed donationId, uint256 amountWei);
    event TaskReleased(bytes32 indexed taskId, address indexed recipient, uint256 amountWei);
    event DonationRefunded(bytes32 indexed donationId, address indexed donor, uint256 amountWei);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function configureTask(
        bytes32 taskId,
        uint8 purpose,
        uint8 urgency,
        uint256 targetWei,
        address recipient,
        bool active
    ) external onlyOwner {
        if (taskId == bytes32(0)) revert InvalidId();
        if (purpose < 1 || purpose > 5) revert InvalidPurpose();
        if (urgency < 1 || urgency > 3) revert InvalidUrgency();
        if (recipient == address(0)) revert InvalidRecipient();
        uint256 indexPlusOne = _taskIndexPlusOne[taskId];
        if (indexPlusOne == 0) {
            if (_tasks.length == MAX_TASKS) revert TaskLimitReached();
            _tasks.push(Task(taskId, purpose, urgency, targetWei, 0, 0, recipient, active));
            _taskIndexPlusOne[taskId] = _tasks.length;
        } else {
            Task storage task = _tasks[indexPlusOne - 1];
            if (targetWei < task.allocatedWei) revert TargetBelowAllocated();
            if (task.allocatedWei > 0 && recipient != task.recipient) revert RecipientLocked();
            task.purpose = purpose;
            task.urgency = urgency;
            task.targetWei = targetWei;
            task.recipient = recipient;
            task.active = active;
        }
    }

    function getTasks() external view returns (Task[] memory) {
        return _tasks;
    }

    function donate(bytes32 donationId, uint8 purpose) external payable nonReentrant {
        if (donationId == bytes32(0)) revert InvalidId();
        if (purpose > 5) revert InvalidPurpose();
        if (msg.value == 0) revert InvalidAmount();
        if (donations[donationId].donor != address(0)) revert DuplicateDonation();
        donations[donationId] = Donation(msg.sender, purpose, msg.value, msg.value);
        totalDonatedWei += msg.value;
        emit DonationReceived(donationId, msg.sender, purpose, msg.value);
        _allocate(donationId);
        uint256 remaining = donations[donationId].unallocatedWei;
        if (remaining > 0) emit DonationUnallocated(donationId, remaining);
    }

    function allocateRemaining(bytes32 donationId) external nonReentrant {
        if (donations[donationId].donor == address(0)) revert UnknownDonation();
        _allocate(donationId);
    }

    function releaseTask(bytes32 taskId, uint256 amountWei) external onlyOwner nonReentrant {
        uint256 indexPlusOne = _taskIndexPlusOne[taskId];
        if (indexPlusOne == 0) revert UnknownTask();
        Task storage task = _tasks[indexPlusOne - 1];
        if (amountWei == 0 || amountWei > task.allocatedWei - task.releasedWei) revert InvalidAmount();
        task.releasedWei += amountWei;
        totalReleasedWei += amountWei;
        emit TaskReleased(taskId, task.recipient, amountWei);
        (bool success, ) = payable(task.recipient).call{value: amountWei}("");
        if (!success) revert TransferFailed();
    }

    function refundUnallocated(bytes32 donationId) external nonReentrant {
        Donation storage donation = donations[donationId];
        if (donation.donor == address(0)) revert UnknownDonation();
        if (msg.sender != donation.donor) revert NotDonor();
        uint256 amountWei = donation.unallocatedWei;
        if (amountWei == 0) revert InvalidAmount();
        donation.unallocatedWei = 0;
        totalRefundedWei += amountWei;
        emit DonationRefunded(donationId, msg.sender, amountWei);
        (bool success, ) = payable(msg.sender).call{value: amountWei}("");
        if (!success) revert TransferFailed();
    }

    function _allocate(bytes32 donationId) private {
        Donation storage donation = donations[donationId];
        uint256 remaining = donation.unallocatedWei;
        uint256 beforeAllocation = remaining;
        // Three stable passes preserve insertion order within each urgency level.
        for (uint8 urgency = 3; urgency > 0 && remaining > 0; --urgency) {
            for (uint256 i = 0; i < _tasks.length && remaining > 0; ++i) {
                Task storage task = _tasks[i];
                if (!task.active || task.urgency != urgency) continue;
                if (donation.purpose != 0 && task.purpose != donation.purpose) continue;
                uint256 budget = task.targetWei - task.allocatedWei;
                uint256 amount = remaining < budget ? remaining : budget;
                if (amount == 0) continue;
                task.allocatedWei += amount;
                remaining -= amount;
                emit DonationAllocated(donationId, task.id, amount);
            }
        }
        donation.unallocatedWei = remaining;
        totalAllocatedWei += beforeAllocation - remaining;
    }

    receive() external payable {
        revert DirectPaymentUnsupported();
    }

    fallback() external payable {
        revert DirectPaymentUnsupported();
    }
}
